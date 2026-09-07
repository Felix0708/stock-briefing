begin;

-- Increase precision without changing any existing balances or creating synthetic trades.
alter table public.holdings alter column avg_price type numeric(22,8);

create table public.manual_trades (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  market text not null check (market in ('KR','US','JP')),
  stock_code text not null,
  stock_name text not null check (char_length(stock_name) between 1 and 50),
  broker text not null check (broker in ('MANUAL','KIWOOM','KIS','MIRAE','NH','SAMSUNG','KB','SHINHAN','TOSS','KAKAOPAY','DAISHIN','OTHER')),
  side text not null check (side in ('BUY','SELL')),
  quantity numeric(18,4) not null check (quantity > 0),
  price numeric(22,8) not null check (price > 0),
  cost_basis numeric not null check (cost_basis >= 0),
  realized_profit_loss numeric,
  quantity_after numeric(18,4) not null check (quantity_after >= 0),
  avg_price_after numeric(22,8) not null check (avg_price_after >= 0),
  traded_on date not null,
  created_at timestamptz not null default now(),
  unique (user_id, request_id),
  check ((market='KR' and stock_code ~ '^[0-9]{6}$') or
    (market='US' and stock_code ~ '^[A-Z][A-Z0-9.\-]{0,9}$') or
    (market='JP' and stock_code ~ '^[0-9A-Z]{4,5}$'))
);
create index manual_trades_user_history on public.manual_trades(user_id, id desc);
alter table public.manual_trades enable row level security;
create policy manual_trades_select_own on public.manual_trades for select to authenticated using ((select auth.uid())=user_id);
revoke all on public.manual_trades from public, anon, authenticated;
grant select on public.manual_trades to authenticated;
grant select, insert on public.manual_trades to service_role;
grant usage, select on sequence public.manual_trades_id_seq to service_role;

-- The server derives target_user_id from a verified session. Browser roles cannot call this RPC.
create function public.record_manual_trade(target_user_id uuid, trade jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  prior public.manual_trades%rowtype;
  position public.holdings%rowtype;
  request_key uuid;
  qty numeric;
  unit_price numeric;
  next_qty numeric;
  next_avg numeric;
  basis numeric;
begin
  if target_user_id is null or jsonb_typeof(trade) <> 'object' or
    (select count(*) from jsonb_object_keys(trade)) <> 9 or
    not (trade ?& array['request_id','market','stock_code','stock_name','broker','side','quantity','price','traded_on']) then
    raise exception 'Invalid trade' using errcode='22023';
  end if;
  request_key := (trade->>'request_id')::uuid;
  qty := (trade->>'quantity')::numeric;
  unit_price := (trade->>'price')::numeric;
  if request_key is null or qty is null or unit_price is null or
    not (qty > 0 and qty <= 100000000 and qty=round(qty,4)) or
    not (unit_price > 0 and unit_price <= 1000000000000 and unit_price=round(unit_price,8)) or
    (trade->>'traded_on')::date > (now() at time zone 'Asia/Seoul')::date or
    (trade->>'traded_on')::date < date '1900-01-01' then
    raise exception 'Invalid trade values' using errcode='22023';
  end if;
  -- Serialize manual trades per user, including two concurrent buys of a new position.
  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));
  select * into prior from public.manual_trades where user_id=target_user_id and request_id=request_key;
  if found then
    if prior.market is distinct from trade->>'market' or prior.stock_code is distinct from trade->>'stock_code' or
      prior.stock_name is distinct from trade->>'stock_name' or prior.broker is distinct from trade->>'broker' or
      prior.side is distinct from trade->>'side' or prior.quantity <> qty or prior.price <> unit_price or
      prior.traded_on is distinct from (trade->>'traded_on')::date then
      raise exception 'Request ID already used' using errcode='22023';
    end if;
    return to_jsonb(prior) - 'user_id';
  end if;
  select * into position from public.holdings where user_id=target_user_id and source='manual'
    and market=trade->>'market' and stock_code=trade->>'stock_code' and broker=trade->>'broker' for update;
  if trade->>'side'='SELL' then
    if position.id is null or qty > position.quantity then
      raise exception 'Not enough holdings' using errcode='22023';
    end if;
    next_qty := position.quantity - qty;
    next_avg := case when next_qty=0 then 0 else position.avg_price end;
    basis := qty * position.avg_price;
  elsif trade->>'side'='BUY' then
    if position.id is null and (select count(*) from public.holdings where user_id=target_user_id and source='manual') >= 50 then
      raise exception 'Holdings limit reached' using errcode='22023';
    end if;
    next_qty := coalesce(position.quantity,0) + qty;
    next_avg := round((coalesce(position.quantity * position.avg_price,0) + qty * unit_price) / next_qty, 8);
    basis := qty * unit_price;
  else
    raise exception 'Invalid side' using errcode='22023';
  end if;
  -- A constraint failure also rolls back the balance update: both writes are one transaction.
  insert into public.manual_trades(user_id,request_id,market,stock_code,stock_name,broker,side,quantity,price,cost_basis,
    realized_profit_loss,quantity_after,avg_price_after,traded_on)
  values(target_user_id,request_key,trade->>'market',trade->>'stock_code',trade->>'stock_name',trade->>'broker',trade->>'side',
    qty,unit_price,basis,case when trade->>'side'='SELL' then qty*unit_price-basis end,next_qty,next_avg,(trade->>'traded_on')::date)
  returning * into prior;
  if next_qty=0 then
    delete from public.holdings where id=position.id;
  elsif position.id is not null then
    update public.holdings set quantity=next_qty,avg_price=next_avg where id=position.id;
  else
    insert into public.holdings(user_id,market,stock_code,stock_name,broker,source,account_type,quantity,avg_price)
    values(target_user_id,trade->>'market',trade->>'stock_code',trade->>'stock_name',trade->>'broker','manual','manual',next_qty,next_avg);
  end if;
  return to_jsonb(prior) - 'user_id';
