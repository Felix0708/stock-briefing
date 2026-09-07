export type Quote = {
  code: string;
  name: string | null;
  price: number;
  changeRatio: number;
  currency: "KRW" | "USD" | "JPY";
  fetchedAt?: string;
};

type QuoteResult = {
  quotes: Record<string, Quote>;
  usdKrw: number | null;
  jpyKrw: number | null;
  asOf: string;
};

export async function loadPortfolioQuotes(codes: string[], needsUsd: boolean): Promise<QuoteResult> {
  const unique = [...new Set(codes)];
  const fx = [needsUsd || unique.some((code) => code.startsWith("US:")) ? "USD" : "",
    unique.some((code) => code.startsWith("JP:")) ? "JPY" : ""].filter(Boolean).join(",");
  const batches = [];
  for (let index = 0; index < unique.length; index += 30) batches.push(unique.slice(index, index + 30));
  if (!batches.length && fx) batches.push([]);
  const result: QuoteResult = { quotes: {}, usdKrw: null, jpyKrw: null, asOf: new Date().toISOString() };
  // Sequential batches bound upstream fan-out even when multiple accounts share many positions.
  for (const batch of batches) {
    const query = new URLSearchParams({ codes: batch.join(","), fx });
    const response = await fetch(`/api/quotes?${query}`, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error("시세 갱신에 실패했습니다. 이전 조회값이 있다면 유지됩니다.");
    const data = await response.json() as QuoteResult;
    Object.assign(result.quotes, data.quotes);
    result.usdKrw = data.usdKrw ?? result.usdKrw;
    result.jpyKrw = data.jpyKrw ?? result.jpyKrw;
    result.asOf = data.asOf;
  }
  return result;
}
