import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "../src/app/api/ask/route.ts";
import { requestJson } from "../src/lib/server/http.ts";
import { enforceAskRateLimit } from "../src/lib/server/rate-limit.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CONSOLE_ERROR = console.error;
const SECRET_MARKER = "test-secret-must-not-leak";
const UPSTASH_URL = "https://test-rate-limit.upstash.io";
const ALLOWED_RATE_LIMIT = [1, 6, 5, 0, 60_000];

function setValidEnvironment() {
  process.env.GEMINI_API_KEY = SECRET_MARKER;
  process.env.GEMINI_ANSWER_MODEL = "test-answer-model";
  process.env.EMBEDDING_MODEL = "test-embedding-model";
  process.env.EMBEDDING_DIM = "3";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SECRET_KEY = SECRET_MARKER;
  process.env.RAG_MATCH_COUNT = "8";
  process.env.RAG_MIN_SIMILARITY = "0.35";
  process.env.UPSTASH_REDIS_REST_URL = UPSTASH_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = SECRET_MARKER;
  process.env.RATE_LIMIT_IP_HASH_KEY = "test-ip-hmac-key-must-be-at-least-32";
  process.env.RATE_LIMIT_GLOBAL_RPM = "8";
  process.env.GEMINI_EMBEDDING_RPM_LIMIT = "80";
  process.env.GEMINI_EMBEDDING_DAILY_BUDGET = "800";
  process.env.GEMINI_ANSWER_RPM_LIMIT = "8";
  process.env.GEMINI_ANSWER_DAILY_BUDGET = "16";
  process.env.VERCEL = "1";
}

function askRequest(body, extraHeaders = {}) {
  return new Request("http://localhost/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function mockFetch(upstream, options = {}) {
  globalThis.fetch = async (url, init) => {
    if (String(url) === UPSTASH_URL) {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, `Bearer ${SECRET_MARKER}`);
      const command = JSON.parse(init.body);
      assert.equal(command[0], "EVAL");
      const keyCount = Number(command[2]);
      assert.ok(keyCount === 2 || keyCount === 4);
      assert.doesNotMatch(init.body, /203\.0\.113\.|test-secret|test-ip-hmac-key/);
      if (keyCount === 4) {
        options.onRateLimit?.(command);
        return Response.json({
          result: options.rateLimitResult ?? ALLOWED_RATE_LIMIT,
        });
      }
      options.onGeminiBudget?.(command);
      const configuredRpmLimit = Number(command.at(-2));
      const configuredDailyLimit = Number(command.at(-1));
      assert.ok(Number.isInteger(configuredRpmLimit) && configuredRpmLimit > 0);
      assert.ok(Number.isInteger(configuredDailyLimit) && configuredDailyLimit > 0);
      const result = typeof options.geminiBudgetResult === "function"
        ? options.geminiBudgetResult(command)
        : options.geminiBudgetResult ?? [
          1,
          configuredDailyLimit,
          configuredDailyLimit - 1,
          0,
          86_400_000,
        ];
      return Response.json({ result });
    }
    return upstream(url, init);
  };
}

test.beforeEach(() => {
  setValidEnvironment();
  console.error = () => {};
  mockFetch(async () => assert.fail("예상하지 않은 외부 요청입니다."));
});

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = ORIGINAL_FETCH;
  console.error = ORIGINAL_CONSOLE_ERROR;
});

test("잘못된 JSON과 질문 경계값을 400으로 거부한다", async () => {
  for (const body of [
    "{",
    {},
    { question: "   " },
    { question: "가".repeat(1_001) },
    { question: "정상 질문", company: 1234 },
    { question: "정상 질문", company: "가".repeat(101) },
  ]) {
    const response = await POST(askRequest(body));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json();
    assert.equal(payload.error.code, "INVALID_REQUEST");
  }
});

