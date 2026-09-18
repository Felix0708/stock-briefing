import { NextRequest, NextResponse } from "next/server";
import { hashIntegrationToken, isIntegrationToken, serviceRest } from "@/lib/server/holdings-integration";
import { readEquityBody } from "@/lib/server/account-equity";
import { UpstreamError } from "@/lib/server/http";

export const dynamic = "force-dynamic";
const reply=(body:object,status:number)=>NextResponse.json(body,{status,headers:{"Cache-Control":"no-store"}});
export async function PUT(req:NextRequest) {
  const token=/^Bearer ([^\s]+)$/.exec(req.headers.get("authorization")??"")?.[1];
  if(!token||!isIntegrationToken(token)) return reply({error:"유효한 연동 토큰이 필요합니다."},401);
  try {
    const body=await readEquityBody(req) as {version:unknown;records:unknown[]};
    const keys=["broker","account_type","year","market","sell_count","missing_count","profit_loss","updated_at"];
    const seen=new Set<string>();
    if(!body||Object.keys(body).sort().join()!=="records,version"||body.version!==1||!Array.isArray(body.records)||body.records.length>4
      || !body.records.every((item)=>{
        if(!item||typeof item!=="object"||Array.isArray(item)) return false;
        const r=item as Record<string,unknown>,key=`${r.broker}:${r.year}:${r.market}`;
        if(seen.has(key)) return false; seen.add(key);
        return Object.keys(r).length===keys.length&&keys.every(k=>k in r)&&typeof r.broker==="string"&&["KIWOOM","KIS"].includes(r.broker)
          &&r.account_type==="live"&&typeof r.market==="string"&&["US","JP"].includes(r.market)&&Number.isInteger(r.year)&&Number(r.year)>=2020&&Number(r.year)<=2100
          &&[r.sell_count,r.missing_count].every(n=>Number.isInteger(n)&&Number(n)>=0&&Number(n)<=1000000)
          &&typeof r.profit_loss==="number"&&Number.isFinite(r.profit_loss)&&Math.abs(r.profit_loss)<=1e12&&(r.sell_count!==0||r.profit_loss===0)
          &&typeof r.updated_at==="string"&&/^\d{4}-\d\d-\d\dT/.test(r.updated_at)&&Number.isFinite(Date.parse(r.updated_at))&&Date.parse(r.updated_at)<=Date.now()+300000;
      })) return reply({error:"실계좌 매도 집계 형식을 확인해 주세요."},400);
    const synced=await serviceRest<number>("rpc/sync_recorded_tax",{method:"POST",body:JSON.stringify({token_hash:hashIntegrationToken(token),records:body.records})});
    if(!Number.isInteger(synced)||synced<0||synced>body.records.length) throw Error("invalid ack");
    return reply({ok:true,synced},200);
  } catch(error) {
    const status=error instanceof RangeError?413:error instanceof SyntaxError?400:error instanceof UpstreamError&&error.status===401?401:502;
    return reply({error:"매도 집계를 저장하지 못했습니다."},status);
  }
}
