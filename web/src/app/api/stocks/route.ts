import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 종목 자동완성 (네이버 증권 검색 프록시).
// "skt", "삼전" 같은 별칭·초성으로도 정확한 종목명+코드를 찾아준다.
// 비공식 API라 두 엔드포인트를 차례로 시도하고, 형식이 달라도 견디게 파싱한다.

export type StockMatch = { code: string; name: string; market: string | null };

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { items: StockMatch[]; at: number }>();

const CODE_PATTERN = /^[0-9]{6}$/;

function pushMatch(list: StockMatch[], code: unknown, name: unknown, market: unknown): void {
  if (typeof code !== "string" || !CODE_PATTERN.test(code)) return;
  if (typeof name !== "string" || !name.trim()) return;
  if (list.some((item) => item.code === code)) return;
  list.push({
    code,
    name: name.trim(),
    market: typeof market === "string" ? market : null,
  });
}

// 어떤 형태의 응답이 와도 {code, name} 쌍을 최대한 건져낸다.
function extractMatches(data: unknown, list: StockMatch[]): void {
  if (!data) return;
  if (Array.isArray(data)) {
    // ["017670", "SK텔레콤", "KOSPI", ...] 형태의 배열
    if (
      data.length >= 2 &&
      typeof data[0] === "string" &&
      CODE_PATTERN.test(data[0]) &&
      typeof data[1] === "string"
    ) {
      pushMatch(list, data[0], data[1], data[2]);
      return;
    }
    data.forEach((item) => extractMatches(item, list));
    return;
  }
  if (typeof data === "object") {
    const row = data as Record<string, unknown>;
    // {code, name} 또는 {stockCode, stockName} 형태의 객체
    pushMatch(list, row.code ?? row.stockCode ?? row.itemCode, row.name ?? row.stockName ?? row.itemName, row.typeCode ?? row.market ?? row.category);
    Object.values(row).forEach((value) => {
      if (value && typeof value === "object") extractMatches(value, list);
    });
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 30) {
    return NextResponse.json({ items: [] });
  }

  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json({ items: cached.items });
  }

  const items: StockMatch[] = [];
  const encoded = encodeURIComponent(query);

  const primary = await fetchJson(
    `https://m.stock.naver.com/front-api/search/autoComplete?query=${encoded}&target=stock`,
  );
  extractMatches(primary, items);

  if (items.length === 0) {
    const fallback = await fetchJson(
      `https://ac.stock.naver.com/ac?q=${encoded}&target=stock&st=111&frm=stock`,
    );
    extractMatches(fallback, items);
  }

  const limited = items.slice(0, 8);
  cache.set(query, { items: limited, at: Date.now() });
  return NextResponse.json({ items: limited });
}