test("영속 제한 초과 시 외부 호출 없이 429와 표준 헤더를 반환한다", async () => {
  mockFetch(
    async () => assert.fail("제한된 요청은 Gemini나 Supabase를 호출하면 안 됩니다."),
    {
      rateLimitResult: [0, 8, 0, 1_501, 1_501],
      onRateLimit: (command) => assert.equal(command.at(-1), "8"),
    },
  );

  const response = await POST(
    askRequest(
      { question: "최근 공시를 알려줘" },
      { "x-vercel-forwarded-for": "203.0.113.10" },
    ),
  );
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.error.code, "RATE_LIMITED");
  assert.equal(payload.error.message, "요청이 많아 잠시 후 다시 시도해 주세요.");
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(response.headers.get("ratelimit-limit"), "8");
  assert.equal(response.headers.get("ratelimit-remaining"), "0");
  assert.equal(response.headers.get("ratelimit-reset"), "2");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Vercel이 보증한 IP만 정규화·HMAC 처리하고 전달 헤더 스푸핑을 무시한다", async () => {
  const keys = [];
  mockFetch(async () => assert.fail("rate limit 외 요청은 없어야 합니다."), {
    onRateLimit: (command) => keys.push(command.slice(3, 7)),
  });

  await enforceAskRateLimit(
    new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "0:0:0:0:0:0:0:1" },
    }),
    1_000,
  );
  await enforceAskRateLimit(
    new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "::1" },
    }),
    1_000,
  );
  await enforceAskRateLimit(
    new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "203.0.113.11" },
    }),
    1_000,
  );

  assert.deepEqual(keys[0], keys[1]);
  assert.notDeepEqual(keys[0], keys[2]);
  assert.equal(keys[0].length, 4);
  assert.ok(keys[0].every((key) => key.includes("{stock-briefing:ask}")));
  assert.match(keys[0][3], /:global:60000$/);

  process.env.VERCEL = "";
  await enforceAskRateLimit(
    new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "203.0.113.12" },
    }),
    1_000,
  );
  await enforceAskRateLimit(
    new Request("http://localhost", {
      headers: { "x-vercel-forwarded-for": "203.0.113.13" },
    }),
    1_000,
  );
  assert.deepEqual(keys[3], keys[4]);
});

test("rate limit 저장소 장애를 우회하지 않고 안전한 503으로 변환한다", async () => {
  globalThis.fetch = async () =>
    new Response(`invalid token: ${SECRET_MARKER}`, { status: 401 });

  const response = await POST(askRequest({ question: "최근 공시는?" }));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.match(body, /RATE_LIMIT_UNAVAILABLE/);
  assert.doesNotMatch(body, /invalid token|test-secret|stack/i);
});

test("rate limit 필수 설정 누락도 fail-closed 503으로 반환한다", async () => {
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  globalThis.fetch = async () =>
    assert.fail("rate limit 설정 오류 시 외부 요청을 보내면 안 됩니다.");

  const response = await POST(askRequest({ question: "최근 공시는?" }));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.match(body, /RATE_LIMIT_UNAVAILABLE/);
  assert.doesNotMatch(body, /UPSTASH|test-secret|stack/i);
});

test("확정 글로벌 상한 8 RPM을 넘는 설정을 fail-closed 503으로 거부한다", async () => {
  process.env.RATE_LIMIT_GLOBAL_RPM = "9";
  globalThis.fetch = async () =>
    assert.fail("잘못된 글로벌 상한이면 Upstash를 호출하면 안 됩니다.");

  const response = await POST(askRequest({ question: "최근 공시는?" }));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 503);
  assert.match(body, /RATE_LIMIT_UNAVAILABLE/);
  assert.doesNotMatch(body, /RATE_LIMIT_GLOBAL_RPM|stack/i);
});

test("Gemini 모델 RPM·일일 예산 초과 시 실제 외부 호출 전에 429로 차단한다", async () => {
  let budgetCalls = 0;
  mockFetch(
    async () => assert.fail("예산 초과 시 Gemini나 Supabase를 호출하면 안 됩니다."),
    {
      onGeminiBudget: () => {
        budgetCalls += 1;
      },
      geminiBudgetResult: [0, 800, 0, 3_001, 3_001],
    },
  );

  const response = await POST(askRequest({ question: "최근 공시는?" }));
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.error.code, "RATE_LIMITED");
  assert.equal(response.headers.get("ratelimit-limit"), "800");
  assert.equal(response.headers.get("retry-after"), "4");
  assert.equal(budgetCalls, 1);
});

test("Gemini RPM 초과를 2개 창의 원자 판정으로 외부 호출 전에 차단한다", async () => {
  let budgetCalls = 0;
  mockFetch(
    async () => assert.fail("RPM 초과 시 Gemini나 Supabase를 호출하면 안 됩니다."),
    {
      onGeminiBudget: (command) => {
        budgetCalls += 1;
        assert.equal(command[2], "2");
        assert.ok(command[3].endsWith(":embedding:60000"));
        assert.ok(command[4].endsWith(":embedding:86400000"));
        assert.ok(
          command.slice(3, 5).every((key) =>
            key.includes("{stock-briefing:gemini}")),
        );
        assert.equal(command.at(-2), "80");
        assert.equal(command.at(-1), "800");
      },
      geminiBudgetResult: [0, 80, 0, 1_501, 1_501],
    },
  );

  const response = await POST(askRequest({ question: "RPM 선차단" }));
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.error.code, "RATE_LIMITED");
  assert.equal(response.headers.get("ratelimit-limit"), "80");
  assert.equal(response.headers.get("retry-after"), "2");
  assert.equal(budgetCalls, 1);
});

