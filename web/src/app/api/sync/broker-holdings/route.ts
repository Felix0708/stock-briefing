import { NextRequest, NextResponse } from "next/server";
import { validBrokerSnapshots } from "@/lib/broker-holdings";
import { readEquityBody } from "@/lib/server/account-equity";
import { hashIntegrationToken, isIntegrationToken, serviceRest } from "@/lib/server/holdings-integration";
import { UpstreamError } from "@/lib/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: object,status:number) => NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function PUT(req:NextRequest) {
  const token = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if(!token || !isIntegrationToken(token)) return response({error:"유효한 연동 토큰이 필요합니다."},401);
  try {
    const body = await readEquityBody(req) as {version?:unknown;snapshots?:unknown};
    if(!body || Object.keys(body).sort().join()!=="snapshots,version" || body.version!==1 || !validBrokerSnapshots(body.snapshots))
      return response({error:"실계좌 잔고 형식을 확인해 주세요."},400);
    const synced = await serviceRest<number>("rpc/sync_broker_holdings",{method:"POST",body:JSON.stringify({token_hash:hashIntegrationToken(token),snapshots:body.snapshots})});
    if(!Number.isInteger(synced) || synced<0 || synced>body.snapshots.length) throw new UpstreamError("Supabase");
    return response({ok:true,synced},200);
  } catch(error) {
    const status=error instanceof RangeError ? 413 : error instanceof SyntaxError ? 400
      : error instanceof UpstreamError && [400,401,409].includes(error.status ?? 0) ? error.status! : 502;
    return response({error:"잔고 동기화 결과를 확인하지 못했습니다. 기존 정상 기록은 유지됩니다."},status);
  }
}
