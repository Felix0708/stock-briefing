import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 현재가 조회 (네이버 증권 비공식 API 프록시).
// - 국내: codes=005930  /  미국: codes=US:AAPL  /  일본: codes=JP:7203
// - 해외 종목이 있으면 해당 환율(USD/KRW, JPY/KRW)도 함께 반환한다 (원화 환산용).
// - 비공식 API라 형식이 바뀔 수 있어 여러 엔드포인트를 차례로 시도한다.

export type Quote = {
  code: string;
  name: string | null;
  price: number;        // 현재가 (KR: 원, US: 달러, JP: 엔)
  changeRatio: number;  // 등락률 (%)
  currency: "KRW" | "USD" | "JPY";
};

const KR_CODE = /^[0-9]{6}$/;
const US_CODE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const JP_CODE = /^[0-9A-Z]{4,5}$/;
const MAX_CODES = 30;
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 7_000;

const cache = new Map<string, { quote: Quote; at: number }>();
// 해외 티커 → 네이버 거래소 접미사(.O 나스닥 / .K NYSE / .A AMEX / .T 도쿄) 매핑 캐시
const suffixCache = new Map<string, string>();
const fxCache = new Map<string, { rate: number; at: number }>();

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
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Safari/537.36",
        Accept: "application/json",
        Referer: "https://m.stock.naver.com/",
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

// 응답 어디에 있든 closePrice/stockName류 필드를 찾아낸다
function digQuoteFields(data: unknown): { price: number; name: string | null; ratio: number } | null {
  if (!data || typeof data !== "object") return null;
  const queue: Record<string, unknown>[] = [data as Record<string, unknown>];
  while (queue.length) {
    const row = queue.shift()!;
    const price = parseNumber(row.closePrice ?? row.tradePrice ?? row.last);
    if (price !== null && price > 0) {
      const name =
        typeof row.stockName === "string"
          ? row.stockName
          : typeof row.stockNameEng === "string"
            ? row.stockNameEng
            : null;
      const ratio =
        parseNumber(row.fluctuationsRatio ?? row.changeRate ?? row.fluctuationRatio) ?? 0;
      return { price, name, ratio };
    }
    for (const value of Object.values(row)) {
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item && typeof item === "object") queue.push(item as Record<string, unknown>);
        });
      } else if (value && typeof value === "object") {
        queue.push(value as Record<string, unknown>);
      }
    }
  }
  return null;
}

async function fetchKrQuote(code: string): Promise<Quote | null> {
  for (const url of [
    `https://m.stock.naver.com/api/stock/${code}/basic`,
    `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`,
  ]) {
    const fields = digQuoteFields(await fetchJson(url));
    if (fields) {
      return { code, name: fields.name, price: fields.price, changeRatio: fields.ratio, currency: "KRW" };
    }
  }
  return null;
}

async function fetchWorldQuote(
  ticker: string,
  suffixes: string[],
  currency: "USD" | "JPY",
): Promise<Quote | null> {
  const known = suffixCache.get(`${currency}:${ticker}`);
  const tryList = known ? [known] : suffixes;
  for (const suffix of tryList) {
    for (const url of [
      `https://api.stock.naver.com/stock/${ticker}${suffix}/basic`,
      `https://polling.finance.naver.com/api/realtime/worldstock/stock/${ticker}${suffix}`,
    ]) {
      const fields = digQuoteFields(await fetchJson(url));
      if (fields) {
        suffixCache.set(`${currency}:${ticker}`, suffix);
        return {
          code: ticker,
          name: fields.name,
          price: fields.price,
          changeRatio: fields.ratio,
          currency,
        };
      }
    }
  }
  return null;
}

// 환율 조회. JPY는 네이버가 "100엔당 원화"로 주므로 1엔 기준으로 나눈다.
async function fetchFxRate(reutersCode: string, min: number, max: number, per = 1): Promise<number | null> {
  const cached = fxCache.get(reutersCode);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.rate;
  for (const url of [
    `https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=${reutersCode}&page=1&pageSize=1`,
    `https://polling.finance.naver.com/api/realtime/marketindex/exchange/${reutersCode}`,
    `https://m.stock.naver.com/front-api/marketIndex/exchange/${reutersCode}/basic`,
  ]) {
    const fields = digQuoteFields(await fetchJson(url));
    // 범위 검증으로 엉뚱한 숫자 필드 오인 방지
    if (fields && fields.price > min && fields.price < max) {
      const rate = fields.price / per;
      fxCache.set(reutersCode, { rate, at: Date.now() });
      return rate;
    }
  }
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("codes") ?? "";
  const entries = [...new Set(raw.split(",").map((c) => c.trim()).filter(Boolean))];

  if (entries.length === 0) {
    return NextResponse.json({ error: "codes 파라미터가 필요합니다." }, { status: 400 });
  }
  if (entries.length > MAX_CODES) {
    return NextResponse.json({ error: "종목 수가 너무 많습니다." }, { status: 400 });
  }

  const parsed = entries.map((entry) => {
    const market = entry.startsWith("US:") ? "US" : entry.startsWith("JP:") ? "JP" : "KR";
    const code = market === "KR" ? entry : entry.slice(3).toUpperCase();
    return { key: entry, code, market };
  });
  for (const item of parsed) {
    const pattern = item.market === "US" ? US_CODE : item.market === "JP" ? JP_CODE : KR_CODE;
    if (!pattern.test(item.code)) {
      return NextResponse.json({ error: `종목코드 형식을 확인해 주세요: ${item.key}` }, { status: 400 });
    }
  }

  const now = Date.now();
  const hasUs = parsed.some((item) => item.market === "US");
  const hasJp = parsed.some((item) => item.market === "JP");

  const [results, usdKrw, jpyKrw] = await Promise.all([
    Promise.all(
      parsed.map(async (item) => {
        const cached = cache.get(item.key);
        if (cached && now - cached.at < CACHE_TTL_MS) return { key: item.key, quote: cached.quote };
        const quote =
          item.market === "US"
            ? await fetchWorldQuote(item.code, [".O", ".K", ".A"], "USD")
            : item.market === "JP"
              ? await fetchWorldQuote(item.code, [".T"], "JPY")
              : await fetchKrQuote(item.code);
        if (quote) cache.set(item.key, { quote, at: now });
        return { key: item.key, quote };
      }),
    ),
    hasUs ? fetchFxRate("FX_USDKRW", 900, 2500) : Promise.resolve(null),
    // JPY/KRW는 100엔당 원화(약 800~1500)로 제공됨 → 1엔 기준으로 환산
    hasJp ? fetchFxRate("FX_JPYKRW", 600, 1800, 100) : Promise.resolve(null),
  ]);

  const quotes: Record<string, Quote> = {};
  results.forEach(({ key, quote }) => {
    if (quote) quotes[key] = quote;
  });

  return NextResponse.json({
    quotes,
    usdKrw,
    jpyKrw,
    asOf: new Date().toISOString(),
  });
}
