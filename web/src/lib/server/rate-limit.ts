import "server-only";

import { createHmac, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { ConfigurationError } from "./config";

const UPSTASH_TIMEOUT_MS = 2_000;
const WINDOWS = [
  { limit: 6, durationMs: 60_000 },
  { limit: 60, durationMs: 60 * 60_000 },
  { limit: 200, durationMs: 24 * 60 * 60_000 },
] as const;
const RPM_WINDOW_MS = 60_000;
const DAILY_WINDOW_MS = 24 * 60 * 60_000;

// 모든 창을 한 번에 검사하고 허용된 요청만 기록한다. Upstash의 EVAL은
// 스크립트 전체를 원자적으로 실행하므로 동시 요청도 한도를 초과해 통과하지 않는다.
const SLIDING_WINDOW_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local selected = 1
local selected_remaining = nil
local blocked = nil
local blocked_retry = 0
local counts = {}
local durations = {60000, 3600000, 86400000, 60000}
local limits = {6, 60, 200, tonumber(ARGV[3])}

for i = 1, 4 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - durations[i])
  counts[i] = redis.call('ZCARD', KEYS[i])
  local remaining = limits[i] - counts[i]

  if selected_remaining == nil or remaining < selected_remaining then
    selected = i
    selected_remaining = remaining
  end

  if counts[i] >= limits[i] then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retry = durations[i]
    if oldest[2] ~= nil then
      retry = math.max(1, tonumber(oldest[2]) + durations[i] - now)
    end
    if blocked == nil or retry > blocked_retry then
      blocked = i
      blocked_retry = retry
    end
  end
end

if blocked ~= nil then
  return {0, limits[blocked], 0, blocked_retry, blocked_retry}
end

local selected_reset = durations[selected]
for i = 1, 4 do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], durations[i])
  counts[i] = counts[i] + 1

  local remaining = limits[i] - counts[i]
  if remaining < selected_remaining then
    selected = i
    selected_remaining = remaining
  end
end

local oldest = redis.call('ZRANGE', KEYS[selected], 0, 0, 'WITHSCORES')
if oldest[2] ~= nil then
  selected_reset = math.max(1, tonumber(oldest[2]) + durations[selected] - now)
end

return {1, limits[selected], math.max(0, selected_remaining), 0, selected_reset}
`;

// 모델별 RPM과 RPD 창을 한 스크립트에서 먼저 모두 판정한 뒤, 허용된
// 실제 외부 호출 시도만 두 창에 함께 기록한다.
const GEMINI_QUOTA_SCRIPT = `
local now = tonumber(ARGV[1])
local member = ARGV[2]
local durations = {60000, 86400000}
local limits = {tonumber(ARGV[3]), tonumber(ARGV[4])}
local counts = {}
local selected = 1
local selected_remaining = nil
local blocked = nil
local blocked_retry = 0

for i = 1, 2 do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - durations[i])
  counts[i] = redis.call('ZCARD', KEYS[i])
  local remaining = limits[i] - counts[i]

  if selected_remaining == nil or remaining < selected_remaining then
    selected = i
    selected_remaining = remaining
  end

  if counts[i] >= limits[i] then
    local oldest = redis.call('ZRANGE', KEYS[i], 0, 0, 'WITHSCORES')
    local retry = durations[i]
    if oldest[2] ~= nil then
      retry = math.max(1, tonumber(oldest[2]) + durations[i] - now)
    end
    if blocked == nil or retry > blocked_retry then
      blocked = i
      blocked_retry = retry
    end
  end
end

if blocked ~= nil then
  return {0, limits[blocked], 0, blocked_retry, blocked_retry}
end

local selected_reset = durations[selected]
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], durations[i])
  counts[i] = counts[i] + 1

  local remaining = limits[i] - counts[i]
  if remaining < selected_remaining then
    selected = i
    selected_remaining = remaining
  end
end

local oldest = redis.call('ZRANGE', KEYS[selected], 0, 0, 'WITHSCORES')
if oldest[2] ~= nil then
  selected_reset = math.max(1, tonumber(oldest[2]) + durations[selected] - now)
end

