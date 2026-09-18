import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { PUT } from '../src/app/api/sync/account-status/route.ts';
import { createDatabase } from './db-fixture.mjs';
import { GET } from '../src/app/api/account-equity/route.ts';
import { accountStatusMessage } from '../src/lib/account-status.ts';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const row={account_ref:owner,broker:'KIWOOM',account_type:'paper',checked_at:'2026-09-01T01:00:00Z',code:'other_currency_assets'};

test('status API rejects owner injection, invalid diagnostics and invalid acknowledgements',async()=>{
  const originalFetch=globalThis.fetch,originalEnv={...process.env};
  try {
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_SECRET_KEY='sb_secret_test';
    const req=(statuses=[row],extra={},token='sb_sync_'+'a'.repeat(43))=>new NextRequest('http://localhost/api/sync/account-status',{
      method:'PUT',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify({version:1,statuses,...extra})});
    globalThis.fetch=async(url,init)=>{assert.match(String(url),/rpc\/sync_account_status$/);const body=JSON.parse(init.body);
      assert.equal(body.token_hash.length,64);assert.deepEqual(body.records,[row]);return Response.json(1);};
    assert.equal((await PUT(req([],{},'bad'))).status,401);
    assert.deepEqual(await (await PUT(req())).json(),{ok:true,synced:1});
    for(const statuses of [[row,row],[{...row,user_id:other}],[{...row,code:'secret reason'}],[{...row,checked_at:'bad'}],[{...row,broker:['KIS']}],Array(21).fill(row)]) {
      assert.equal((await PUT(req(statuses))).status,400);
    }
    assert.equal((await PUT(req([row],{user_id:other}))).status,400);
    for(const ack of [null,-1,2,'1',{}]) {globalThis.fetch=async()=>Response.json(ack);assert.equal((await PUT(req())).status,502);}
    globalThis.fetch=async()=>new Response('private conflict',{status:409});
    assert.equal((await PUT(req())).status,409);
  } finally {globalThis.fetch=originalFetch;process.env=originalEnv;}
});

test('status DB isolates owners, prevents stale overwrite and never changes balances',async()=>{
  const db=await createDatabase([owner,other]);
  try {
    await db.query('insert into integration_tokens(user_id,token_hash,token_hint) values($1,$2,$3)',[owner,'a'.repeat(64),'aaaaaa']);
    const sync=async(records,token='a'.repeat(64))=>(await db.query('select sync_account_status($1,$2::jsonb) n',[token,JSON.stringify(records)])).rows[0].n;
    assert.equal(await sync([row]),1);
    assert.equal(await sync([row]),0);
    await assert.rejects(sync([{...row,account_ref:other},{...row,code:'total_verified'}]),/conflicting status/);
    assert.equal((await db.query('select * from account_collection_status')).rows.length,1,'whole batch rolls back on conflict');
    await assert.rejects(sync([row,row]),/duplicate account/);
    for(const checked_at of ['-infinity','infinity','not a date']) await assert.rejects(sync([{...row,checked_at}]),/invalid status timestamp/);
    assert.equal(await sync([{...row,checked_at:'2026-08-31T00:00:00Z',code:'total_verified'}]),0);
    assert.equal((await db.query('select code from account_collection_status')).rows[0].code,'other_currency_assets');
    assert.equal((await db.query('select count(*)::int n from holdings')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int n from account_equity_points')).rows[0].n,0);
    await assert.rejects(sync([row],'b'.repeat(64)),/invalid integration token/);
    await assert.rejects(sync([{...row,user_id:other}]),/invalid status/);
    await db.exec('reset role;set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
    assert.equal((await db.query('select * from account_collection_status')).rows.length,0);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
    assert.equal((await db.query('select * from account_collection_status')).rows.length,1);
    await assert.rejects(sync([row]),/permission denied/);
    await assert.rejects(db.exec("update account_collection_status set code='total_verified'"),/permission denied/);
    await db.exec('reset role;set role anon');
    await assert.rejects(db.exec('select * from account_collection_status'),/permission denied/);
  } finally {await db.close();}
});

test('diagnostic success is not asset receipt; newer assets supersede old failures for the same account only',()=>{
  const verified={...row,code:'total_verified'};
  const total={account_ref:owner,broker:'KIWOOM',account_type:'paper',scope:'account-total-assets',collected_at:row.checked_at};
  assert.match(accountStatusMessage(verified,[]),/수신 확인 필요/);
  assert.equal(accountStatusMessage(verified,[total]),'총자산 수신 완료');
  for(const patch of [{account_ref:other},{broker:'KIS'},{account_type:'live'},{scope:'domestic'},{collected_at:'2026-08-01T00:00:00Z'}]) {
    assert.match(accountStatusMessage(verified,[{...total,...patch}]),/수신 확인 필요/);
  }
  assert.match(accountStatusMessage(row,[{...total,collected_at:'2026-09-02T00:00:00Z'}]),/이전 진단 이후/);
});

test('diagnostic read runs independently and failed diagnostics preserve received assets',async()=>{
  const originalFetch=globalThis.fetch,originalEnv={...process.env};
  try {
    process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_ANON_KEY='test-anon';
    globalThis.__testCookieJar={get:()=>({value:'member-token'})};
    let resolveSeries;
    const paused=new Promise(resolve=>{resolveSeries=resolve;});
    let statusStarted=false;
    globalThis.fetch=async(url)=>{
      if(String(url).endsWith('/auth/v1/user'))return Response.json({id:owner,email:'qa@example.com'});
      if(String(url).includes('/rpc/')){await paused;return Response.json([{account_ref:owner}]);}
      statusStarted=true;return new Response('unavailable',{status:503});
    };
    const pending=GET(new NextRequest('http://localhost/api/account-equity'));
    await new Promise(resolve=>setImmediate(resolve));
    const independent=statusStarted;
    resolveSeries();const response=await pending;
    assert.equal(independent,true,'diagnostic and assets must start concurrently');
    assert.deepEqual(await response.json(),{series:[{account_ref:owner}],statuses:[],statusUnavailable:true});
  } finally {globalThis.fetch=originalFetch;process.env=originalEnv;delete globalThis.__testCookieJar;}
});
