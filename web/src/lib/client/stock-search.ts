"use client";

// 종목 자동완성 클라이언트 헬퍼 (공시 검색·포트폴리오 등록에서 공용)

export type StockSuggestion = { code: string; name: string; market: string | null };

export async function searchStocks(query: string): Promise<StockSuggestion[]> {
  const trimmed = query.trim();
  if (trimmed.length < 1) return [];
  try {
    const response = await fetch(`/api/stocks?q=${encodeURIComponent(trimmed)}`);
    if (!response.ok) return [];
    const data = (await response.json()) as { items?: StockSuggestion[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}
