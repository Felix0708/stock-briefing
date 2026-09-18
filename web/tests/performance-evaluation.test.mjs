import test from 'node:test';
import assert from 'node:assert/strict';
import {validEvaluation} from '../src/lib/performance-evaluation.ts';
import {parseSnapshot} from '../src/lib/server/holdings-integration.ts';
import {createDatabase} from './db-fixture.mjs';
const uid='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const cohort={policy_hash:'a'.repeat(64),currency:'USD',count:2,wins:1,losses:1,draws:0,win_rate:50,profit_loss:20,net_profit_loss:null,unknown_costs:1};
const evaluation={version:1,total_count:3,eligible_count:2,excluded_count:1,reason_counts:{SYSTEM_INCIDENT:1,REVIEW_REQUIRED:1},cohorts:[cohort]};
const stats={count:3,wins:2,losses:1,draws:0,win_rate:66.67};
const p={broker:'KIS',account_type:'paper',all:stats,month:stats,realized:{KRW:{count:0,profit_loss:0,return_rate:null},USD:{count:3,profit_loss:30,return_rate:3}},excluded_full_exits:0,updated_at:'2026-09-01T00:00:00Z'};
const invalid=[
 {...evaluation,total_count:4},{...evaluation,eligible_count:1},{...evaluation,reason_counts:{}},
 {...evaluation,reason_counts:{SYSTEM_INCIDENT:2}}, {...evaluation,reason_counts:{private_id:1}},
 {...evaluation,account_id:'not-allowed'}, {...evaluation,cohorts:[cohort,cohort]},
 ...[{count:1},{currency:null},{policy_hash:'private-identifier'},{win_rate:70},{unknown_costs:0},{net_profit_loss:0},{profit_loss:'20'},{order_id:'not-allowed'}].map(patch=>({...evaluation,cohorts:[{...cohort,...patch}]})),
];
test('optional evaluation is bounded, policy separated and rejects private fields or inconsistent counts',()=>{
 assert.ok(validEvaluation(evaluation));
 for(const row of invalid) assert.equal(validEvaluation(row),false,JSON.stringify(row));
 assert.ok(validEvaluation({version:1,total_count:0,eligible_count:0,excluded_count:0,reason_counts:{},cohorts:[]}));
 assert.equal(typeof parseSnapshot({holdings:[],performance:[p]}),'object');
 assert.deepEqual(parseSnapshot({holdings:[],performance:[{...p,evaluation}]}).performance[0].evaluation,evaluation);
 for(const row of [null,...invalid,{...evaluation,total_count:4,excluded_count:2,reason_counts:{REVIEW_REQUIRED:2}}])
  assert.equal(typeof parseSnapshot({holdings:[],performance:[{...p,evaluation:row}]}),'string');
 assert.equal(typeof parseSnapshot({holdings:[],performance:[{...p,account_type:'live',evaluation}]}),'string');
});
test('evaluation persists atomically, retains legacy null, backup roundtrip and RLS',async()=>{
 const db=await createDatabase([uid,other]);
 const sync=row=>db.query('select replace_synced_holdings($1,$2,$3)',[uid,'[]',JSON.stringify([row])]);
 const read=async()=> (await db.query('select * from trading_performance')).rows[0];
 try{
  for(const row of invalid) assert.equal((await db.query('select valid_performance_evaluation($1) ok',[JSON.stringify(row)])).rows[0].ok,false);
  await sync(p); assert.equal((await read()).evaluation,null);
  await sync({...p,evaluation}); assert.deepEqual((await read()).evaluation,evaluation);assert.equal((await read()).all_count,3);
  await assert.rejects(sync({...p,evaluation:{...evaluation,total_count:4}}));assert.deepEqual((await read()).evaluation,evaluation);
  const archive=(await db.query('select export_portfolio($1) value',[uid])).rows[0].value;
  await db.query('select restore_portfolio($1,$2,$3,true)',[uid,archive,JSON.parse(archive).fingerprint]);
  assert.deepEqual((await read()).evaluation,evaluation);
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
  assert.equal((await db.query('select * from trading_performance')).rows.length,0);
  await assert.rejects(sync({...p,evaluation}));
  await db.exec('set role service_role');await sync(p);assert.equal((await read()).evaluation,null);
 }finally{await db.close();}
});