return {1, limits[selected], math.max(0, selected_remaining), 0, selected_reset}
`;

type RateLimitConfig = {
  url: string;
  token: string;
  ipHashKey: string;
  globalRpm: number;
  geminiEmbeddingRpmLimit: number;
  geminiEmbeddingDailyBudget: number;
  geminiAnswerRpmLimit: number;
  geminiAnswerDailyBudget: number;
};

export type GeminiBudget = "embedding" | "answer";

export type AskRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetAfterMs: number;
};

export class RateLimitServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitServiceError";
  }
}

export class RateLimitExceededError extends Error {
  constructor(public readonly result: AskRateLimitResult) {
    super("요청 한도를 초과했습니다.");
    this.name = "RateLimitExceededError";
  }
}

function positiveInteger(name: string, maximum?: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    const range = maximum ? `1~${maximum}` : "양의 정수";
    throw new ConfigurationError(`${name}은 ${range}여야 합니다.`);
  }
  return value;
}

function getRateLimitConfig(): RateLimitConfig {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const ipHashKey = process.env.RATE_LIMIT_IP_HASH_KEY?.trim();
  if (!url || !token || !ipHashKey) {
    throw new ConfigurationError(
      "Upstash 연결 정보와 RATE_LIMIT_IP_HASH_KEY가 필요합니다.",
    );
  }
  if (ipHashKey.length < 32) {
    throw new ConfigurationError("RATE_LIMIT_IP_HASH_KEY는 32자 이상이어야 합니다.");
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("invalid Upstash URL");
    }
  } catch {
    throw new ConfigurationError("UPSTASH_REDIS_REST_URL은 HTTPS 주소여야 합니다.");
  }

  return {
    url,
    token,
    ipHashKey,
    globalRpm: positiveInteger("RATE_LIMIT_GLOBAL_RPM", 8),
    geminiEmbeddingRpmLimit: positiveInteger("GEMINI_EMBEDDING_RPM_LIMIT"),
    geminiEmbeddingDailyBudget: positiveInteger(
      "GEMINI_EMBEDDING_DAILY_BUDGET",
    ),
    geminiAnswerRpmLimit: positiveInteger("GEMINI_ANSWER_RPM_LIMIT"),
    geminiAnswerDailyBudget: positiveInteger("GEMINI_ANSWER_DAILY_BUDGET"),
  };
}

function normalizeIp(value: string | null): string | null {
  const candidate = value?.trim();
  if (!candidate || !isIP(candidate)) return null;
  if (isIP(candidate) === 6) {
    try {
      return new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return null;
    }
  }
  return candidate;
}

function clientIdentity(request: Request, ipHashKey: string): string {
  // Vercel은 이 헤더를 직접 설정한다. 로컬이나 다른 프록시 환경에서는 요청자가
  // 임의로 넣은 forwarded 헤더를 신뢰하지 않고 하나의 unidentified 버킷을 쓴다.
  const ip = process.env.VERCEL === "1"
    ? normalizeIp(request.headers.get("x-vercel-forwarded-for"))
    : null;
  return createHmac("sha256", ipHashKey)
    .update(ip ? `ip:${ip}` : "ip:unidentified")
    .digest("hex");
}

function parseResult(value: unknown): AskRateLimitResult {
  if (
    !Array.isArray(value) ||
    value.length !== 5 ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    throw new RateLimitServiceError("Upstash 응답 형식이 올바르지 않습니다.");
  }

  const [allowed, limit, remaining, retryAfterMs, resetAfterMs] = value;
  if (
    (allowed !== 0 && allowed !== 1) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    !Number.isInteger(remaining) ||
    remaining < 0 ||
    remaining > limit ||
    retryAfterMs < 0 ||
    resetAfterMs < 1 ||
    (allowed === 0 && retryAfterMs < 1) ||
    (allowed === 1 && retryAfterMs !== 0)
  ) {
    throw new RateLimitServiceError("Upstash 제한 결과가 유효하지 않습니다.");
  }

  return {
    allowed: allowed === 1,
    limit,
    remaining,
    retryAfterMs,
    resetAfterMs,
  };
}

async function executeScript(
  config: RateLimitConfig,
  script: string,
  keys: string[],
  args: string[],
): Promise<AskRateLimitResult> {
  const command = ["EVAL", script, String(keys.length), ...keys, ...args];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTASH_TIMEOUT_MS);
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
      cache: "no-store",
      signal: controller.signal,
    });

    const payload = (await response.json().catch(() => null)) as
      | { result?: unknown; error?: unknown }
      | null;
    if (!response.ok || !payload || payload.error !== undefined) {
      throw new RateLimitServiceError("Upstash 요청에 실패했습니다.");
    }
    return parseResult(payload.result);
  } catch (error) {
    if (error instanceof RateLimitServiceError) throw error;
    throw new RateLimitServiceError("Upstash에 연결할 수 없습니다.");
  } finally {
    clearTimeout(timeout);
  }
}

export async function enforceAskRateLimit(
  request: Request,
  nowMs = Date.now(),
): Promise<AskRateLimitResult> {
  const config = getRateLimitConfig();
  const identity = clientIdentity(request, config.ipHashKey);
  // 고정 hash tag로 IP 창과 글로벌 창을 Redis Cluster의 동일 슬롯에 배치한다.
  const keys = [
    ...WINDOWS.map(
      (window) =>
        `stock-briefing:ask:{stock-briefing:ask}:ip:${identity}:${window.durationMs}`,
    ),
    "stock-briefing:ask:{stock-briefing:ask}:global:60000",
  ];
  return executeScript(
    config,
    SLIDING_WINDOW_SCRIPT,
    keys,
    [String(nowMs), `${nowMs}:${randomUUID()}`, String(config.globalRpm)],
  );
}

export async function consumeGeminiBudget(
  budget: GeminiBudget,
  nowMs = Date.now(),
): Promise<void> {
  const config = getRateLimitConfig();
  const rpmLimit = budget === "embedding"
    ? config.geminiEmbeddingRpmLimit
    : config.geminiAnswerRpmLimit;
  const dailyLimit = budget === "embedding"
    ? config.geminiEmbeddingDailyBudget
    : config.geminiAnswerDailyBudget;
  const keys = [
    `stock-briefing:gemini:{stock-briefing:gemini}:${budget}:${RPM_WINDOW_MS}`,
    `stock-briefing:gemini:{stock-briefing:gemini}:${budget}:${DAILY_WINDOW_MS}`,
  ];
  const result = await executeScript(
    config,
    GEMINI_QUOTA_SCRIPT,
    keys,
    [
      String(nowMs),
      `${nowMs}:${randomUUID()}`,
      String(rpmLimit),
      String(dailyLimit),
    ],
  );
  if (!result.allowed) throw new RateLimitExceededError(result);
}

export function rateLimitHeaders(
  result: AskRateLimitResult,
  includeRetryAfter = false,
): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(Math.max(1, Math.ceil(result.resetAfterMs / 1_000))),
  };
  if (includeRetryAfter) {
    headers["Retry-After"] = String(
      Math.max(1, Math.ceil(result.retryAfterMs / 1_000)),
    );
  }
  return headers;
}
