import { NextResponse } from "next/server";
import { applySessionCookies, fetchUser, getSession, supabaseUrl, userHeaders } from "@/lib/server/auth";
import { requestJson } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const user = await fetchUser(session.accessToken);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const headers = userHeaders(session.accessToken);
    const [collections, deliveries, runs] = await Promise.all([
      "collection_status?select=market,company,stock_code,status,filing_count,checked_at,last_success_at&order=checked_at.desc&limit=200",
      "briefing_deliveries?select=status,filing_count,checked_at,last_sent_at&limit=1",
      "briefing_runs?select=status,checked_at,last_success_at&limit=1",
    ].map((path) => requestJson<unknown[]>("Supabase", `${supabaseUrl()}/rest/v1/${path}`, { headers }, { attempts: 1 })));
    const response = NextResponse.json({ collections, delivery: deliveries[0] ?? null, run: runs[0] ?? null, emailEnabled: user.briefingEmail });
    if (session.renewedTokens) applySessionCookies(response, session.renewedTokens);
    return response;
  } catch {
    return NextResponse.json({ error: "수집·메일 상태를 불러오지 못했습니다." }, { status: 502 });
  }
}
