begin;

-- Existing production has no recorded trades. Refuse an unsafe legacy conversion if this changed.
do $$ begin
  if exists(select 1 from public.manual_trades) then
    raise exception 'Existing trades require baseline reconciliation before this migration';
  end if;
end $$;

create table public.manual_baselines (
  user_id uuid not null references auth.users(id) on delete cascade,
  market text not null check(market in ('KR','US','JP')),
  stock_code text not null,
  stock_name text not null,
  broker text not null,
  quantity numeric(18,4) not null check(quantity>=0),
  avg_price numeric(22,8) not null check(avg_price>=0),
  created_at timestamptz not null default now(),
  primary key(user_id,market,stock_code,broker)
);
insert into public.manual_baselines(user_id,market,stock_code,stock_name,broker,quantity,avg_price)
  select user_id,market,stock_code,stock_name,broker,quantity,avg_price from public.holdings where source='manual';
alter table public.manual_baselines enable row level security;
create policy manual_baselines_own on public.manual_baselines for select to authenticated using((select auth.uid())=user_id);
revoke all on public.manual_baselines from public,anon,authenticated;
grant select on public.manual_baselines to authenticated;
grant select,insert,update,delete on public.manual_baselines to service_role;

create table public.manual_adjustments (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  market text not null,
  stock_code text not null,
  stock_name text not null,
  broker text not null,
  quantity numeric(18,4) not null check(quantity>=0),
  avg_price numeric(22,8) not null check(avg_price>=0),
  created_at timestamptz not null default clock_timestamp()
);
create index manual_adjustments_history on public.manual_adjustments(user_id,market,stock_code,broker,created_at);
alter table public.manual_adjustments enable row level security;
create policy manual_adjustments_own on public.manual_adjustments for select to authenticated using((select auth.uid())=user_id);
revoke all on public.manual_adjustments from public,anon,authenticated;
grant select on public.manual_adjustments to authenticated;
grant select,insert,delete on public.manual_adjustments to service_role;
grant usage,select on sequence public.manual_adjustments_id_seq to service_role;

alter table public.manual_trades add column revision integer not null default 1 check(revision>0);
alter table public.manual_trades add column cancelled boolean not null default false;
alter table public.manual_trades add column original_input jsonb;
grant update,delete on public.manual_trades to service_role;

create table public.manual_trade_revisions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  trade_id bigint not null references public.manual_trades(id) on delete cascade,
  request_id uuid not null,
  previous jsonb not null,
  updated jsonb not null,
  reason text not null check(char_length(reason) between 1 and 500),
  created_at timestamptz not null default clock_timestamp(),
  unique(user_id,request_id)
);
create index manual_trade_revisions_trade on public.manual_trade_revisions(trade_id,id);
alter table public.manual_trade_revisions enable row level security;
create policy manual_trade_revisions_own on public.manual_trade_revisions for select to authenticated using((select auth.uid())=user_id);
revoke all on public.manual_trade_revisions from public,anon,authenticated;
grant select on public.manual_trade_revisions to authenticated;
grant select,insert,delete on public.manual_trade_revisions to service_role;
grant usage,select on sequence public.manual_trade_revisions_id_seq to service_role;

