import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './db-fixture.mjs';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

test('real PostgreSQL: corrections, rollback, RLS, sync and durable mail', async () => {
  const db = await createDatabase([owner,other],`insert into holdings(user_id,market,stock_code,stock_name,broker,quantity,avg_price) values('${owner}','US','SE','Sea','KIWOOM',10,100)`);
  try {
    const rpc = async (name, value) => (await db.query(`select public.${name}($1,$2::jsonb) as result`, [owner,JSON.stringify(value)])).rows[0].result;
    const trade = (side, quantity, price, date='2026-09-01') => ({request_id:randomUUID(),market:'US',stock_code:'SE',stock_name:'Sea',broker:'KIWOOM',side,quantity,price,traded_on:date});
    const buyInput=trade('BUY',5,130);
    const buy=await rpc('record_manual_trade',buyInput);
    assert.equal(buy.avg_price_after,110);
    assert.equal((await rpc('record_manual_trade',buyInput)).id,buy.id);
    const sell=await rpc('record_manual_trade',trade('SELL',3,150,'2026-09-02'));
    assert.equal(sell.realized_profit_loss,120);
    const input={...buyInput};delete input.request_id;
    const change={request_id:randomUUID(),trade_id:buy.id,expected_revision:1,trade:{...input,price:160},cancelled:false,reason:'Correct price'};
    const edited=await rpc('revise_manual_trade',change);
    assert.equal(edited.revision,2);
    assert.equal((await rpc('revise_manual_trade',change)).revision,2);
    assert.equal(Number((await db.query('select realized_profit_loss from manual_trades where id=$1',[sell.id])).rows[0].realized_profit_loss),90);
    assert.equal(Number((await db.query("select avg_price from holdings where source='manual'")).rows[0].avg_price),120);
    const cancelled=await rpc('revise_manual_trade',{...change,request_id:randomUUID(),expected_revision:2,cancelled:true});
    assert.equal(cancelled.cancelled,true);
    assert.equal(Number((await db.query("select quantity from holdings where source='manual'")).rows[0].quantity),7);
    assert.equal(Number((await db.query('select realized_profit_loss from manual_trades where id=$1',[sell.id])).rows[0].realized_profit_loss),150);
    assert.deepEqual(cancelled.original_input,buyInput);
    await assert.rejects(rpc('revise_manual_trade',{...change,request_id:randomUUID(),trade_id:sell.id,expected_revision:1,trade:{...input,side:'SELL',quantity:100}}),/negative historical balance/);
    assert.equal(Number((await db.query('select revision from manual_trades where id=$1',[sell.id])).rows[0].revision),1);
    assert.equal((await db.query('select count(*)::int as n from manual_trade_revisions')).rows[0].n,2);
    // A direct balance correction is an absolute checkpoint, not an invented trade.
    await db.exec("update holdings set quantity=20,avg_price=200 where source='manual'");
    await rpc('revise_manual_trade',{...change,request_id:randomUUID(),expected_revision:3,cancelled:false});
    assert.equal(Number((await db.query("select quantity from holdings where source='manual'")).rows[0].quantity),20);
    assert.equal((await db.query('select count(*)::int as n from manual_adjustments')).rows[0].n,1);
    // Empty snapshots count as successfully received and cannot erase manual holdings.
    await db.query('select replace_synced_holdings($1,$2::jsonb,$3::jsonb)',[owner,'[]','[]']);
    assert.equal((await db.query('select holdings_count from integration_sync_status')).rows[0].holdings_count,0);
    assert.equal((await db.query('select count(*)::int as n from holdings')).rows[0].n,1);
    const exported=await db.query('select export_portfolio($1) as archive',[owner]);
    const archive=exported.rows[0].archive;
    const snapshot=JSON.parse(archive);
    assert.equal(snapshot.data.holdings[0].quantity,'20.0000');
    await db.exec("update holdings set quantity=25 where source='manual'");
    const changed=JSON.parse((await db.query('select export_portfolio($1) as archive',[owner])).rows[0].archive);
    await assert.rejects(db.query('select restore_portfolio($1,$2,$3,true)',[owner,archive,snapshot.fingerprint]),/changed/);
    const tampered=JSON.parse(archive);tampered.data.holdings[0].quantity='999';
    await assert.rejects(db.query('select restore_portfolio($1,$2,$3,true)',[owner,JSON.stringify(tampered),changed.fingerprint]),/do not agree/);
    assert.equal(Number((await db.query('select quantity from holdings')).rows[0].quantity),25);
    await db.query('select restore_portfolio($1,$2,$3,true)',[owner,archive,changed.fingerprint]);
    const restored=JSON.parse((await db.query('select export_portfolio($1) as archive',[owner])).rows[0].archive);
    assert.deepEqual(restored.data,snapshot.data);
    const safety=JSON.parse((await db.query('select export_portfolio($1,true) as archive',[owner])).rows[0].archive);
    assert.equal(safety.data.holdings[0].quantity,'25.0000');
    await assert.rejects(db.query('select restore_portfolio($1,$2,$3,true)',[other,archive,snapshot.fingerprint]),/owner/);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub='${other}'`);
    assert.equal((await db.query('select * from manual_trades')).rows.length,0);
    assert.equal((await db.query('select * from manual_trade_revisions')).rows.length,0);
    await assert.rejects(rpc('record_manual_trade',trade('BUY',1,1)),/permission denied/);
    await db.exec("reset role; set request.jwt.claim.sub=''; set role service_role");
    await db.exec(`insert into briefing_items(market,rcept_no,company,filing,summary_html,document_text,ready) values('US','qa-1','Sea','{}','summary','document',true)`);
    const candidates=JSON.stringify([{market:'US',rcept_no:'qa-1'}]);
    const prepare=async()=> (await db.query('select prepare_briefing_batch($1,$2,$3::jsonb) as batch',['a'.repeat(64),owner,candidates])).rows[0].batch;
    const batch=await prepare();
    assert.equal((await prepare()).id,batch.id);
    assert.equal((await db.query('select start_briefing_batch($1) as started',[batch.id])).rows[0].started,true);
    assert.equal((await db.query('select start_briefing_batch($1) as started',[batch.id])).rows[0].started,false);
    await db.query("select finish_briefing_batch($1,'sent')",[batch.id]);
    assert.equal(await prepare(),null);
  } finally { await db.close(); }
});