test("Gemini 재시도마다 RPM·RPD를 실제 전송 직전에 차감한다", async () => {
  let attempts = 0;
  let budgetCalls = 0;
  mockFetch(
    async (url) => {
      assert.match(String(url), /:embedContent/);
      attempts += 1;
      return new Response("temporary", { status: 503 });
    },
    {
      onGeminiBudget: (command) => {
        budgetCalls += 1;
        assert.equal(command[2], "2");
        assert.equal(command.at(-2), "80");
        assert.equal(command.at(-1), "800");
      },
    },
  );

  const response = await POST(askRequest({ question: "재시도 예산" }));
  assert.equal(response.status, 502);
  assert.equal(attempts, 3);
  assert.equal(budgetCalls, 3);
});

test("company 앞뒤 공백을 제거해 Supabase RPC 필터로 전달한다", async () => {
  let calls = 0;
  mockFetch(async (url, init) => {
    calls += 1;
    if (String(url).includes(":embedContent")) {
      return Response.json({ embedding: { values: [0.1, 0.2, 0.3] } });
    }
    if (String(url).includes("/rpc/match_filings")) {
      const body = JSON.parse(init.body);
      assert.equal(body.filter_company, "삼성전자");
      assert.equal(body.match_count, 8);
      assert.equal(body.match_threshold, 0.35);
      return Response.json([]);
    }
    return assert.fail("검색 결과가 없으면 답변 모델을 호출하면 안 됩니다.");
  });

  const response = await POST(
    askRequest({ question: "최근 사업보고서는?", company: "  삼성전자  " }),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.sources, []);
  assert.equal(calls, 2);
  assert.equal(response.headers.get("ratelimit-remaining"), "5");
});

test("company는 trim 후 100자까지 허용하고 빈 값은 필터 없음으로 전달한다", async () => {
  const filters = [];
  mockFetch(async (url, init) => {
    if (String(url).includes(":embedContent")) {
      return Response.json({ embedding: { values: [0.1, 0.2, 0.3] } });
    }
    if (String(url).includes("/rpc/match_filings")) {
      filters.push(JSON.parse(init.body).filter_company);
      return Response.json([]);
    }
    return assert.fail("검색 결과가 없으면 답변 모델을 호출하면 안 됩니다.");
  });

  const exactBoundary = `  ${"가".repeat(100)}  `;
  assert.equal(
    (await POST(askRequest({ question: "경계값", company: exactBoundary }))).status,
    200,
  );
  assert.equal(
    (await POST(askRequest({ question: "빈 필터", company: "   " }))).status,
    200,
  );
  assert.deepEqual(filters, ["가".repeat(100), null]);
});

test("필수 설정 누락 시 값과 내부 정보 없이 500을 반환한다", async () => {
  delete process.env.GEMINI_API_KEY;
  mockFetch(async () => assert.fail("설정 오류 시 외부 요청을 보내면 안 됩니다."));

  const response = await POST(askRequest({ question: "최근 공시를 알려줘" }));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 500);
  assert.match(body, /CONFIGURATION_ERROR/);
  assert.doesNotMatch(body, /GEMINI_API_KEY|test-secret|stack/i);
});

