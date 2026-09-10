import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server';
import { parseEquity, readEquityBody, MAX_EQUITY_BYTES } from '../src/lib/server/account-equity.ts';
import { canConnect, chartValue, equityMoney, RETURN_METHOD } from '../src/lib/account-equity.ts';
import { PUT } from '../src/app/api/sync/account-equity/route.ts';
import { GET } from '../src/app/api/account-equity/route.ts';
import { createDatabase } from './db-fixture.mjs';

const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const point={date:'2026-09-01',valued_at:null,collected_at:'2026-09-01T01:00:00.000Z',calculated_at:'2026-09-01T02:00:00.000Z',
  equity:'1234567890123456.12345678',cash:null,stock_value:null,return_index:null,return_status:'insufficient_samples',source:'KIS_ACCOUNT_EQUITY'};
const series={account_ref:owner,broker:'KIS',account_type:'paper',currency:'KRW',scope:'account-total-assets',date_timezone:'Asia/Seoul',return_method:null,return_base_at:null,points:[point]};
const input=(s=series)=>({version:1,series:[s]});
const flat=()=>parseEquity(input())[0];
const originalFetch=globalThis.fetch, originalEnv={...process.env};
test.afterEach(()=>{globalThis.fetch=originalFetch;process.env={...originalEnv};delete globalThis.__testCookieJar;});

test('strict contract accepts unknown breakdown and one point; never fabricates returns', async()=>{
  assert.equal(parseEquity(input())[0].cash,null);
  assert.equal(chartValue(flat(),'return'),null);
  assert.equal(equityMoney(point.equity,'KRW'),'1,234,567,890,123,456.12345678원');
  assert.equal(equityMoney('0','USD'),'$0');
  for(const patch of [{equity:100},{cash:'1e4'},{equity:'-1'},{return_index:'1'},{return_status:'verified'},
    {date:'2026-02-31'},{collected_at:'2026-09-01T24:00:00Z'},{collected_at:'2026-08-31T01:00:00Z'},
    {calculated_at:'2026-08-01T00:00:00Z'},{source:'KIWOOM_US_EQUITY'},{secret:'no'}]) {
    assert.equal(typeof parseEquity(input({...series,points:[{...point,...patch}]})),'string',JSON.stringify(patch));
  }
  assert.equal(typeof parseEquity({...input(),user_id:other}),'string');
  assert.equal(typeof parseEquity(input({...series,points:[point,point]})),'string');
  assert.equal(typeof parseEquity(input({...series,currency:'JPY'})),'string');
  assert.equal(typeof parseEquity(input({...series,broker:['KIS']})),'string');
  assert.equal(typeof parseEquity(input({...series,points:[{...point,return_status:['insufficient_samples']}]})),'string');
  assert.deepEqual(parseEquity({version:1,series:[]}),[]);
  const verified={...flat(),return_method:RETURN_METHOD,return_base_at:point.collected_at,return_status:'verified',return_index:'1.01'};
  assert.ok(Math.abs(chartValue(verified,'return')-1)<1e-10);
  assert.equal(canConnect(verified,{...verified,date:'2026-09-02'},'return'),true);
  for(const patch of [{date:'2026-09-03'},{date:'2026-09-02',return_status:'cash_flows_unverified',return_index:null},
    {date:'2026-09-02',return_base_at:'2026-08-01T00:00:00Z'},{date:'2026-09-02',account_ref:other}]) {
    assert.equal(canConnect(verified,{...verified,...patch},'return'),false);
  }
  await assert.rejects(readEquityBody(new Request('http://localhost',{method:'PUT',body:' '.repeat(MAX_EQUITY_BYTES+1)})),RangeError);
});

