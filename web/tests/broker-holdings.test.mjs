import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveHoldings,validBrokerSnapshots,holdingOwnership} from '../src/lib/broker-holdings.ts';
import {createDatabase} from './db-fixture.mjs';
const uid='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const token='a'.repeat(64);
const holding={stock_code:'005930',stock_name:'삼성전자',quantity:10,avg_price:50000,automated_quantity:3};
const snapshot={broker:'KIS',account_kind:'general',market:'KR',collected_at:new Date().toISOString(),holdings:[holding]};
test('broker scope replaces display, not paper or ISA, with mixed ownership',()=>{
 const manual={...holding,broker:'KIS',market:'KR',source:'manual',account_type:'manual'};
 const paper={...manual,source:'stock_trading',account_type:'paper'};
 const isa={...manual,broker:'KIS_ISA'};
 const rows=effectiveHoldings([manual,paper,isa],[snapshot]);
 assert.equal(rows.length,3);assert.equal(rows.at(-1).source,'broker_sync');
 assert.equal(holdingOwnership(rows.at(-1)),'자동 3 · 직접 7');
 assert.equal(effectiveHoldings([manual],[{...snapshot,holdings:[]}]).length,0);
 assert.equal(effectiveHoldings([manual],[]).length,1);
 assert.ok(validBrokerSnapshots([snapshot]));
 assert.ok(!validBrokerSnapshots([snapshot,snapshot]));
 assert.ok(!validBrokerSnapshots([{...snapshot,account_kind:'isa'}]));
 assert.equal(holdingOwnership({...rows.at(-1),automated_quantity:null}),'매수 주체 확인 필요');
});
test('live holdings RPC ownership, stale writes, ISA registration and existing ledger replay',async()=>{
 const db=await createDatabase([uid,other]);
 try {
  await db.query("insert into integration_tokens(user_id,token_hash,token_hint) values($1,$2,'123456')",[uid,token]);
  assert.equal((await db.query('select sync_broker_holdings($1,$2) n',[token,JSON.stringify([snapshot])])).rows[0].n,1);
  assert.equal((await db.query('select sync_broker_holdings($1,$2) n',[token,JSON.stringify([snapshot])])).rows[0].n,0);
  await assert.rejects(db.query('select sync_broker_holdings($1,$2)',['bad-token',JSON.stringify([snapshot])]));
  await assert.rejects(db.query('select sync_broker_holdings($1,$2)',[token,JSON.stringify([{...snapshot,holdings:[{...holding,automated_quantity:11}]}])]));
  await db.query("insert into holdings(user_id,stock_code,stock_name,quantity,avg_price,market,source,account_type,broker) values($1,'005930','삼성전자',2,50000,'KR','manual','manual','KIS_ISA')",[uid]);
  await db.query('select rebuild_manual_portfolio($1)',[uid]);
  assert.equal((await db.query("select quantity from holdings where broker='KIS_ISA'")).rows[0].quantity,'2.0000');
  const archive=(await db.query('select export_portfolio($1) value',[uid])).rows[0].value;
  const fingerprint=JSON.parse(archive).fingerprint;
  await db.query('select restore_portfolio($1,$2,$3,true)',[uid,archive,fingerprint]);
  assert.equal((await db.query("select quantity from holdings where broker='KIS_ISA'")).rows[0].quantity,'2.0000');
  assert.equal((await db.query('select * from briefing_holdings')).rows.length,2);
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
  assert.equal((await db.query('select * from broker_holdings')).rows.length,0);
  assert.equal((await db.query('select * from briefing_holdings')).rows.length,0);
  await assert.rejects(db.query('select sync_broker_holdings($1,$2)',[token,'[]']));
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
  assert.equal((await db.query('select * from broker_holdings')).rows.length,1);
 } finally {await db.close();}
});