-- Browser writes remain RLS-controlled. This private trigger records them, not a callable public RPC.
create schema if not exists private;
revoke all on schema private from public,anon,authenticated;
create function private.track_manual_balance() returns trigger language plpgsql security definer set search_path='' as $$
declare owner_id uuid; row_value public.holdings%rowtype;
begin
  row_value := case when tg_op='DELETE' then old else new end;
  if row_value.source<>'manual' then return row_value; end if;
  owner_id := row_value.user_id;
  if auth.uid() is not null and auth.uid()<>owner_id then raise exception 'Wrong owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  if current_setting('app.manual_replay',true)='on' and current_setting('role',true) in ('none','postgres','service_role') then
    return row_value;
  end if;
  if tg_op='UPDATE' and (old.quantity,old.avg_price,old.market,old.stock_code,old.broker,old.stock_name)
    is not distinct from (new.quantity,new.avg_price,new.market,new.stock_code,new.broker,new.stock_name) then return new; end if;
  if tg_op='DELETE' or (tg_op='UPDATE' and (old.market,old.stock_code,old.broker) is distinct from (new.market,new.stock_code,new.broker)) then
    insert into public.manual_adjustments(user_id,market,stock_code,stock_name,broker,quantity,avg_price)
      values(owner_id,old.market,old.stock_code,old.stock_name,old.broker,0,0);
  end if;
  if tg_op<>'DELETE' then
    insert into public.manual_adjustments(user_id,market,stock_code,stock_name,broker,quantity,avg_price)
      values(owner_id,new.market,new.stock_code,new.stock_name,new.broker,new.quantity,new.avg_price);
  end if;
  return row_value;
end;
$$;
revoke all on function private.track_manual_balance() from public,anon,authenticated;
create trigger manual_balance_history before insert or update or delete on public.holdings
  for each row execute function private.track_manual_balance();

