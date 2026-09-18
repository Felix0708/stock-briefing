import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { PUT } from '../src/app/api/sync/account-status/route.ts';
import { createDatabase } from './db-fixture.mjs';
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
  } finally {globalThis.fetch=originalFetch;process.env=originalEnv;}
});

test('status DB isolates owners, prevents stale overwrite and never changes balances',async()=>{
  const db=await createDatabase([owner,other]);
  try {
    await db.query('insert into integration_tokens(user_id,token_hash,token_hint) values($1,$2,$3)',[owner,'a'.repeat(64),'aaaaaa']);
    const sync=async(records,token='a'.repeat(64))=>(await db.query('select sync_account_status($1,$2::jsonb) n',[token,JSON.stringify(records)])).rows[0].n;
    assert.equal(await sync([row]),1);
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
