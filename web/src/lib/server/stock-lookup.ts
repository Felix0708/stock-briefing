import "server-only";

// 종목명 해석 (네이버 증권 검색).
// 자동완성(/api/stocks)과 수집 요청(/api/collect)이 공용으로 사용한다.
// "skt" 같은 입력을 정식 종목명("SK텔레콤")으로 바꿔 DART 매칭 실패를 막는 것이 목적.

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
    pushMatch(
      list,
      row.code ?? row.stockCode ?? row.itemCode,
      row.name ?? row.stockName ?? row.itemName,
      row.typeCode ?? row.market ?? row.category,
    );
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

export async function lookupStocks(query: string): Promise<StockMatch[]> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > 30) return [];

  const cached = cache.get(trimmed);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const items: StockMatch[] = [];
  const encoded = encodeURIComponent(trimmed);

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
  cache.set(trimmed, { items: limited, at: Date.now() });
  return limited;
}

// 수집 요청용: 입력을 정식 종목명으로 해석 (실패하면 원문 유지)
export async function resolveStockName(query: string): Promise<string> {
  const matches = await lookupStocks(query);
  return matches[0]?.name ?? query.trim();
}
