import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies, getSession, supabaseUrl, userHeaders } from "@/lib/server/auth";
import { requestJson } from "@/lib/server/http";
import { TAX_YEAR } from "@/lib/foreign-tax";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  if (req.nextUrl.search) return NextResponse.json({error:"조회 조건을 확인해 주세요."},{status:400});
  try {
    const session=await getSession();
    if(!session) return NextResponse.json({error:"로그인이 필요합니다."},{status:401});
    const rows=await requestJson("Supabase",`${supabaseUrl()}/rest/v1/rpc/recorded_tax_summary`,{
      method:"POST",headers:userHeaders(session.accessToken),body:JSON.stringify({target_year:TAX_YEAR}),
    },{attempts:1});
    if(!Array.isArray(rows)) throw Error("invalid summary");
    const response=NextResponse.json({year:TAX_YEAR,rows},{headers:{"Cache-Control":"no-store"}});
    if(session.renewedTokens) applySessionCookies(response,session.renewedTokens);
    return response;
  } catch { return NextResponse.json({error:"매도 기록을 불러오지 못했습니다."},{status:502}); }
}
