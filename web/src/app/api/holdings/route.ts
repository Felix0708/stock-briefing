import { NextRequest, NextResponse } from "next/server";

import {
  applySessionCookies,
  getSession,
  supabaseUrl,
  userHeaders,
  type Session,
} from "@/lib/server/auth";
import { ConfigurationError } from "@/lib/server/config";
import { UpstreamError } from "@/lib/server/http";
import {
  isManualBroker,
  type HoldingBroker,
} from "@/lib/holding-brokers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 보유 종목 CRUD.
// 사용자 access token을 Bearer로 PostgREST에 전달한다 — RLS가 "자기 행만"을 강제하므로
// 서버 코드가 user_id를 다룰 필요가 없고, 실수로도 남의 데이터에 접근할 수 없다.

export type Holding = {
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  market: "KR" | "US" | "JP";
  source: "manual" | "stock_trading";
  account_type: "manual" | "paper" | "live";
  broker: HoldingBroker;
};

export type TradingPerformance = {
  broker: "KIWOOM" | "KIS";
  account_type: "paper" | "live";
  all_count: number;
  all_wins: number;
  all_losses: number;
  all_draws: number;
  all_win_rate: number | null;
  month_count: number;
  month_wins: number;
  month_losses: number;
  month_draws: number;
  month_win_rate: number | null;
  realized_krw_count: number;
  realized_krw_profit_loss: number;
  realized_krw_return_rate: number | null;
  realized_usd_count: number;
  realized_usd_profit_loss: number;
  realized_usd_return_rate: number | null;
  excluded_full_exits: number;
  updated_at: string;
};

const CODE_PATTERN = /^[0-9]{6}$/;
const US_CODE_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const JP_CODE_PATTERN = /^[0-9A-Z]{4,5}$/;
const MAX_HOLDINGS = 50;

function withSession(res: NextResponse, session: Session): NextResponse {
  if (session.renewedTokens) applySessionCookies(res, session.renewedTokens);
  return res;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
}

