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
import {
  DELETE as deleteHoldingRoute,
  GET as getHoldingsRoute,
  POST as postHoldingRoute,
} from "../src/app/api/holdings/route.ts";
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

const VALID_PERFORMANCE = {
  broker: "KIWOOM",
  account_type: "live",
  all: { count: 3, wins: 2, losses: 1, draws: 0, win_rate: 66.67 },
  month: { count: 1, wins: 1, losses: 0, draws: 0, win_rate: 100 },
  realized: {
    KRW: { count: 3, profit_loss: 125000, return_rate: 4.21 },
    USD: { count: 0, profit_loss: 0, return_rate: null },
  },
  excluded_full_exits: 1,
  updated_at: "2026-09-03T00:00:00Z",
};

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
    quantity: 1, avg_price: 70000, account_type: "live", broker: "KIWOOM",
  };
  for (const body of [
    { user_id: "victim", holdings: [], performance: [] },
    { holdings: [{ ...valid, broker_api_key: "secret" }], performance: [] },
    { holdings: [valid, { ...valid, quantity: 2 }], performance: [] },
    { holdings: [{ ...valid, quantity: 0 }], performance: [] },
    { holdings: [{ ...valid, account_type: "real" }], performance: [] },
    { holdings: [{ ...valid, broker: "kiwoom" }], performance: [] },
    { holdings: [{ ...valid, broker: "OTHER" }], performance: [] },
    { holdings: [], performance: [{ ...VALID_PERFORMANCE, raw_orders: [] }] },
    { holdings: [], performance: [VALID_PERFORMANCE, VALID_PERFORMANCE] },
    { holdings: [], performance: [{ ...VALID_PERFORMANCE, all: { ...VALID_PERFORMANCE.all, count: 4 } }] },
    { holdings: [], performance: [{ ...VALID_PERFORMANCE, updated_at: "today" }] },
  ]) {
    assert.equal(typeof parseSnapshot(body), "string");
  }

  globalThis.fetch = async () => assert.fail("잘못된 입력은 Supabase를 호출하면 안 됩니다.");
  const response = await syncHoldingsRoute(syncRequest(createIntegrationToken(), {
    holdings: [{ ...valid, broker_password: "secret" }], performance: [],
  }));
  assert.equal(response.status, 400);
});

test("같은 종목도 증권사별 행은 허용하고 같은 증권사 행만 중복 거부한다", () => {
  const kiwoom = {
    market: "KR", stock_code: "005930", stock_name: "삼성전자",
    quantity: 1, avg_price: 70000, account_type: "live", broker: "KIWOOM",
  };
  const parsed = parseSnapshot({ holdings: [kiwoom, { ...kiwoom, broker: "KIS" }], performance: [] });
  assert.notEqual(typeof parsed, "string");
  assert.deepEqual(parsed.holdings.map((row) => row.broker), ["KIWOOM", "KIS"]);
  assert.equal(typeof parseSnapshot({ holdings: [kiwoom, { ...kiwoom, quantity: 2 }], performance: [] }), "string");
});

test("성과 집계만 허용하고 승패 없는 무승부 성과의 null 승률을 유지한다", () => {
  const drawOnly = {
    ...VALID_PERFORMANCE,
    all: { count: 1, wins: 0, losses: 0, draws: 1, win_rate: null },
  };
  const parsed = parseSnapshot({ holdings: [], performance: [drawOnly] });
  assert.notEqual(typeof parsed, "string");
  assert.equal(parsed.performance[0].all.win_rate, null);
  assert.equal(typeof parseSnapshot({ holdings: [], performance: [{ ...drawOnly, all: { ...drawOnly.all, win_rate: 0 } }] }), "string");
  assert.equal(typeof parseSnapshot({ holdings: [], performance: [{ ...VALID_PERFORMANCE, executions: [] }] }), "string");
});

