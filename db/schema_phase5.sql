-- Phase 5: Stock-Trading 연동 토큰, 자동 보유종목 동기화, 공개 브리핑 동의
-- 선행: db/schema_phase3.sql, db/schema_phase4.sql
-- 실행: Supabase SQL Editor에서 이 파일 전체를 한 번 실행

begin;

alter table public.holdings
  add column if not exists source text not null default 'manual',
  add column if not exists account_type text not null default 'manual',
  add column if not exists broker text not null default 'MANUAL';

-- 기존 수동 행은 그대로 유지하고, 증권사 구분 없이 합쳐졌던 자동 행은
-- 다음 새 스냅샷이 원자 교체할 때까지 출처를 임의 추정하지 않는다.
update public.holdings
set broker = 'MANUAL'
where source = 'manual' and broker <> 'MANUAL';

update public.holdings
set broker = 'LEGACY'
where source = 'stock_trading' and broker = 'MANUAL';

alter table public.holdings
  drop constraint if exists holdings_user_id_stock_code_key,
  drop constraint if exists holdings_source_check,
  drop constraint if exists holdings_account_type_check,
  drop constraint if exists holdings_source_account_type_check,
  drop constraint if exists holdings_broker_check,
  drop constraint if exists holdings_source_account_broker_check,
  drop constraint if exists holdings_user_source_market_code_account_key,
  drop constraint if exists holdings_user_source_market_code_account_broker_key;

alter table public.holdings
  add constraint holdings_source_check
    check (source in ('manual', 'stock_trading')),
  add constraint holdings_account_type_check
    check (account_type in ('manual', 'paper', 'live')),
  add constraint holdings_broker_check
    check (broker in ('MANUAL', 'KIWOOM', 'KIS', 'LEGACY')),
  add constraint holdings_source_account_broker_check check (
    (source = 'manual' and account_type = 'manual' and broker = 'MANUAL') or
    (source = 'stock_trading' and account_type in ('paper', 'live')
      and broker in ('KIWOOM', 'KIS', 'LEGACY'))
  ),
  add constraint holdings_user_source_market_code_account_broker_key
    unique (user_id, source, market, stock_code, account_type, broker);

-- 기존 정책을 명시적 authenticated 역할과 캐시 가능한 auth.uid() 형태로 강화한다.
drop policy if exists "holdings_select_own" on public.holdings;
create policy "holdings_select_own" on public.holdings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "holdings_insert_own" on public.holdings;
create policy "holdings_insert_own" on public.holdings
  for insert to authenticated
  with check ((select auth.uid()) = user_id and source = 'manual');

drop policy if exists "holdings_update_own" on public.holdings;
create policy "holdings_update_own" on public.holdings
  for update to authenticated
  using ((select auth.uid()) = user_id and source = 'manual')
  with check ((select auth.uid()) = user_id and source = 'manual');

drop policy if exists "holdings_delete_own" on public.holdings;
create policy "holdings_delete_own" on public.holdings
  for delete to authenticated
  using ((select auth.uid()) = user_id and source = 'manual');

create table if not exists public.member_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  public_briefing_opt_in boolean not null default false
);

alter table public.member_settings enable row level security;

drop policy if exists "member_settings_select_own" on public.member_settings;
create policy "member_settings_select_own" on public.member_settings
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "member_settings_insert_own" on public.member_settings;
create policy "member_settings_insert_own" on public.member_settings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "member_settings_update_own" on public.member_settings;
create policy "member_settings_update_own" on public.member_settings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 원문 토큰은 저장하지 않는다. 브라우저 역할에는 해시 테이블 접근권한도 없다.
create table if not exists public.integration_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_hint text not null check (token_hint ~ '^[A-Za-z0-9_-]{6}$'),
  issued_at timestamptz not null default now()
);

alter table public.integration_tokens enable row level security;

drop policy if exists "integration_tokens_deny_browser" on public.integration_tokens;
create policy "integration_tokens_deny_browser" on public.integration_tokens
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

-- 전체 스냅샷 교체는 한 트랜잭션에서 해당 회원의 자동 동기화 행만 교체한다.
-- 호출권은 service_role에만 있어 target_user_id를 외부 사용자가 선택할 수 없다.
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

  -- 같은 증권사·계정 유형의 같은 종목은 스냅샷에 한 번만 올 수 있다.
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

revoke all on table public.integration_tokens from public, anon, authenticated;
grant select, insert, update, delete on table public.integration_tokens to service_role;

revoke all on table public.member_settings from public, anon, authenticated;
grant select, insert, update on table public.member_settings to authenticated;
grant select on table public.member_settings to service_role;

revoke all on function public.replace_synced_holdings(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_synced_holdings(uuid, jsonb) to service_role;

grant select, insert, update, delete on table public.holdings to service_role;

notify pgrst, 'reload schema';
commit;
