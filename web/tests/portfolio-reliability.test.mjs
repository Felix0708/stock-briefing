import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { loadPortfolioQuotes } from "../src/lib/client/portfolio-quotes.ts";
import { GET as quotes } from "../src/app/api/quotes/route.ts";
import { POST as trade, PATCH as correct } from "../src/app/api/manual-trades/route.ts";
import { GET as backup, POST as restore } from "../src/app/api/portfolio-backup/route.ts";
import { DELETE as deleteHolding } from "../src/app/api/holdings/route.ts";

const originalFetch=globalThis.fetch;
const originalEnv={...process.env};
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnv};delete globalThis.__testCookieJar;});

test("100개 시세를 30개 단위로 조회하고 중복 계좌 티커는 한 번만 요청한다",async()=>{
  const batches=[];
  globalThis.fetch=async(url)=>{
    const parsed=new URL(url,"http://localhost");
    const codes=parsed.searchParams.get("codes").split(",");
    batches.push(codes);
    return Response.json({quotes:Object.fromEntries(codes.map(code=>[code,{price:100}])),usdKrw:null,jpyKrw:null,asOf:"2026-09-07T00:00:00Z"});
  };
  const codes=Array.from({length:100},(_,i)=>String(i+1).padStart(6,"0"));
  const result=await loadPortfolioQuotes([...codes,...codes],false);
  assert.deepEqual(batches.map(batch=>batch.length),[30,30,30,10]);
  assert.equal(Object.keys(result.quotes).length,100);
});

test("잔고가 없어도 USD 성과의 환율을 단독 조회한다",async()=>{
  let requested;
  globalThis.fetch=async(url)=>{requested=String(url);return Response.json({quotes:{},usdKrw:1400,jpyKrw:null,asOf:"now"});};
  const result=await loadPortfolioQuotes([],true);
  assert.match(requested,/fx=USD/);
  assert.equal(result.usdKrw,1400);
});

test("환율 단독 API가 실제 조회하며 지원하지 않는 통화는 거부한다",async()=>{
  globalThis.fetch=async()=>Response.json({closePrice:"1400"});
  const result=await quotes(new NextRequest("http://localhost/api/quotes?fx=USD"));
  assert.equal(result.status,200);
  assert.equal((await result.json()).usdKrw,1400);
  assert.equal((await quotes(new NextRequest("http://localhost/api/quotes?fx=FAKE"))).status,400);
});

test("일부 배치 요청 실패를 성공한 전체 시세로 오인하지 않는다",async()=>{
  let count=0;
  globalThis.fetch=async()=>++count===1?Response.json({quotes:{},usdKrw:1400,jpyKrw:null,asOf:"now"}):new Response(null,{status:502});
  await assert.rejects(loadPortfolioQuotes(Array.from({length:31},(_,i)=>String(i)),false));
});

const input={request_id:"01234567-1234-4123-8123-012345678901",market:"US",stock_code:"SE",stock_name:"씨 ADR",broker:"KIWOOM",side:"BUY",quantity:10,price:100,traded_on:"2026-09-01"};
const request=(body)=>new NextRequest("http://localhost/api/manual-trades",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
function auth(){
  process.env.SUPABASE_URL="https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY="test-anon";
  process.env.SUPABASE_SECRET_KEY="sb_secret_test";
  globalThis.__testCookieJar={get:()=>({value:"test-token"})};
}
test("수동 거래 회원 ID는 검증된 Auth 응답에서만 가져온다",async()=>{
  auth();let rpc;
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith("/auth/v1/user"))return Response.json({id:"owner",email:"owner@example.com",user_metadata:{}});
    rpc=JSON.parse(init.body);return Response.json({id:1,quantity_after:10});
  };
  assert.equal((await trade(request(input))).status,200);
  assert.equal(rpc.target_user_id,"owner");
  assert.deepEqual(rpc.trade,input);
  assert.equal((await trade(request({...input,price:0.00000001}))).status,200);
  assert.equal((await trade(request({...input,user_id:"victim"}))).status,400);
});
test("잘못된 세션, 과도한 소수 수량, 비정상 숫자는 거래를 기록하지 않는다",async()=>{
  auth();let rpcCount=0;
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith("/auth/v1/user"))return new Response(null,{status:401});
    rpcCount++;throw new Error("Unexpected RPC");
  };
  assert.equal((await trade(request(input))).status,401);
  globalThis.fetch=async()=>Response.json({id:"owner",email:"owner@example.com"});
  for(const patch of [{quantity:0.00001},{price:-1},{quantity:Infinity},{market:"EU"},{traded_on:"2026-02-31"}])assert.equal((await trade(request({...input,...patch}))).status,400);
  assert.equal(rpcCount,0);
});

test("삭제 대기 중 변경된 잔고는 조건부 삭제로 보호한다",async()=>{
  auth();let target;
  globalThis.fetch=async(url)=>{target=String(url);return Response.json([]);};
  const response=await deleteHolding(new NextRequest("http://localhost/api/holdings?code=SE&market=US&broker=KIWOOM&quantity=10&avg_price=100"));
  assert.equal(response.status,409);
  assert.match(target,/quantity=eq\.10&avg_price=eq\.100/);
  assert.match(target,/source=eq\.manual/);
});

test("정정과 백업 복원도 서버가 소유자를 결정하고 파일의 소수 문자열을 보존한다",async()=>{
  auth();const calls=[];
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user'))return Response.json({id:'owner',email:'owner@example.com'});
    calls.push({url:String(url),body:JSON.parse(init.body)});
    return Response.json({ok:true});
  };
  const fields={...input};delete fields.request_id;
  const change={request_id:input.request_id,trade_id:1,expected_revision:2,trade:fields,cancelled:true,reason:'오입력'};
  assert.equal((await correct(request(change))).status,200);
  assert.equal(calls[0].body.target_user_id,'owner');
  assert.match(calls[0].url,/revise_manual_trade/);
  assert.equal((await correct(request({...change,expected_revision:0}))).status,400);
  const archive_text='{"price":"123456.12345678"}';
  assert.equal((await restore(request({archive_text,apply:false,expected_fingerprint:'a'.repeat(32)}))).status,200);
  assert.equal(calls[1].body.archive_text,archive_text);
  assert.equal(calls[1].body.owner_id,'owner');
  assert.equal((await restore(request({archive_text,apply:true,expected_fingerprint:'a'.repeat(32),owner_id:'victim'}))).status,400);
});

test("CSV는 수식 실행을 차단하고 큰 금액의 문자열 정밀도를 보존한다",async()=>{
  auth();
  globalThis.fetch=async(url)=>String(url).endsWith('/auth/v1/user')?Response.json({id:'owner',email:'owner@example.com'}):Response.json(JSON.stringify({data:{holdings:[{stock_name:' =HYPERLINK("bad")',quantity:'1.0000',avg_price:'123456789012.12345678'}]}}));
  const response=await backup(new NextRequest('http://localhost/api/portfolio-backup?format=holdings'));
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  const text=await response.text();
  assert.match(text,/' =HYPERLINK/);
  assert.match(text,/123456789012\.12345678/);
});