test("보유종목 조회가 broker를 요청하고 응답에 유지한다", async () => {
  globalThis.fetch = async (url) => {
    if (String(url).includes("trading_performance?")) {
      return Response.json([{ ...VALID_PERFORMANCE, all_count: 3 }]);
    }
    assert.match(String(url), /select=stock_code,stock_name,quantity,avg_price,market,source,account_type,broker/);
    return Response.json([{
      market: "KR", stock_code: "005930", stock_name: "삼성전자",
      quantity: 1, avg_price: 70000, source: "stock_trading",
      account_type: "paper", broker: "KIS",
    }]);
  };

  const response = await getHoldingsRoute();
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.holdings[0].broker, "KIS");
  assert.equal(payload.performance[0].all_count, 3);
});

test("직접 등록은 선택한 증권사를 저장하고 기존 미지정 행의 증권사를 바꿀 수 있다", async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "GET") {
      return Response.json([{ stock_code: "SE", market: "US", broker: "MANUAL" }]);
    }
    return Response.json([JSON.parse(init.body)]);
  };

  const response = await postHoldingRoute(new NextRequest("http://localhost/api/holdings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      market: "US",
      stock_code: "SE",
      stock_name: "씨 ADR",
      quantity: 12,
      avg_price: 115.45,
      broker: "MIRAE",
      previous_broker: "MANUAL",
    }),
  }));

  assert.equal(response.status, 200);
  assert.equal(calls[1].init.method, "PATCH");
  assert.match(calls[1].url, /source=eq\.manual/);
  assert.match(calls[1].url, /broker=eq\.MANUAL/);
  const written = JSON.parse(calls[1].init.body);
  assert.equal(written.source, "manual");
  assert.equal(written.account_type, "manual");
  assert.equal(written.broker, "MIRAE");
});

test("직접 등록 삭제는 같은 종목의 선택한 증권사 행만 대상으로 한다", async () => {
  let deletedUrl = "";
  globalThis.fetch = async (url, init = {}) => {
    deletedUrl = String(url);
    assert.equal(init.method, "DELETE");
    return new Response(null, { status: 204 });
  };

  const response = await deleteHoldingRoute(new NextRequest(
    "http://localhost/api/holdings?code=SE&market=US&broker=MIRAE",
    { method: "DELETE" },
  ));

  assert.equal(response.status, 200);
  assert.match(deletedUrl, /source=eq\.manual/);
  assert.match(deletedUrl, /account_type=eq\.manual/);
  assert.match(deletedUrl, /broker=eq\.MIRAE/);
});

test("직접 등록은 허용되지 않은 증권사를 DB 호출 전에 거부한다", async () => {
  globalThis.fetch = async () => assert.fail("잘못된 증권사는 Supabase를 호출하면 안 됩니다.");

  const response = await postHoldingRoute(new NextRequest("http://localhost/api/holdings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      market: "US",
      stock_code: "SE",
      stock_name: "씨 ADR",
      quantity: 12,
      avg_price: 115.45,
      broker: "UNKNOWN",
    }),
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

  const response = await syncHoldingsRoute(syncRequest(token, { holdings: [], performance: [] }));
  assert.equal(response.status, 200);
  assert.deepEqual(rpcBody, {
    target_user_id: "owner-from-token",
    snapshot: [],
    performance_snapshot: [],
  });
  assert.deepEqual(await response.json(), { ok: true, synced: 0 });
});

test("유효한 성과 스냅샷을 보유종목과 같은 RPC 호출에 전달한다", async () => {
  const token = createIntegrationToken();
  let rpcBody;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("integration_tokens?token_hash=eq.")) {
      return Response.json([{ user_id: "owner-from-token" }]);
    }
    rpcBody = JSON.parse(init.body);
    return Response.json(0);
  };

  const response = await syncHoldingsRoute(syncRequest(token, {
    holdings: [],
    performance: [VALID_PERFORMANCE],
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(rpcBody.performance_snapshot, [{
    ...VALID_PERFORMANCE,
    updated_at: "2026-09-03T00:00:00.000Z",
  }]);
});

test("폐기되었거나 모르는 토큰은 스냅샷 RPC 전에 401로 거부한다", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json([]);
  };
  const response = await syncHoldingsRoute(syncRequest(createIntegrationToken(), { holdings: [], performance: [] }));
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
