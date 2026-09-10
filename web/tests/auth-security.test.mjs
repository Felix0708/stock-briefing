import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server";
import nextTesting from "next/experimental/testing/server.js";
import { config, proxy } from "../src/proxy.ts";
import { POST } from "../src/app/api/auth/[action]/route.ts";

const site = "https://portfolio.example.com";
const { unstable_doesMiddlewareMatch } = nextTesting;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
test.afterEach(() => { globalThis.fetch = originalFetch; process.env = { ...originalEnv }; });
const request = (path, method = "POST", headers = {}, body) => new NextRequest(site + path, {
  method, headers, body: body === undefined ? undefined : JSON.stringify(body),
});
const authRequest = (action, password = "AuditOnly123!") => POST(
  request(`/api/auth/${action}`, "POST", { Origin: site }, { email: "audit@example.com", password }),
  { params: Promise.resolve({ action }) },
);

test("all cookie mutation routes, including future API routes, require an exact Origin", async () => {
  const root = new URL("../src/app/api/", import.meta.url);
  const routes = (await readdir(root, { recursive: true })).filter(path => path.endsWith("route.ts"));
  for (const path of routes) {
    const source = await readFile(new URL(path, root), "utf8");
    const url = "/api/" + path.replace(/\/?route\.ts$/, "").replace("[action]", "login");
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url }), true, url);
    if (["/api/ask", "/api/sync/holdings", "/api/sync/account-equity"].includes(url)) continue;
    for (const [, method] of source.matchAll(/export async function (POST|PUT|PATCH|DELETE)\(/g)) {
      for (const origin of [undefined, "null", "https://untrusted.invalid", site + ".evil.com", "http://portfolio.example.com", site + "/"]) {
        const blocked = proxy(request(url, method, origin ? { Origin: origin } : {}));
        assert.equal(blocked.status, 403, `${method} ${url}: ${origin}`);
        assert.equal(blocked.headers.get("set-cookie"), null);
        assert.equal(blocked.headers.get("cache-control"), "no-store");
      }
      assert.equal(proxy(request(url, method, { Origin: site, "Sec-Fetch-Site": "same-origin" })).headers.get("x-middleware-next"), "1");
      assert.equal(proxy(request(url, method, { Origin: site, "Sec-Fetch-Site": "cross-site" })).status, 403);
    }
  }
  assert.equal(proxy(request("/api/future-private-route")).status, 403);
  const local = new NextRequest("http://127.0.0.1:3100/api/auth/login", { method: "POST", headers: { Host: "127.0.0.1:3100", Origin: "http://127.0.0.1:3100" } });
  assert.equal(proxy(local).headers.get("x-middleware-next"), "1");
  local.headers.set("Origin", "http://localhost:3100");
  assert.equal(proxy(local).status, 403);
  assert.equal(proxy(request("/api/auth/login", "POST", { Origin: "https://untrusted.invalid", "X-Forwarded-Host": "untrusted.invalid" })).status, 403);
  for (const [path, method] of [["/api/auth/me", "GET"], ["/api/ask", "POST"], ["/api/sync/holdings", "PUT"], ["/api/sync/account-equity", "PUT"]]) {
    assert.equal(proxy(request(path, method)).headers.get("x-middleware-next"), "1");
  }
});

test("cross-site text/plain login is blocked before authentication or cookies", async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error("Unexpected authentication"); };
  const req = request("/api/auth/login", "POST", { Origin: "https://untrusted.invalid", "Content-Type": "text/plain" }, {
    email: "audit@example.com", password: "AuditOnly123!", padding: "=",
  });
  const response = proxy(req);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(called, false);
});

test("signup sends only the padded hash-prefix query and rejects known leaked passwords", async () => {
  const password = "AuditOnly123!";
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, `https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    assert.equal(init.headers["Add-Padding"], "true");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.cache, "no-store");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(init).includes(password));
    assert.ok(!JSON.stringify(init).includes("audit@example.com"));
    return new Response(`${hash.slice(5)}:42\r\n${"0".repeat(35)}:0\r\n`);
  };
  const response = await authRequest("signup", password);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /유출/);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(calls, 1);
});

test("safe signup ignores zero-count padding and preserves the original Unicode password", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "sb_publishable_test";
  const password = "  검증용Password123!  ";
  const hash = createHash("sha1").update(password).digest("hex").toUpperCase();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("pwnedpasswords.com")) return new Response(`${hash.slice(5)}:0\r\n${"F".repeat(35)}:5`);
    assert.equal(url, "https://example.supabase.co/auth/v1/signup");
    assert.equal(JSON.parse(init.body).password, password);
    return Response.json({ id: "new-user" });
  };
  const response = await authRequest("signup", password);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).needsEmailConfirm, true);
  assert.deepEqual(calls, [`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, "https://example.supabase.co/auth/v1/signup"]);
});

test("screening failures stop signup without leaking error details; login remains available", async () => {
  for (const result of [new Response("", { status: 503 }), new Response(""), new Response("malformed"), new Error("Sensitive upstream detail"), new DOMException("Timed out", "TimeoutError")]) {
    globalThis.fetch = async () => { if (result instanceof Error) throw result; return result; };
    const response = await authRequest("signup");
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /잠시 후/);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "sb_publishable_test";
  globalThis.fetch = async url => {
    assert.equal(url, "https://example.supabase.co/auth/v1/token?grant_type=password");
    return Response.json({ access_token: "test-access", refresh_token: "test-refresh", expires_in: 3600 });
  };
  const response = await authRequest("login");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
});
