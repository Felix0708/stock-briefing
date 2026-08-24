import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { NextRequest } from "next/server";

import { POST } from "../src/app/api/collect/route.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;

function collectRequest() {
  return new NextRequest("http://localhost/api/collect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company: "삼성전자" }),
  });
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.GITHUB_DISPATCH_TOKEN = "test-github-token";
  process.env.GITHUB_REPO = "owner/repo";
  globalThis.__testCookieJar = {
    get: (name) => (name === "sb-at" ? { value: "invalid-access-token" } : undefined),
  };
});

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  delete globalThis.__testCookieJar;
});

test("유효하지 않은 쿠키 토큰은 외부 워크플로 실행 전에 거부하고 삭제한다", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    assert.match(String(url), /\/auth\/v1\/user$/);
    return new Response(null, { status: 401 });
  };

  const response = await POST(collectRequest());

  assert.equal(response.status, 401);
  assert.deepEqual(requests, ["https://example.supabase.co/auth/v1/user"]);
  assert.equal(response.cookies.get("sb-at")?.value, "");
  assert.equal(response.cookies.get("sb-rt")?.value, "");
});

test("인증 서버 장애는 세션을 삭제하거나 외부 워크플로를 실행하지 않는다", async () => {
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    assert.match(String(url), /\/auth\/v1\/user$/);
    return new Response(null, { status: 503 });
  };

  const response = await POST(collectRequest());

  assert.equal(response.status, 503);
  assert.deepEqual(requests, ["https://example.supabase.co/auth/v1/user"]);
  assert.deepEqual(response.cookies.getAll(), []);
});

test("workflow_dispatch 입력은 쉘 코드가 아닌 단일 환경변수 인자로 전달한다", async () => {
  const workflow = await readFile(
    new URL("../../.github/workflows/collect-company.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /TARGET_COMPANY: \$\{\{ inputs\.company \}\}/);
  assert.match(workflow, /--companies "\$TARGET_COMPANY"/);

  const hostile = '\"; exit 42; #';
  const result = spawnSync("/bin/bash", ["-c", 'printf "%s" "$TARGET_COMPANY"'], {
    encoding: "utf8",
    env: { ...process.env, TARGET_COMPANY: hostile },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, hostile);
});