function handleKnownError(error: unknown): NextResponse {
  if (error instanceof ConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (error instanceof UpstreamError) {
    if (error.status === 401) return unauthorized();
    if (error.status === 409) {
      return NextResponse.json({ error: "같은 증권사에 이미 등록된 종목입니다." }, { status: 409 });
    }
    if (error.status === 404) {
      return NextResponse.json(
        { error: "holdings 테이블을 찾을 수 없습니다. db/schema_phase3.sql을 Supabase SQL Editor에서 실행했는지 확인해 주세요." },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: `데이터 서버 요청에 실패했습니다. (오류 ${error.status ?? "네트워크"}) ${error.message}` },
      { status: 502 },
    );
  }
  return NextResponse.json({ error: "요청 처리에 실패했습니다." }, { status: 500 });
}

async function restFetch<T>(
  session: Session,
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...init,
    headers: { ...userHeaders(session.accessToken), ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[holdings] PostgREST ${response.status}: ${detail.slice(0, 300)}`);
    throw new UpstreamError("Supabase", response.status, detail.slice(0, 200) || undefined);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function parseHolding(body: unknown): Holding | string {
  const row = (body ?? {}) as Record<string, unknown>;
  const market = row.market === "US" ? "US" : row.market === "JP" ? "JP" : "KR";
  const rawCode = typeof row.stock_code === "string" ? row.stock_code.trim() : "";
  const stockCode = market === "KR" ? rawCode : rawCode.toUpperCase();
  const stockName = typeof row.stock_name === "string" ? row.stock_name.trim() : "";
  const quantity = Number(row.quantity);
  const avgPrice = Number(row.avg_price);
  const broker = row.broker;

  if (market === "KR" && !CODE_PATTERN.test(stockCode)) {
    return "국내 종목코드는 숫자 6자리여야 합니다.";
  }
  if (market === "US" && !US_CODE_PATTERN.test(stockCode)) {
    return "미국 티커 형식을 확인해 주세요. (예: AAPL)";
  }
  if (market === "JP" && !JP_CODE_PATTERN.test(stockCode)) {
    return "일본 종목코드 형식을 확인해 주세요. (예: 7203)";
  }
  if (!stockName || stockName.length > 50) return "종목명을 확인해 주세요.";
  if (!Number.isFinite(quantity) || quantity <= 0) return "보유 수량을 확인해 주세요.";
  if (!Number.isFinite(avgPrice) || avgPrice <= 0) return "평균 단가를 확인해 주세요.";
  if (!isManualBroker(broker)) return "증권사를 선택해 주세요.";

  return {
    stock_code: stockCode,
    stock_name: stockName,
    quantity,
    avg_price: avgPrice,
    market,
    source: "manual",
    account_type: "manual",
    broker,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const [holdings, performance] = await Promise.all([
      restFetch<Holding[]>(
        session,
        "holdings?select=stock_code,stock_name,quantity,avg_price,market,source,account_type,broker&order=created_at.asc",
        { method: "GET" },
      ),
      restFetch<TradingPerformance[]>(
        session,
        "trading_performance?select=broker,account_type,all_count,all_wins,all_losses,all_draws,all_win_rate,month_count,month_wins,month_losses,month_draws,month_win_rate,realized_krw_count,realized_krw_profit_loss,realized_krw_return_rate,realized_usd_count,realized_usd_profit_loss,realized_usd_return_rate,excluded_full_exits,updated_at&order=broker.asc,account_type.asc",
        { method: "GET" },
      ),
    ]);
    return withSession(NextResponse.json({ holdings, performance }), session);
  } catch (error) {
    return handleKnownError(error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
    }
    const holding = parseHolding(body);
    if (typeof holding === "string") {
      return NextResponse.json({ error: holding }, { status: 400 });
    }
    const row = body as Record<string, unknown>;
    const previousBroker = row.previous_broker;
    if (
      previousBroker !== undefined
      && previousBroker !== "MANUAL"
      && !isManualBroker(previousBroker)
    ) {
      return NextResponse.json({ error: "기존 증권사 정보가 올바르지 않습니다." }, { status: 400 });
    }

    // 보유 종목 수 상한 (남용 방지)
    const existing = await restFetch<{
      stock_code: string;
      market: Holding["market"];
      broker: HoldingBroker;
    }[]>(
      session,
      "holdings?select=stock_code,market,broker&source=eq.manual",
      { method: "GET" },
    );
    const isUpdate = existing.some(
      (existingRow) => existingRow.stock_code === holding.stock_code
        && existingRow.market === holding.market
        && (existingRow.broker === holding.broker || existingRow.broker === previousBroker),
    );
    if (!isUpdate && existing.length >= MAX_HOLDINGS) {
      return NextResponse.json(
        { error: `종목은 최대 ${MAX_HOLDINGS}개까지 등록할 수 있습니다.` },
        { status: 400 },
      );
    }

    const movingBroker = typeof previousBroker === "string" && previousBroker !== holding.broker;
    const rows = movingBroker
      ? await restFetch<Holding[]>(
        session,
        `holdings?stock_code=eq.${encodeURIComponent(holding.stock_code)}&market=eq.${holding.market}&source=eq.manual&account_type=eq.manual&broker=eq.${encodeURIComponent(previousBroker)}&select=stock_code,stock_name,quantity,avg_price,market,source,account_type,broker`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify(holding),
        },
      )
      : await restFetch<Holding[]>(
        session,
        "holdings?on_conflict=user_id,source,market,stock_code,account_type,broker&select=stock_code,stock_name,quantity,avg_price,market,source,account_type,broker",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify(holding),
        },
      );
    if (movingBroker && rows.length === 0) {
      return NextResponse.json({ error: "수정할 직접 등록 종목을 찾지 못했습니다." }, { status: 404 });
    }
    return withSession(NextResponse.json({ ok: true, holding: rows[0] ?? holding }), session);
  } catch (error) {
    return handleKnownError(error);
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const code = req.nextUrl.searchParams.get("code")?.trim().toUpperCase() ?? "";
    const market = req.nextUrl.searchParams.get("market")?.trim().toUpperCase() ?? "";
    const broker = req.nextUrl.searchParams.get("broker")?.trim().toUpperCase() ?? "";
    if (!CODE_PATTERN.test(code) && !US_CODE_PATTERN.test(code) && !JP_CODE_PATTERN.test(code)) {
      return NextResponse.json({ error: "종목코드를 확인해 주세요." }, { status: 400 });
    }

    if (market !== "KR" && market !== "US" && market !== "JP") {
      return NextResponse.json({ error: "시장을 확인해 주세요." }, { status: 400 });
    }
    if (broker !== "MANUAL" && !isManualBroker(broker)) {
      return NextResponse.json({ error: "증권사를 확인해 주세요." }, { status: 400 });
    }

    await restFetch<undefined>(
      session,
      `holdings?stock_code=eq.${encodeURIComponent(code)}&market=eq.${market}&source=eq.manual&account_type=eq.manual&broker=eq.${encodeURIComponent(broker)}`,
      {
      method: "DELETE",
      },
    );
    return withSession(NextResponse.json({ ok: true }), session);
  } catch (error) {
    return handleKnownError(error);
  }
}
