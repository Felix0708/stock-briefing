import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { recordedTax } from '../src/lib/foreign-tax.ts';
import { PUT } from '../src/app/api/sync/tax-estimate/route.ts';
import { GET } from '../src/app/api/tax-estimate/route.ts';
import { createDatabase } from './db-fixture.mjs';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const row={broker:'KIWOOM',account_type:'live',year:2026,market:'US',sell_count:2,missing_count:0,profit_loss:5000,updated_at:'2026-09-18T00:00:00Z'};
const originalFetch=globalThis.fetch,originalEnv={...process.env};
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnv};delete globalThis.__testCookieJar;});
test('recorded sums combine currencies; missing rates, counts or duplicate groups do not fabricate tax',()=>{
  const usd={...row,source:'stock_trading'};
  const jpy={...usd,source:'manual',market:'JP',profit_loss:-100000};
  assert.equal(recordedTax([usd,jpy],1400,10).result.tax,770000);
  assert.equal(recordedTax([usd,jpy],1400,null),null);
  assert.equal(recordedTax([usd,usd],1400,10),null);
  assert.equal(recordedTax([{...usd,missing_count:1}],1400,10).result,null);
  assert.equal(recordedTax([],null,null).result.tax,0);
  assert.equal(recordedTax([{...usd,sell_count:0}],1400,10),null);
});
test('tax sync rejects paper, owner injection, duplicates and malformed acknowledgements; GET is session scoped',async()=>{
  process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_test';process.env.SUPABASE_ANON_KEY='anon';
  const req=(records=[row],token='sb_sync_'+'a'.repeat(43))=>new NextRequest('http://localhost/api/sync/tax-estimate',{method:'PUT',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({version:1,records})});
  globalThis.fetch=async(url,init)=>{assert.match(String(url),/rpc\/sync_recorded_tax$/);assert.equal(JSON.parse(init.body).token_hash.length,64);return Response.json(1);};
  assert.equal((await PUT(req())).status,200);
  assert.equal((await PUT(req([row],'bad'))).status,401);
  for(const records of [[{...row,account_type:'paper'}],[{...row,user_id:other}],[row,row],[{...row,profit_loss:null}],[{...row,sell_count:0}],[{...row,broker:['KIWOOM']}],[{...row,market:['US']}]]) assert.equal((await PUT(req(records))).status,400);
  for(const ack of [null,'1',2,-1,0.5]){globalThis.fetch=async()=>Response.json(ack);assert.equal((await PUT(req())).status,502);}
  globalThis.__testCookieJar={get:()=>undefined};
  assert.equal((await GET(new NextRequest('http://localhost/api/tax-estimate'))).status,401);
  globalThis.__testCookieJar={get:()=>({value:'member-token'})};
  globalThis.fetch=async(url,init)=>{assert.match(String(url),/rpc\/recorded_tax_summary$/);assert.equal(init.headers.Authorization,'Bearer member-token');assert.deepEqual(JSON.parse(init.body),{target_year:2026});return Response.json([]);};
  const res=await GET(new NextRequest('http://localhost/api/tax-estimate'));assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
  assert.equal((await GET(new NextRequest('http://localhost/api/tax-estimate?user_id='+other))).status,400);
});
test('database isolates live annual summaries and applies corrections without duplicate accumulation',async()=>{
  const db=await createDatabase([owner,other]);
  try {
    await db.query('insert into public.integration_tokens(user_id,token_hash,token_hint) values($1,$2,$3)',[owner,'a'.repeat(64),'aaaaaa']);
    const sync=records=>db.query('select public.sync_recorded_tax($1,$2::jsonb)', ['a'.repeat(64),JSON.stringify(records)]);
    await sync([row]);await sync([row]);
    await assert.rejects(sync([{...row,account_type:'paper'}]));
    await sync([{...row,profit_loss:4000,updated_at:'2026-09-18T01:00:00Z'}]);await sync([row]);
    const trade=(side,price,traded_on)=>({request_id:randomUUID(),market:'JP',stock_code:'7203',stock_name:'Toyota',broker:'KIS',side,quantity:1,price,traded_on});
    const record=async value=>(await db.query('select public.record_manual_trade($1,$2::jsonb) as trade',[owner,JSON.stringify(value)])).rows[0].trade;
    await record({...trade('BUY',100,'2025-09-01'),quantity:4});
    await record(trade('SELL',120,'2025-09-02'));
    const cancelled=await record(trade('SELL',140,'2026-09-01'));
    const input=trade('SELL',140,'2026-09-01');delete input.request_id;
    await db.query('select public.revise_manual_trade($1,$2::jsonb)',[owner,JSON.stringify({request_id:randomUUID(),trade_id:cancelled.id,expected_revision:1,trade:input,cancelled:true,reason:'cancel duplicate'})]);
    await record(trade('SELL',160,'2026-09-02'));
    await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    const {rows}=await db.query('select * from public.recorded_tax_summary(2026)');
    assert.equal(rows.length,2);assert.equal(Number(rows.find(r=>r.source==='stock_trading').profit_loss),4000);
    assert.equal(Number(rows.find(r=>r.source==='manual').profit_loss),60);
    assert.equal(Number(rows.find(r=>r.source==='manual').sell_count),1);
    assert.equal(Number((await db.query('select * from public.recorded_tax_summary(2025)')).rows[0].profit_loss),20);
    await assert.rejects(db.query('delete from public.recorded_tax_estimates'));
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
    assert.equal((await db.query('select * from public.recorded_tax_summary(2026)')).rows.length,0);
    await db.exec('set role anon');await assert.rejects(db.query('select * from public.recorded_tax_summary(2026)'));
  } finally {await db.close();}
});
