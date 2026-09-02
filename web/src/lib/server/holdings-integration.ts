import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { ConfigurationError } from "./config";
import { UpstreamError } from "./http";

export type SyncedHolding = {
  market: "KR" | "US" | "JP";
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  account_type: "paper" | "live";
  broker: "KIWOOM" | "KIS";
};

const TOKEN_PREFIX = "sb_sync_";
const TOKEN_PATTERN = /^sb_sync_[A-Za-z0-9_-]{43}$/;
const CODE_PATTERNS = {
  KR: /^[0-9]{6}$/,
  US: /^[A-Z][A-Z0-9.-]{0,9}$/,
  JP: /^[0-9A-Z]{4,5}$/,
} as const;
const MAX_HOLDINGS = 50;
const ALLOWED_ROW_KEYS = new Set([
  "market", "stock_code", "stock_name", "quantity", "avg_price", "account_type", "broker",
]);

function serviceEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url) throw new ConfigurationError("필수 서버 환경변수 SUPABASE_URL가 없습니다.");
  if (!key) throw new ConfigurationError("필수 서버 환경변수 SUPABASE_SECRET_KEY가 없습니다.");
  try {
    const parsed = new URL(url);
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !local) throw new Error("insecure URL");
  } catch {
    throw new ConfigurationError("SUPABASE_URL은 HTTPS 주소여야 합니다.");
  }
  return { url, key };
}

function serviceHeaders(): Record<string, string> {
  const { key } = serviceEnv();
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

async function serviceRest<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${serviceEnv().url}/rest/v1/${path}`, {
      ...init,
      headers: { ...serviceHeaders(), ...(init.headers ?? {}) },
    });
  } catch {
    throw new UpstreamError("Supabase");
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[integration] PostgREST ${response.status}: ${detail.slice(0, 300)}`);
    throw new UpstreamError("Supabase", response.status);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function createIntegrationToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashIntegrationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isIntegrationToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function parseSnapshot(body: unknown): SyncedHolding[] | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "요청 본문은 holdings 배열을 포함한 객체여야 합니다.";
  }
  const root = body as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "holdings") || !Array.isArray(root.holdings)) {
    return "요청 본문에는 holdings 배열만 사용할 수 있습니다.";
  }
  if (root.holdings.length > MAX_HOLDINGS) return `종목은 최대 ${MAX_HOLDINGS}개까지 동기화할 수 있습니다.`;

  const result: SyncedHolding[] = [];
  const seen = new Set<string>();
  for (const value of root.holdings) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "보유종목 형식이 올바르지 않습니다.";
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some((key) => !ALLOWED_ROW_KEYS.has(key))) {
      return "보유종목에는 시장·코드·이름·수량·평단가·계정유형·증권사만 보낼 수 있습니다.";
    }

    const market = row.market;
    const rawCode = typeof row.stock_code === "string" ? row.stock_code.trim() : "";
    const stockCode = market === "KR" ? rawCode : rawCode.toUpperCase();
    const stockName = typeof row.stock_name === "string" ? row.stock_name.trim() : "";
    const quantity = Number(row.quantity);
    const avgPrice = Number(row.avg_price);
    const accountType = row.account_type;
    const broker = row.broker;

    if (market !== "KR" && market !== "US" && market !== "JP") return "market은 KR, US, JP 중 하나여야 합니다.";
    if (!CODE_PATTERNS[market].test(stockCode)) return `${market} 종목코드 형식이 올바르지 않습니다.`;
    if (!stockName || stockName.length > 50) return "종목명은 1~50자여야 합니다.";
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99_999_999_999_999) return "보유 수량이 올바르지 않습니다.";
    if (!Number.isFinite(avgPrice) || avgPrice <= 0 || avgPrice > 9_999_999_999_999_999) return "평균 단가가 올바르지 않습니다.";
    if (accountType !== "paper" && accountType !== "live") return "account_type은 paper 또는 live여야 합니다.";
    if (broker !== "KIWOOM" && broker !== "KIS") return "broker는 KIWOOM 또는 KIS여야 합니다.";

    const key = `${market}:${stockCode}:${accountType}:${broker}`;
    if (seen.has(key)) return "같은 증권사·시장·종목·계정유형이 중복되었습니다.";
    seen.add(key);
    result.push({
      market,
      stock_code: stockCode,
      stock_name: stockName,
      quantity,
      avg_price: avgPrice,
      account_type: accountType,
      broker,
    });
  }
  return result;
}

export async function getTokenStatus(userId: string): Promise<{ tokenHint: string; issuedAt: string } | null> {
  const rows = await serviceRest<{ token_hint: string; issued_at: string }[]>(
    `integration_tokens?user_id=eq.${encodeURIComponent(userId)}&select=token_hint,issued_at&limit=1`,
    { method: "GET" },
  );
  return rows[0] ? { tokenHint: rows[0].token_hint, issuedAt: rows[0].issued_at } : null;
}

export async function issueToken(userId: string): Promise<string> {
  const token = createIntegrationToken();
  await serviceRest(
    "integration_tokens?on_conflict=user_id",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        user_id: userId,
        token_hash: hashIntegrationToken(token),
        token_hint: token.slice(-6),
        issued_at: new Date().toISOString(),
      }),
    },
  );
  return token;
}

export async function revokeToken(userId: string): Promise<void> {
  await serviceRest(`integration_tokens?user_id=eq.${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export async function syncSnapshot(token: string, snapshot: SyncedHolding[]): Promise<number> {
  const rows = await serviceRest<{ user_id: string }[]>(
    `integration_tokens?token_hash=eq.${hashIntegrationToken(token)}&select=user_id&limit=1`,
    { method: "GET" },
  );
  const userId = rows[0]?.user_id;
  if (!userId) throw new UpstreamError("Integration token", 401);

  return serviceRest<number>("rpc/replace_synced_holdings", {
    method: "POST",
    body: JSON.stringify({ target_user_id: userId, snapshot }),
  });
}
