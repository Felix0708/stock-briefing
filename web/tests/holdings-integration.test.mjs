import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import {
  DELETE as revokeTokenRoute,
  POST as issueTokenRoute,
} from "../src/app/api/integration-token/route.ts";
import {
  GET as authGet,
  POST as authPost,
} from "../src/app/api/auth/[action]/route.ts";
import { PUT as syncHoldingsRoute } from "../src/app/api/sync/holdings/route.ts";
import {
  createIntegrationToken,
  hashIntegrationToken,
  isIntegrationToken,
  parseSnapshot,
} from "../src/lib/server/holdings-integration.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;

function syncRequest(token, body) {
  return new NextRequest("http://localhost/api/sync/holdings", {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test.beforeEach(() => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SECRET_KEY = "test-service-role-key";
  globalThis.__testCookieJar = {
    get: (name) => (name === "sb-at" ? { value: "valid-access-token" } : undefined),
  };
  console.error = () => {};
});

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
  delete globalThis.__testCookieJar;
});

test("토큰은 충분한 난수 원문을 한 번 만들고 SHA-256 해시만 저장할 수 있다", () => {
  const first = createIntegrationToken();
  const second = createIntegrationToken();
  assert.ok(isIntegrationToken(first));
  assert.notEqual(first, second);
  assert.match(hashIntegrationToken(first), /^[0-9a-f]{64}$/);
  assert.equal(hashIntegrationToken(first), hashIntegrationToken(first));
  assert.doesNotMatch(hashIntegrationToken(first), /sb_sync_/);
});

test("발급·재발급은 원문이 아닌 새 해시로 교체하고 폐기는 본인 user_id만 사용한다", async () => {
  const writes = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth/v1/user")) {
      return Response.json({ id: "user-a", email: "a@example.com", user_metadata: {} });
    }
    writes.push({ url: String(url), init });
    return new Response(null, { status: init.method === "DELETE" ? 204 : 201 });
  };

  const firstResponse = await issueTokenRoute();
  const first = await firstResponse.json();
  const secondResponse = await issueTokenRoute();
  const second = await secondResponse.json();
  const revokeResponse = await revokeTokenRoute();

  assert.equal(firstResponse.status, 201);
  assert.equal(secondResponse.status, 201);
  assert.notEqual(first.token, second.token);
  const firstWrite = JSON.parse(writes[0].init.body);
  const secondWrite = JSON.parse(writes[1].init.body);
  assert.equal(firstWrite.user_id, "user-a");
  assert.equal(firstWrite.token_hash, hashIntegrationToken(first.token));
  assert.notEqual(firstWrite.token_hash, secondWrite.token_hash);
  assert.doesNotMatch(writes[0].init.body, new RegExp(first.token));
  assert.match(writes[2].url, /integration_tokens\?user_id=eq\.user-a$/);
  assert.equal(revokeResponse.status, 200);
});

test("잘못된 필드·중복·비정상 값은 DB 호출 전에 거부한다", async () => {
  const valid = {
    market: "KR", stock_code: "005930", stock_name: "삼성전자",
    quantity: 1, avg_price: 70000, account_type: "live",
  };
  for (const body of [
    { user_id: "victim", holdings: [] },
    { holdings: [{ ...valid, broker_api_key: "secret" }] },
    { holdings: [valid, { ...valid, quantity: 2 }] },
    { holdings: [{ ...valid, quantity: 0 }] },
    { holdings: [{ ...valid, account_type: "real" }] },
  ]) {
    assert.equal(typeof parseSnapshot(body), "string");
  }

  globalThis.fetch = async () => assert.fail("잘못된 입력은 Supabase를 호출하면 안 됩니다.");
  const response = await syncHoldingsRoute(syncRequest(createIntegrationToken(), {
    holdings: [{ ...valid, broker_password: "secret" }],
  }));
  assert.equal(response.status, 400);
});

test("사용자 ID는 토큰 해시 조회 결과에서만 파생하고 빈 전체 스냅샷도 원자 RPC로 전달한다", async () => {
  const token = createIntegrationToken();
  let rpcBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("integration_tokens?token_hash=eq.")) {
      assert.match(String(url), new RegExp(hashIntegrationToken(token)));
      return Response.json([{ user_id: "owner-from-token" }]);
    }
    assert.match(String(url), /rpc\/replace_synced_holdings$/);
    rpcBody = JSON.parse(init.body);
    return Response.json(0);
  };

  const response = await syncHoldingsRoute(syncRequest(token, { holdings: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual(rpcBody, { target_user_id: "owner-from-token", snapshot: [] });
  assert.deepEqual(await response.json(), { ok: true, synced: 0 });
});

test("폐기되었거나 모르는 토큰은 스냅샷 RPC 전에 401로 거부한다", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json([]);
  };
  const response = await syncHoldingsRoute(syncRequest(createIntegrationToken(), { holdings: [] }));
  assert.equal(response.status, 401);
  assert.equal(calls, 1);
});

test("공개 브리핑 동의는 행이 없으면 false이고 본인 설정 행만 upsert한다", async () => {
  let settingWrite;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth/v1/user")) {
      return Response.json({ id: "user-a", email: "a@example.com", user_metadata: {} });
    }
    if (init.method === "GET") return Response.json([]);
    settingWrite = JSON.parse(init.body);
    return Response.json([settingWrite]);
  };

  const me = await authGet(
    new NextRequest("http://localhost/api/auth/me"),
    { params: Promise.resolve({ action: "me" }) },
  );
  assert.equal((await me.json()).user.publicBriefingOptIn, false);

  const changed = await authPost(
    new NextRequest("http://localhost/api/auth/prefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_briefing_opt_in: true }),
    }),
    { params: Promise.resolve({ action: "prefs" }) },
  );
  assert.equal(changed.status, 200);
  assert.deepEqual(settingWrite, { user_id: "user-a", public_briefing_opt_in: true });
});
