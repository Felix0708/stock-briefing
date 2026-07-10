import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 특정 종목의 공시가 DB(filings)에 인덱싱돼 있는지 확인.
// 온디맨드 수집 후 클라이언트가 "준비됐는지" 폴링하는 데 쓴다.

function secretHeaders(): Record<string, string> | null {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!url || !key) return null;
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  return headers;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const company = req.nextUrl.searchParams.get("company")?.trim() ?? "";
  if (!company || company.length > 50) {
    return NextResponse.json({ error: "company 파라미터를 확인해 주세요." }, { status: 400 });
  }

  const headers = secretHeaders();
  const url = process.env.SUPABASE_URL?.trim();
  if (!headers || !url) {
    return NextResponse.json({ error: "서버 설정이 없습니다." }, { status: 500 });
  }

  try {
    const response = await fetch(
      `${url}/rest/v1/filings?select=rcept_no&company=eq.${encodeURIComponent(company)}&limit=1`,
      { headers, cache: "no-store" },
    );
    if (!response.ok) {
      return NextResponse.json({ error: "조회에 실패했습니다." }, { status: 502 });
    }
    const rows = (await response.json()) as unknown[];
    return NextResponse.json({ company, covered: rows.length > 0 });
  } catch {
    return NextResponse.json({ error: "조회에 실패했습니다." }, { status: 502 });
  }
}
