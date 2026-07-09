import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 현재가 조회 (네이버 증권 비공식 API 프록시).
// - 로그인 없이도 호출 가능하지만 종목코드 검증 + 개수 제한 + 60초 캐시로 남용을 막는다.
// - 비공식 API라 형식이 바뀔 수 있어 2개 엔드포인트를 차례로 시도한다.

export type Quote = {
  code: string;
  name: string | null;
  price: number;        // 현재가 (원)
  changeRatio: number;  // 등락률 (%)
};

const CODE_PATTERN = /^[0-9]{6}$/;
const MAX_CODES = 30;
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 7_000;

const cache = new Map<string, { quote: Quote; at: number }>();

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = Number(value.replace(/,/g, ""));
  return Number.isFinite(cleaned) ? cleaned : null;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // 모바일 API가 UA 없는 요청을 거부하는 경우가 있어 명시한다.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36",
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchQuote(code: string): Promise<Quote | null> {
  // 1차: 모바일 종목 기본 정보
  const basic = (await fetchJson(`https://m.stock.naver.com/api/stock/${code}/basic`)) as
    | Record<string, unknown>
    | null;
  if (basic) {
    const price = parseNumber(basic.closePrice);
    if (price !== null) {
      return {
        code,
        name: typeof basic.stockName === "string" ? basic.stockName : null,
        price,
        changeRatio: parseNumber(basic.fluctuationsRatio) ?? 0,
      };
    }
  }

  // 2차: 폴링 API
  const polling = (await fetchJson(
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
  )) as { datas?: Record<string, unknown>[] } | null;
  const row = polling?.datas?.[0];
  if (row) {
    const price = parseNumber(row.closePrice);
    if (price !== null) {
      return {
        code,
        name: typeof row.stockName === "string" ? row.stockName : null,
        price,
        changeRatio: parseNumber(row.fluctuationsRatio) ?? 0,
      };
    }
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("codes") ?? "";
  const codes = [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))];

  if (codes.length === 0) {
    return NextResponse.json({ error: "codes 파라미터가 필요합니다." }, { status: 400 });
  }
  if (codes.length > MAX_CODES || !codes.every((code) => CODE_PATTERN.test(code))) {
    return NextResponse.json({ error: "종목코드 형식을 확인해 주세요." }, { status: 400 });
  }

  const now = Date.now();
  const results = await Promise.all(
    codes.map(async (code) => {
      const cached = cache.get(code);
      if (cached && now - cached.at < CACHE_TTL_MS) return cached.quote;

      const quote = await fetchQuote(code);
      if (quote) cache.set(code, { quote, at: now });
      return quote;
    }),
  );

  const quotes: Record<string, Quote> = {};
  results.forEach((quote) => {
    if (quote) quotes[quote.code] = quote;
  });

  return NextResponse.json({ quotes, asOf: new Date().toISOString() });
}