test("모킹된 정상 연동에서 답변을 생성하고 동일 DART URL 출처를 제거한다", async () => {
  let calls = 0;
  const budgetLimits = [];
  mockFetch(async (url, init) => {
    calls += 1;
    if (String(url).includes(":embedContent")) {
      assert.equal(init.headers["x-goog-api-key"], SECRET_MARKER);
      return Response.json({ embedding: { values: [0.1, 0.2, 0.3] } });
    }

    if (String(url).includes("/rpc/match_filings")) {
      assert.equal(init.headers.apikey, SECRET_MARKER);
      assert.equal(init.headers.Authorization, `Bearer ${SECRET_MARKER}`);
      assert.equal(JSON.parse(init.body).match_threshold, 0.35);
      return Response.json([
        {
          company: "동구리전자",
          report_nm: "시설투자 결정",
          rcept_dt: "20260705",
          url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1",
          content: "1번 근거",
          similarity: 0.81,
        },
        {
          company: "동구리전자",
          report_nm: "표기가 달라도 같은 공시",
          rcept_dt: "20260704",
          url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1",
          content: "2번 근거",
          similarity: 0.92,
        },
        {
          company: "외부",
          report_nm: "허용하지 않는 링크",
          rcept_dt: "20260705",
          url: "https://attacker.example/filing",
          content: "제외되어야 하는 근거",
          similarity: 0.99,
        },
      ]);
    }

    assert.match(String(url), /:generateContent/);
    const requestBody = JSON.parse(init.body);
    const prompt = requestBody.contents[0].parts[0].text;
    assert.match(prompt, /1번 근거/);
    assert.match(prompt, /2번 근거/);
    assert.doesNotMatch(prompt, /제외되어야 하는 근거/);
    return Response.json({
      candidates: [{ content: { parts: [{ text: "공시 근거 답변입니다. [S1]" }] } }],
    });
  }, {
    onGeminiBudget: (command) => {
      budgetLimits.push({
        rpm: Number(command.at(-2)),
        daily: Number(command.at(-1)),
      });
    },
  });

  const response = await POST(askRequest({ question: "시설투자는?" }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.answer, "공시 근거 답변입니다. [S1]");
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].similarity, 0.92);
  assert.match(payload.sources[0].url, /^https:\/\/dart\.fss\.or\.kr\//);
  assert.equal(payload.meta.retrievedChunks, 2);
  assert.equal(calls, 3);
  assert.deepEqual(budgetLimits, [
    { rpm: 80, daily: 800 },
    { rpm: 8, daily: 16 },
  ]);
});

test("임계값 미달 결과는 답변 생성을 건너뛰고 빈 출처를 반환한다", async () => {
  let calls = 0;
  mockFetch(async (url) => {
    calls += 1;
    if (String(url).includes(":embedContent")) {
      return Response.json({ embedding: { values: [0.1, 0.2, 0.3] } });
    }
    if (String(url).includes("/rpc/match_filings")) {
      return Response.json([
        {
          company: "동구리전자",
          report_nm: "관련도 낮은 공시",
          rcept_dt: "20260705",
          url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=2",
          content: "낮은 관련도",
          similarity: 0.1,
        },
      ]);
    }
    return assert.fail("근거가 없으면 답변 모델을 호출하면 안 됩니다.");
  });

  const response = await POST(askRequest({ question: "무관한 질문" }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.sources, []);
  assert.equal(payload.meta.retrievedChunks, 0);
  assert.equal(calls, 2);
});

test("외부 인증 오류를 일반화하고 Secret과 외부 본문을 노출하지 않는다", async () => {
  mockFetch(async () =>
    new Response(`credential rejected: ${SECRET_MARKER}`, { status: 401 }));

  const response = await POST(askRequest({ question: "최근 공시를 알려줘" }));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 502);
  assert.match(body, /UPSTREAM_ERROR/);
  assert.doesNotMatch(body, /credential|test-secret|stack/i);
});

test("sb_secret 키는 JWT bearer로 보내지 않고 DB 임계값을 전달한다", async () => {
  process.env.SUPABASE_SECRET_KEY = "sb_secret_test-only";
  mockFetch(async (url, init) => {
    if (String(url).includes(":embedContent")) {
      return Response.json({ embedding: { values: [0.1, 0.2, 0.3] } });
    }
    if (String(url).includes("/rpc/match_filings")) {
      assert.equal(init.headers.apikey, "sb_secret_test-only");
      assert.equal(init.headers.Authorization, undefined);
      const body = JSON.parse(init.body);
      assert.equal(body.filter_company, null);
      assert.equal(body.match_threshold, 0.35);
      return Response.json([]);
    }
    return assert.fail("검색 결과가 없으면 답변 모델을 호출하면 안 됩니다.");
  });

  const response = await POST(askRequest({ question: "근거 없는 질문" }));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.sources, []);
});

test("외부 요청 타임아웃을 재시도 후 UpstreamError로 변환한다", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  };

  await assert.rejects(
    requestJson("Timeout Test", "https://example.invalid", {}, {
      attempts: 2,
      timeoutMs: 5,
    }),
    (error) => error?.name === "UpstreamError" && error?.service === "Timeout Test",
  );
  assert.equal(calls, 2);
});

test("Gemini 타임아웃을 재시도 후 안전한 502 API 응답으로 변환한다", async () => {
  let geminiCalls = 0;
  mockFetch(async (_url, init) => {
    geminiCalls += 1;
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });

  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    originalSetTimeout(callback, Math.min(delay, 5), ...args);
  try {
    const response = await POST(askRequest({ question: "타임아웃 응답 계약" }));
    const body = JSON.stringify(await response.json());

    assert.equal(response.status, 502);
    assert.match(body, /UPSTREAM_ERROR/);
    assert.doesNotMatch(body, /AbortError|aborted|stack|test-secret/i);
    assert.equal(geminiCalls, 3);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
