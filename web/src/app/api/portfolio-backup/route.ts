import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies, fetchUser, getSession } from "@/lib/server/auth";
import { serviceRest } from "@/lib/server/holdings-integration";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const text=String(value ?? "");
  // Neutralize spreadsheet formulas, including those hidden behind whitespace.
  return `"${(/^[\s]*[=+@-]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? "'" : "")+text.replaceAll('"','""')}"`;
}

async function handle(req: NextRequest, writing: boolean): Promise<NextResponse> {
  try {
    const session=await getSession();
    const user=session ? await fetchUser(session.accessToken) : null;
    if (!session || !user) return NextResponse.json({error:"로그인이 필요합니다."},{status:401});
    let response: NextResponse;
    if (writing) {
      if (Number(req.headers.get("content-length"))>4_200_000) return NextResponse.json({error:"웹 복원은 2 MB 이하 파일을 사용해 주세요."},{status:413});
      const text=await req.text();
      if (new TextEncoder().encode(text).length>4_200_000) return NextResponse.json({error:"파일이 너무 큽니다."},{status:413});
      const body=JSON.parse(text);
      if (!body || Object.keys(body).length!==3 || typeof body.archive_text!=="string" || typeof body.apply!=="boolean"
        || typeof body.expected_fingerprint!=="string" || !/^[a-f0-9]{32}$/.test(body.expected_fingerprint)) return NextResponse.json({error:"복원 요청을 확인해 주세요."},{status:400});
      const result=await serviceRest("rpc/restore_portfolio",{method:"POST",body:JSON.stringify({owner_id:user.id,...body})});
      response=NextResponse.json(result);
    } else {
      const format=req.nextUrl.searchParams.get("format") ?? "json";
      if (!["json","holdings","trades"].includes(format)) return NextResponse.json({error:"파일 형식을 확인해 주세요."},{status:400});
      const archive=await serviceRest<string>("rpc/export_portfolio",{method:"POST",body:JSON.stringify({owner_id:user.id,previous:req.nextUrl.searchParams.get("previous")==="true"})});
      let content=archive;
      if (format!=="json") {
        const data=JSON.parse(archive).data;
        const columns=format==="holdings" ? ["market","stock_code","stock_name","broker","source","account_type","quantity","avg_price","updated_at"]
          : ["id","market","stock_code","stock_name","broker","side","quantity","price","traded_on","cost_basis","realized_profit_loss","quantity_after","avg_price_after","revision","cancelled"];
        const rows=data[format==="holdings" ? "holdings" : "manual_trades"] as Record<string,unknown>[];
        content="\uFEFF"+[columns,...rows.map(row=>columns.map(key=>row[key]))].map(row=>row.map(csvCell).join(",")).join("\r\n");
      }
      response=new NextResponse(content,{headers:{"Content-Type":format==="json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "Content-Disposition":`attachment; filename="stock-briefing-${format}-${new Date().toISOString().slice(0,10)}.${format==="json" ? "json" : "csv"}"`}});
    }
    response.headers.set("Cache-Control","no-store");
    if (session.renewedTokens) applySessionCookies(response,session.renewedTokens);
    return response;
  } catch (error) {
    const rejected=error instanceof SyntaxError || error instanceof UpstreamError && [400,409].includes(error.status ?? 0);
    return NextResponse.json({error:rejected ? "백업 형식·소유 계정·잔고 일치 여부를 확인해 주세요. 현재 데이터가 바뀌었다면 다시 미리보기를 해야 합니다. 저장 중 오류가 나면 기존 데이터는 유지됩니다." : "백업 작업 결과를 확인하지 못했습니다. 화면을 새로 조회해 주세요."},{status:rejected ? 400 : 502});
  }
}
export async function GET(req:NextRequest) {return handle(req,false);}
export async function POST(req:NextRequest) {return handle(req,true);}
