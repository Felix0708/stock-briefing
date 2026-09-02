-- Phase 6: Stock-Trading 자동매매 누적 성과 스냅샷
-- 선행: db/schema_phase5.sql
-- 실행: Supabase SQL Editor에서 이 파일 전체를 한 번 실행

begin;

create table if not exists public.trading_performance (
  user_id uuid not null references auth.users (id) on delete cascade,
  broker text not null check (broker in ('KIWOOM', 'KIS')),
  account_type text not null check (account_type in ('paper', 'live')),
  all_count integer not null check (all_count >= 0),
  all_wins integer not null check (all_wins >= 0),
  all_losses integer not null check (all_losses >= 0),
  all_draws integer not null check (all_draws >= 0),
  all_win_rate numeric check (all_win_rate between 0 and 100),
  month_count integer not null check (month_count >= 0),
  month_wins integer not null check (month_wins >= 0),
  month_losses integer not null check (month_losses >= 0),
  month_draws integer not null check (month_draws >= 0),
  month_win_rate numeric check (month_win_rate between 0 and 100),
  realized_krw_count integer not null check (realized_krw_count >= 0),
  realized_krw_profit_loss numeric not null,
  realized_krw_return_rate numeric,
  realized_usd_count integer not null check (realized_usd_count >= 0),
  realized_usd_profit_loss numeric not null,
  realized_usd_return_rate numeric,
  excluded_full_exits integer not null check (excluded_full_exits >= 0),
  updated_at timestamptz not null,
  primary key (user_id, broker, account_type),
  check (all_count = all_wins + all_losses + all_draws),
  check (month_count = month_wins + month_losses + month_draws),
  check (
    (all_wins + all_losses = 0 and all_win_rate is null)
    or (all_wins + all_losses > 0 and all_win_rate is not null)
  ),
  check (
    (month_wins + month_losses = 0 and month_win_rate is null)
    or (month_wins + month_losses > 0 and month_win_rate is not null)
  ),
  check (
    (realized_krw_count = 0 and realized_krw_profit_loss = 0 and realized_krw_return_rate is null)
    or (realized_krw_count > 0 and realized_krw_return_rate is not null)
  ),
  check (
    (realized_usd_count = 0 and realized_usd_profit_loss = 0 and realized_usd_return_rate is null)
    or (realized_usd_count > 0 and realized_usd_return_rate is not null)
  )
);

alter table public.trading_performance enable row level security;

drop policy if exists "trading_performance_select_own" on public.trading_performance;
create policy "trading_performance_select_own" on public.trading_performance
  for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on table public.trading_performance from public, anon, authenticated;
grant select on table public.trading_performance to authenticated;
grant select, insert, update, delete on table public.trading_performance to service_role;

drop function if exists public.replace_synced_holdings(uuid, jsonb);

