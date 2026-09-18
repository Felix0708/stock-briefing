import { NextRequest, NextResponse } from "next/server";
import { ACCOUNT_STATUS_LABELS } from "@/lib/account-status";
import { isIso, readEquityBody, UUID } from "@/lib/server/account-equity";
import { hashIntegrationToken, isIntegrationToken, serviceRest } from "@/lib/server/holdings-integration";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const respond = (body: object, status: number) => NextResponse.json(body, {status, headers:{"Cache-Control":"no-store"}});

export async function PUT(req: NextRequest) {
  const token = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || !isIntegrationToken(token)) return respond({error:"유효한 연동 토큰이 필요합니다."},401);
  try {
    const body = await readEquityBody(req) as {version?: unknown; statuses?: unknown};
    if (!body || typeof body!=="object" || Object.keys(body).sort().join()!=="statuses,version" || body.version!==1
      || !Array.isArray(body.statuses) || body.statuses.length>20) return respond({error:"수집 상태 형식을 확인해 주세요."},400);
    const seen = new Set<string>();
    for (const row of body.statuses) {
      if (!row || typeof row!=="object" || Object.keys(row).sort().join()!=="account_ref,account_type,broker,checked_at,code"
        || typeof row.account_ref!=="string" || !UUID.test(row.account_ref) || row.account_ref!==row.account_ref.toLowerCase()
        || !["KIWOOM","KIS"].includes(row.broker) || !["paper","live"].includes(row.account_type)
        || typeof row.code!=="string" || !Object.hasOwn(ACCOUNT_STATUS_LABELS,row.code)
        || !isIso(row.checked_at) || Date.parse(row.checked_at)>Date.now()+300_000) return respond({error:"수집 상태 값을 확인해 주세요."},400);
      const key=`${row.account_ref}:${row.broker}:${row.account_type}`;
      if(seen.has(key)) return respond({error:"계좌 상태가 중복되었습니다."},400);
      seen.add(key);
    }
    const synced = await serviceRest<number>("rpc/sync_account_status", {method:"POST",body:JSON.stringify({token_hash:hashIntegrationToken(token),records:body.statuses})});
    if(!Number.isInteger(synced)||synced<0||synced>body.statuses.length) throw new UpstreamError("Supabase");
    return respond({ok:true,synced},200);
  } catch(error) {
    if(error instanceof RangeError) return respond({error:"요청이 너무 큽니다."},413);
    if(error instanceof SyntaxError) return respond({error:"JSON 형식을 확인해 주세요."},400);
    if(error instanceof UpstreamError && [400,401,409].includes(error.status ?? 0)) return respond({error:error.status === 409 ? "같은 확인 시각에 서로 다른 수집 상태가 있습니다. 송신 기록을 확인해 주세요." : "수집 상태 또는 연동 토큰을 확인해 주세요."},error.status!);
    return respond({error:"수집 상태를 저장하지 못했습니다."},502);
  }
}