end;
$$;
revoke all on function public.record_manual_trade(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_manual_trade(uuid,jsonb) to service_role;

create function public.manual_trade_summary()
returns table(broker text, market text, sell_count bigint, profit_loss numeric, cost_basis numeric)
language sql stable security invoker set search_path='' as $$
  select broker,market,count(*),sum(realized_profit_loss),sum(cost_basis)
  from public.manual_trades where user_id=(select auth.uid()) and side='SELL' group by broker,market;
$$;
revoke all on function public.manual_trade_summary() from public,anon;
grant execute on function public.manual_trade_summary() to authenticated;

create table public.collection_status (
  market text not null check (market in ('KR','US','JP')),
  company text not null,
  stock_code text not null default '',
  status text not null check (status in ('success','empty','failed','unsupported','partial')),
  filing_count integer not null default 0 check (filing_count>=0),
  checked_at timestamptz not null,
  last_success_at timestamptz,
  primary key(market,company)
);
alter table public.collection_status enable row level security;
create policy collection_status_own_holdings on public.collection_status for select to authenticated using (
  exists(select 1 from public.holdings h where h.user_id=(select auth.uid()) and h.market=collection_status.market
    and (h.stock_name=collection_status.company or (collection_status.stock_code<>'' and h.stock_code=collection_status.stock_code)))
);
revoke all on public.collection_status from public,anon,authenticated;
grant select on public.collection_status to authenticated;
grant select,insert,update on public.collection_status to service_role;

create table public.briefing_deliveries (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null check(status in ('sent','no_filings','collection_failed','failed','disabled','limit_reached')),
  filing_count integer not null default 0 check(filing_count>=0),
  checked_at timestamptz not null,
  last_sent_at timestamptz
);
alter table public.briefing_deliveries enable row level security;
create policy briefing_deliveries_select_own on public.briefing_deliveries for select to authenticated using ((select auth.uid())=user_id);
revoke all on public.briefing_deliveries from public,anon,authenticated;
grant select on public.briefing_deliveries to authenticated;
grant select,insert,update on public.briefing_deliveries to service_role;

create table public.briefing_runs (
  id integer primary key check(id=1),
  status text not null check(status in ('running','success','partial','failed')),
  checked_at timestamptz not null,
  last_success_at timestamptz
);
alter table public.briefing_runs enable row level security;
create policy briefing_runs_read on public.briefing_runs for select to authenticated using(true);
revoke all on public.briefing_runs from public,anon,authenticated;
grant select on public.briefing_runs to authenticated;
grant select,insert,update on public.briefing_runs to service_role;
notify pgrst,'reload schema';
commit;
