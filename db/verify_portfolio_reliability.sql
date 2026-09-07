-- All test data is rolled back. No real user balances are touched.
begin;
do $$
declare
  owner uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  baseline_owner uuid := gen_random_uuid();
  request_key uuid := gen_random_uuid();
  base jsonb;
  result jsonb;
begin
  insert into auth.users(id) values(owner),(stranger),(baseline_owner);
  perform set_config('test.owner',owner::text,true);
  perform set_config('test.stranger',stranger::text,true);
  base := jsonb_build_object('request_id',request_key,'market','US','stock_code','TEST','stock_name','검증용','broker','KIWOOM','side','BUY','quantity',10,'price',100,'traded_on',current_date);
  result := public.record_manual_trade(owner,base);
  assert (result->>'quantity_after')::numeric=10;
  assert (result->>'avg_price_after')::numeric=100;
  perform public.record_manual_trade(owner,base);
  assert (select count(*) from public.manual_trades where user_id=owner)=1, 'Duplicate request inserted';
  begin
    perform public.record_manual_trade(owner,base || '{"quantity":20}'::jsonb);
    raise exception 'Mismatched duplicate accepted';
  exception when invalid_parameter_value then null;
  end;
  result := public.record_manual_trade(owner,base || jsonb_build_object('request_id',gen_random_uuid(),'price',200));
  assert (result->>'quantity_after')::numeric=20;
  assert (result->>'avg_price_after')::numeric=150;
  result := public.record_manual_trade(owner,base || jsonb_build_object('request_id',gen_random_uuid(),'side','SELL','quantity',5,'price',180));
  assert (result->>'quantity_after')::numeric=15;
  assert (result->>'realized_profit_loss')::numeric=150;
  begin
    perform public.record_manual_trade(owner,base || jsonb_build_object('request_id',gen_random_uuid(),'side','SELL','quantity',16));
    raise exception 'Oversell accepted';
  exception when invalid_parameter_value then null;
  end;
  assert (select quantity from public.holdings where user_id=owner)=15;
  assert (select count(*) from public.manual_trades where user_id=owner)=3;
  result := public.record_manual_trade(owner,base || jsonb_build_object('request_id',gen_random_uuid(),'side','SELL','quantity',15,'price',140));
  assert (result->>'quantity_after')::numeric=0;
  assert (result->>'realized_profit_loss')::numeric=-150;
  assert not exists(select 1 from public.holdings where user_id=owner);
  assert not has_function_privilege('authenticated','public.record_manual_trade(uuid,jsonb)','EXECUTE');
  assert not has_function_privilege('anon','public.record_manual_trade(uuid,jsonb)','EXECUTE');
  assert has_function_privilege('service_role','public.record_manual_trade(uuid,jsonb)','EXECUTE');
  assert not has_table_privilege('authenticated','public.manual_trades','INSERT');
  assert not has_table_privilege('anon','public.collection_status','SELECT');
  perform public.record_manual_trade(stranger,base || jsonb_build_object('request_id',gen_random_uuid()));
  -- Existing balances are starting positions, not synthetic historical buys.
  insert into public.holdings(user_id,market,stock_code,stock_name,broker,source,account_type,quantity,avg_price)
  values(baseline_owner,'US','TEST','검증용','KIWOOM','manual','manual',7,115),
    (baseline_owner,'US','TEST','검증용','KIWOOM','stock_trading','live',99,200),
    (owner,'US','QATST','QA-own-'||owner::text,'KIWOOM','manual','manual',1,100);
  assert not exists(select 1 from public.manual_trades where user_id=baseline_owner);
  result := public.record_manual_trade(baseline_owner,base || jsonb_build_object('request_id',gen_random_uuid(),'side','SELL','quantity',2,'price',125));
  assert (result->>'quantity_after')::numeric=5;
  assert (result->>'realized_profit_loss')::numeric=20;
  assert (select count(*) from public.manual_trades where user_id=baseline_owner)=1;
  assert (select quantity from public.holdings where user_id=baseline_owner and source='stock_trading')=99;
  insert into public.collection_status(market,company,stock_code,status,checked_at)
  values('US','QA-own-'||owner::text,'QATST','empty',now()),('US','QA-other-'||owner::text,'QAZZZ','failed',now());
  insert into public.briefing_deliveries(user_id,status,checked_at) values(owner,'no_filings',now()),(stranger,'sent',now());
  assert not has_table_privilege('authenticated','public.briefing_deliveries','INSERT,UPDATE,DELETE');
  assert not has_table_privilege('authenticated','public.collection_status','INSERT,UPDATE,DELETE');
end;
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.owner'),true) is not null as session_configured;
do $$
begin
  assert (select count(*) from public.manual_trades)=4, 'RLS leaked another user';
  assert (select sell_count from public.manual_trade_summary())=2;
  assert (select profit_loss from public.manual_trade_summary())=0;
  assert (select count(*) from public.collection_status)=1, 'Collection status RLS leaked another holding';
  assert (select count(*) from public.briefing_deliveries)=1, 'Delivery status RLS leaked another user';
  assert (select status from public.briefing_deliveries)='no_filings';
end;
$$;
reset role;
rollback;
select 'PASS' as result;