create function public.validate_manual_trade(trade jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare qty numeric; price numeric;
begin
  if jsonb_typeof(trade)<>'object' or not(trade ?& array['request_id','market','stock_code','stock_name','broker','side','quantity','price','traded_on'])
    or (select count(*) from jsonb_object_keys(trade))<>9 then raise exception 'Invalid trade' using errcode='22023'; end if;
  perform (trade->>'request_id')::uuid;
  qty:=(trade->>'quantity')::numeric; price:=(trade->>'price')::numeric;
  if qty is null or price is null or not(qty>0 and qty<=1e8 and qty=round(qty,4))
    or not(price>0 and price<=1e12 and price=round(price,8))
    or (trade->>'traded_on')::date not between date '1900-01-01' and (now() at time zone 'Asia/Seoul')::date
    or trade->>'side' not in ('BUY','SELL') then raise exception 'Invalid trade values' using errcode='22023'; end if;
end;
$$;

create function public.rebuild_manual_portfolio(owner_id uuid) returns void
language plpgsql security invoker set search_path='' as $$
declare asset record; event record; qty numeric; avg numeric; basis numeric; label text; flag text;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  flag:=current_setting('app.manual_replay',true);
  perform set_config('app.manual_replay','on',true);
  for asset in
    select market,stock_code,broker from public.manual_baselines where user_id=owner_id
    union select market,stock_code,broker from public.manual_adjustments where user_id=owner_id
    union select market,stock_code,broker from public.manual_trades where user_id=owner_id
    union select market,stock_code,broker from public.holdings where user_id=owner_id and source='manual'
  loop
    select quantity,avg_price,stock_name into qty,avg,label from public.manual_baselines
      where user_id=owner_id and market=asset.market and stock_code=asset.stock_code and broker=asset.broker;
    qty:=coalesce(qty,0); avg:=coalesce(avg,0);
    for event in
      select id,'TRADE' as kind,side,quantity,price,traded_on as day,created_at,stock_name from public.manual_trades
        where user_id=owner_id and market=asset.market and stock_code=asset.stock_code and broker=asset.broker and not cancelled
      union all
      select id,'ADJUST','',quantity,avg_price,(created_at at time zone 'Asia/Seoul')::date,created_at,stock_name from public.manual_adjustments
        where user_id=owner_id and market=asset.market and stock_code=asset.stock_code and broker=asset.broker
      order by day,created_at,id
    loop
      label:=event.stock_name;
      if event.kind='ADJUST' then qty:=event.quantity; avg:=event.price;
      elsif event.side='BUY' then
        basis:=event.quantity*event.price;
        avg:=round((qty*avg+basis)/(qty+event.quantity),8); qty:=qty+event.quantity;
      else
        if event.quantity>qty then raise exception 'Correction causes negative historical balance' using errcode='22023'; end if;
        basis:=event.quantity*avg; qty:=qty-event.quantity;
        if qty=0 then avg:=0; end if;
      end if;
      if event.kind='TRADE' then
        update public.manual_trades set cost_basis=basis,realized_profit_loss=case when event.side='SELL' then event.quantity*event.price-basis end,
          quantity_after=qty,avg_price_after=avg where id=event.id;
      end if;
    end loop;
    if qty=0 then
      delete from public.holdings where user_id=owner_id and source='manual' and market=asset.market and stock_code=asset.stock_code and broker=asset.broker;
    else
      insert into public.holdings(user_id,market,stock_code,stock_name,broker,quantity,avg_price,source,account_type)
        values(owner_id,asset.market,asset.stock_code,label,asset.broker,qty,avg,'manual','manual')
        on conflict(user_id,source,market,stock_code,account_type,broker)
        do update set stock_name=excluded.stock_name,quantity=excluded.quantity,avg_price=excluded.avg_price
        where (holdings.stock_name,holdings.quantity,holdings.avg_price) is distinct from (excluded.stock_name,excluded.quantity,excluded.avg_price);
    end if;
  end loop;
  if (select count(*) from public.holdings where user_id=owner_id and source='manual')>50 then
    raise exception 'Holdings limit reached' using errcode='22023'; end if;
  perform set_config('app.manual_replay',coalesce(flag,''),true);
end;
$$;

create or replace function public.record_manual_trade(target_user_id uuid, trade jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior public.manual_trades%rowtype;
begin
  perform public.validate_manual_trade(trade);
  if target_user_id is null then raise exception 'Missing owner'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text,0));
  select * into prior from public.manual_trades where user_id=target_user_id and request_id=(trade->>'request_id')::uuid;
  if found then
    if prior.original_input is distinct from trade then raise exception 'Request ID already used' using errcode='22023'; end if;
    return to_jsonb(prior)-'user_id';
  end if;
  insert into public.manual_baselines(user_id,market,stock_code,stock_name,broker,quantity,avg_price)
    values(target_user_id,trade->>'market',trade->>'stock_code',trade->>'stock_name',trade->>'broker',0,0) on conflict do nothing;
  insert into public.manual_trades(user_id,request_id,market,stock_code,stock_name,broker,side,quantity,price,traded_on,
    cost_basis,quantity_after,avg_price_after,original_input)
    values(target_user_id,(trade->>'request_id')::uuid,trade->>'market',trade->>'stock_code',trade->>'stock_name',trade->>'broker',trade->>'side',
      (trade->>'quantity')::numeric,(trade->>'price')::numeric,(trade->>'traded_on')::date,0,0,0,trade) returning * into prior;
  perform public.rebuild_manual_portfolio(target_user_id);
  select * into prior from public.manual_trades where id=prior.id;
  return to_jsonb(prior)-'user_id';
end;
$$;