test('Bearer PUT and member GET: bounded, private, no owner injection, error mapping', async()=>{
  process.env.SUPABASE_URL='https://example.supabase.co';
  process.env.SUPABASE_ANON_KEY='test-anon';process.env.SUPABASE_SECRET_KEY='sb_secret_test';
  const req=(body=input(),token='sb_sync_'+'a'.repeat(43))=>new NextRequest('http://localhost/api/sync/account-equity',{
    method:'PUT',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  globalThis.fetch=async(url,init)=>{assert.match(String(url),/rpc\/sync_account_equity$/);const data=JSON.parse(init.body);
    assert.equal(data.token_hash.length,64);assert.equal(data.user_id,undefined);assert.equal(data.records[0].equity,point.equity);return Response.json(1);};
  assert.equal((await PUT(req(input(),'bad'))).status,401);
  assert.deepEqual(await (await PUT(req())).json(),{ok:true,synced:1});
  assert.equal((await PUT(req({...input(),user_id:other}))).status,400);
  for(const status of [400,401,409,500]) {globalThis.fetch=async()=>new Response('sensitive detail',{status});
    const res=await PUT(req());assert.equal(res.status,status===500?502:status);assert.doesNotMatch(await res.text(),/sensitive/);}
  globalThis.__testCookieJar={get:()=>undefined};
  assert.equal((await GET(new NextRequest('http://localhost/api/account-equity'))).status,401);
  globalThis.__testCookieJar={get:()=>({value:'member-token'})};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('/auth/v1/user')) return Response.json({id:owner,email:'test@example.com'});
    assert.equal(init.headers.Authorization,'Bearer member-token');
    return String(url).includes('/rpc/')?Response.json([flat()]):Response.json([{payload:flat(),received_at:'2026-09-01T03:00:00Z'}]);
  };
  const res=await GET(new NextRequest('http://localhost/api/account-equity'));
  assert.equal(res.headers.get('cache-control'),'no-store');assert.equal((await res.json()).series.length,1);
  const params=new URLSearchParams(Object.fromEntries(['account_ref','broker','account_type','currency','scope'].map(k=>[k,series[k]])));
  assert.equal((await (await GET(new NextRequest(`http://localhost/api/account-equity?${params}`))).json()).points.length,1);
  assert.equal((await GET(new NextRequest(`http://localhost/api/account-equity?${params}&user_id=${other}`))).status,400);
});

test('Postgres: RLS, idempotence, correction ordering, atomic conflict, omitted history and token revocation',async()=>{
  const db=await createDatabase([owner,other]);
  try {
    await db.query('insert into integration_tokens(user_id,token_hash,token_hint) values($1,$2,$3),($4,$5,$6)',[owner,'a'.repeat(64),'aaaaaa',other,'b'.repeat(64),'bbbbbb']);
    const sync=async(rows,hash='a'.repeat(64))=>(await db.query('select sync_account_equity($1,$2::jsonb) as n',[hash,JSON.stringify(rows)])).rows[0].n;
    const first=flat();assert.equal(await sync([first]),1);assert.equal(await sync([first]),0);
    assert.equal(await sync([]),0);
    const revised={...first,equity:'500',calculated_at:'2026-09-01T03:00:00.000Z'};
    assert.equal(await sync([revised]),1);assert.equal(await sync([first]),0);
    const olderCollection={...first,collected_at:'2026-09-01T00:00:00.000Z',calculated_at:'2026-09-02T01:00:00.000Z'};
    assert.equal(await sync([olderCollection]),0);
    const second={...first,date:'2026-09-02',collected_at:'2026-09-02T01:00:00.000Z',calculated_at:'2026-09-02T02:00:00.000Z',equity:'0',cash:'0',stock_value:'0'};
    await assert.rejects(sync([second,{...revised,equity:'600'}]),/conflicting/);
    assert.equal((await db.query('select count(*)::int n from account_equity_points')).rows[0].n,1);
    assert.equal(await sync([second]),1);
    assert.equal(await sync([{...first,account_ref:other}],'b'.repeat(64)),1);
    for(const patch of [{equity:'-1'},{equity:3},{date_timezone:'UTC'},{return_index:'1'},{user_id:other}]) await assert.rejects(sync([{...first,...patch}]));
    await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${owner}'`);
    assert.equal((await db.query('select * from account_equity_points')).rows.length,2);
    const latest=(await db.query('select account_equity_series() as data')).rows[0].data;
    assert.equal(latest.length,1);assert.equal(latest[0].date,second.date);assert.equal(latest[0].equity,'0');
    await assert.rejects(sync([first]),/permission denied/);
    await assert.rejects(db.exec('delete from account_equity_points'),/permission denied/);
    await db.exec(`reset role;set role authenticated;set request.jwt.claim.sub='${other}'`);
    assert.equal((await db.query('select * from account_equity_points')).rows.length,1);
    await db.exec('reset role;set role anon');await assert.rejects(db.exec('select account_equity_series()'),/permission denied/);
    await db.exec('reset role;set role service_role');
    await db.query('delete from integration_tokens where user_id=$1',[owner]);
    await assert.rejects(sync([]),/invalid integration token/);
    assert.equal((await db.query('select count(*)::int n from account_equity_points')).rows[0].n,3);
  } finally {await db.close();}
});