-- 보유종목과 집계 성과는 같은 잠금/트랜잭션에서 회원별 최신 스냅샷으로 교체한다.
create or replace function public.replace_synced_holdings(
  target_user_id uuid,
  snapshot jsonb,
  performance_snapshot jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if target_user_id is null
     or snapshot is null or jsonb_typeof(snapshot) <> 'array'
     or performance_snapshot is null or jsonb_typeof(performance_snapshot) <> 'array' then
    raise exception 'invalid sync snapshot';
  end if;
  if jsonb_array_length(snapshot) > 50 then
    raise exception 'holdings snapshot exceeds 50 rows';
  end if;
  if jsonb_array_length(performance_snapshot) > 4 then
    raise exception 'performance snapshot exceeds 4 rows';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(snapshot) as x(
      market text, stock_code text, stock_name text,
      quantity numeric, avg_price numeric, account_type text, broker text
    )
    group by x.market, x.stock_code, x.account_type, x.broker
    having count(*) > 1
  ) then
    raise exception 'duplicate holding in snapshot';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(performance_snapshot) as x(broker text, account_type text)
    group by x.broker, x.account_type
    having count(*) > 1
  ) then
    raise exception 'duplicate performance in snapshot';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));

  delete from public.holdings
  where user_id = target_user_id
    and source = 'stock_trading';

  insert into public.holdings (
    user_id, stock_code, stock_name, quantity, avg_price,
    market, source, account_type, broker
  )
  select
    target_user_id, x.stock_code, x.stock_name, x.quantity, x.avg_price,
    x.market, 'stock_trading', x.account_type, x.broker
  from jsonb_to_recordset(snapshot) as x(
    market text, stock_code text, stock_name text,
    quantity numeric, avg_price numeric, account_type text, broker text
  );

  get diagnostics inserted_count = row_count;

  delete from public.trading_performance
  where user_id = target_user_id;

  insert into public.trading_performance (
    user_id, broker, account_type,
    all_count, all_wins, all_losses, all_draws, all_win_rate,
    month_count, month_wins, month_losses, month_draws, month_win_rate,
    realized_krw_count, realized_krw_profit_loss, realized_krw_return_rate,
    realized_usd_count, realized_usd_profit_loss, realized_usd_return_rate,
    excluded_full_exits, updated_at
  )
  select
    target_user_id, x.broker, x.account_type,
    (x."all"->>'count')::integer,
    (x."all"->>'wins')::integer,
    (x."all"->>'losses')::integer,
    (x."all"->>'draws')::integer,
    (x."all"->>'win_rate')::numeric,
    (x.month->>'count')::integer,
    (x.month->>'wins')::integer,
    (x.month->>'losses')::integer,
    (x.month->>'draws')::integer,
    (x.month->>'win_rate')::numeric,
    (x.realized->'KRW'->>'count')::integer,
    (x.realized->'KRW'->>'profit_loss')::numeric,
    (x.realized->'KRW'->>'return_rate')::numeric,
    (x.realized->'USD'->>'count')::integer,
    (x.realized->'USD'->>'profit_loss')::numeric,
    (x.realized->'USD'->>'return_rate')::numeric,
    x.excluded_full_exits,
    x.updated_at
  from jsonb_to_recordset(performance_snapshot) as x(
    broker text,
    account_type text,
    "all" jsonb,
    month jsonb,
    realized jsonb,
    excluded_full_exits integer,
    updated_at timestamptz
  );

  return inserted_count;
end;
$$;

-- 롤링 배포 중인 기존 웹 서버만 사용하는 서버 전용 호환 RPC.
-- 새 공개 API는 performance 필수 계약을 검증하며, 송신기 전환 후 이 오버로드를 제거할 수 있다.
create or replace function public.replace_synced_holdings(
  target_user_id uuid,
  snapshot jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  inserted_count integer;
begin
  if target_user_id is null or snapshot is null or jsonb_typeof(snapshot) <> 'array' then
    raise exception 'invalid holdings snapshot';
  end if;
  if jsonb_array_length(snapshot) > 50 then
    raise exception 'holdings snapshot exceeds 50 rows';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(snapshot) as x(
      market text, stock_code text, stock_name text,
      quantity numeric, avg_price numeric, account_type text, broker text
    )
    group by x.market, x.stock_code, x.account_type, x.broker
    having count(*) > 1
  ) then
    raise exception 'duplicate holding in snapshot';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_user_id::text, 0));

  delete from public.holdings
  where user_id = target_user_id
    and source = 'stock_trading';

  insert into public.holdings (
    user_id, stock_code, stock_name, quantity, avg_price,
    market, source, account_type, broker
  )
  select
    target_user_id, x.stock_code, x.stock_name, x.quantity, x.avg_price,
    x.market, 'stock_trading', x.account_type, x.broker
  from jsonb_to_recordset(snapshot) as x(
    market text, stock_code text, stock_name text,
    quantity numeric, avg_price numeric, account_type text, broker text
  );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$;

revoke all on function public.replace_synced_holdings(uuid, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_synced_holdings(uuid, jsonb, jsonb)
  to service_role;
revoke all on function public.replace_synced_holdings(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.replace_synced_holdings(uuid, jsonb)
  to service_role;

notify pgrst, 'reload schema';
commit;