create function public.revise_manual_trade(target_user_id uuid, change jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior public.manual_trades%rowtype; revised public.manual_trades%rowtype; audit public.manual_trade_revisions%rowtype; input jsonb;
begin
  if jsonb_typeof(change)<>'object' or (select count(*) from jsonb_object_keys(change))<>6
    or not(change ?& array['request_id','trade_id','expected_revision','trade','cancelled','reason'])
    or jsonb_typeof(change->'cancelled')<>'boolean' or char_length(btrim(change->>'reason')) not between 1 and 500 then
    raise exception 'Invalid correction' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text,0));
  select * into audit from public.manual_trade_revisions where user_id=target_user_id and request_id=(change->>'request_id')::uuid;
  if found then
    if audit.updated->'request' is distinct from change then raise exception 'Request ID already used' using errcode='22023'; end if;
    return audit.updated->'result';
  end if;
  select * into prior from public.manual_trades where user_id=target_user_id and id=(change->>'trade_id')::bigint for update;
  if not found or prior.revision<>(change->>'expected_revision')::integer then raise exception 'Trade changed; refresh before correcting' using errcode='22023'; end if;
  input:=(change->'trade') || jsonb_build_object('request_id',prior.request_id);
  perform public.validate_manual_trade(input);
  update public.manual_trades set market=input->>'market',stock_code=input->>'stock_code',stock_name=input->>'stock_name',broker=input->>'broker',
    side=input->>'side',quantity=(input->>'quantity')::numeric,price=(input->>'price')::numeric,traded_on=(input->>'traded_on')::date,
    cancelled=(change->>'cancelled')::boolean,revision=revision+1 where id=prior.id;
  perform public.rebuild_manual_portfolio(target_user_id);
  select * into revised from public.manual_trades where id=prior.id;
  insert into public.manual_trade_revisions(user_id,trade_id,request_id,previous,updated,reason)
    values(target_user_id,prior.id,(change->>'request_id')::uuid,to_jsonb(prior)-'user_id',
      jsonb_build_object('request',change,'result',to_jsonb(revised)-'user_id'),btrim(change->>'reason'));
  return to_jsonb(revised)-'user_id';
end;
$$;

create or replace function public.manual_trade_summary()
returns table(broker text,market text,sell_count bigint,profit_loss numeric,cost_basis numeric)
language sql stable security invoker set search_path='' as $$
  select broker,market,count(*),sum(realized_profit_loss),sum(cost_basis)
  from public.manual_trades where user_id=(select auth.uid()) and side='SELL' and not cancelled group by broker,market;
$$;
revoke all on function public.validate_manual_trade(jsonb),public.rebuild_manual_portfolio(uuid),public.revise_manual_trade(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.validate_manual_trade(jsonb),public.rebuild_manual_portfolio(uuid),public.revise_manual_trade(uuid,jsonb) to service_role;

create table public.integration_sync_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  received_at timestamptz not null,
  holdings_count integer not null check(holdings_count>=0),
  accounts jsonb not null
);
alter table public.integration_sync_status enable row level security;
create policy integration_sync_status_own on public.integration_sync_status for select to authenticated using((select auth.uid())=user_id);
revoke all on public.integration_sync_status from public,anon,authenticated;
grant select on public.integration_sync_status to authenticated;
grant select,insert,update,delete on public.integration_sync_status to service_role;
alter function public.replace_synced_holdings(uuid,jsonb,jsonb) rename to replace_synced_holdings_data;
create function public.replace_synced_holdings(target_user_id uuid,snapshot jsonb,performance_snapshot jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare total integer;
begin
  total:=public.replace_synced_holdings_data(target_user_id,snapshot,performance_snapshot);
  insert into public.integration_sync_status(user_id,received_at,holdings_count,accounts)
    values(target_user_id,clock_timestamp(),total,(select coalesce(jsonb_agg(a),'[]'::jsonb) from (
      select x->>'broker' as broker,x->>'account_type' as account_type,count(*) as holdings_count
      from jsonb_array_elements(snapshot) x group by x->>'broker',x->>'account_type') a))
    on conflict(user_id) do update set received_at=excluded.received_at,holdings_count=excluded.holdings_count,accounts=excluded.accounts;
  return total;
end;
$$;
revoke all on function public.replace_synced_holdings(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.replace_synced_holdings(uuid,jsonb,jsonb) to service_role;
-- Preserve legacy callers' performance rows while recording their actual receipt too.
create or replace function public.replace_synced_holdings(target_user_id uuid,snapshot jsonb)
returns integer language plpgsql security invoker set search_path='' as $$
declare performance jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text,0));
  select coalesce(jsonb_agg(to_jsonb(p)-'user_id'),'[]'::jsonb) into performance from public.trading_performance p where user_id=target_user_id;
  return public.replace_synced_holdings(target_user_id,snapshot,performance);
end;
$$;
notify pgrst,'reload schema';
commit;
