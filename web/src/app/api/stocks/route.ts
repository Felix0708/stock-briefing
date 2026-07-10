import { NextRequest, NextResponse } from "next/server";

import { lookupStocks, lookupWorldStocks } from "@/lib/server/stock-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 종목 자동완성: 이름·코드 일부를 입력하면 정식 종목명+코드 후보를 반환한다.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const query = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 30) {
    return NextResponse.json({ items: [] });
  }
  const market = req.nextUrl.searchParams.get("market");
  const items =
    market === "US" || market === "JP" ? await lookupWorldStocks(query) : await lookupStocks(query);
  return NextResponse.json({ items });
}
