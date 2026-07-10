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
      return NextResponse.json({ error: "이미 등록된 종목입니다." }, { status: 409 });
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

  return {
    stock_code: stockCode,
    stock_name: stockName,
    quantity,
    avg_price: avgPrice,
    market,
  };
}

export async function GET(): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return unauthorized();

    const rows = await restFetch<Holding[]>(
      session,
      "holdings?select=stock_code,stock_name,quantity,avg_price,market&order=created_at.asc",
      { method: "GET" },
    );
    return withSession(NextResponse.json({ holdings: rows }), session);
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

    // 보유 종목 수 상한 (남용 방지)
    const existing = await restFetch<{ stock_code: string }[]>(
      session,
      "holdings?select=stock_code",
      { method: "GET" },
    );
    const isUpdate = existing.some((row) => row.stock_code === holding.stock_code);
    if (!isUpdate && existing.length >= MAX_HOLDINGS) {
      return NextResponse.json(
        { error: `종목은 최대 ${MAX_HOLDINGS}개까지 등록할 수 있습니다.` },
        { status: 400 },
      );
    }

    // 같은 종목 재등록은 수량·단가 갱신으로 처리 (upsert)
    const rows = await restFetch<Holding[]>(
      session,
      "holdings?on_conflict=user_id,stock_code&select=stock_code,stock_name,quantity,avg_price,market",
      {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(holding),
      },
    );
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
    if (!CODE_PATTERN.test(code) && !US_CODE_PATTERN.test(code) && !JP_CODE_PATTERN.test(code)) {
      return NextResponse.json({ error: "종목코드를 확인해 주세요." }, { status: 400 });
    }

    await restFetch<undefined>(session, `holdings?stock_code=eq.${code}`, {
      method: "DELETE",
    });
    return withSession(NextResponse.json({ ok: true }), session);
  } catch (error) {
    return handleKnownError(error);
  }
}
