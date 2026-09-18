begin;
-- Recorded live sells only; display-currency P&L, not tax-basis KRW or a tax return.
create table public.recorded_tax_estimates (
  user_id uuid not null references auth.users(id) on delete cascade,
  broker text not null check (broker in ('KIWOOM','KIS')),
  year integer not null check (year between 2020 and 2100),
  market text not null check (market in ('US','JP')),
  sell_count integer not null check (sell_count between 0 and 1000000),
  missing_count integer not null check (missing_count between 0 and 1000000),
  profit_loss numeric not null check (profit_loss between -1000000000000 and 1000000000000),
  updated_at timestamptz not null,
  primary key (user_id,broker,year,market),
  check (sell_count > 0 or profit_loss = 0)
);
alter table public.recorded_tax_estimates enable row level security;
create policy recorded_tax_estimates_own on public.recorded_tax_estimates for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.recorded_tax_estimates from public,anon,authenticated;
grant select on public.recorded_tax_estimates to authenticated;
grant select,insert,update on public.recorded_tax_estimates to service_role;

create function public.sync_recorded_tax(token_hash text, records jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare owner_id uuid; n integer;
begin
  select t.user_id into owner_id from public.integration_tokens t where t.token_hash = sync_recorded_tax.token_hash;
  if owner_id is null then raise sqlstate 'PT401' using message = 'invalid token'; end if;
  if records is null or jsonb_typeof(records) <> 'array' or jsonb_array_length(records) > 4 then
    raise sqlstate 'PT400' using message = 'invalid records'; end if;
  if exists(select 1 from jsonb_array_elements(records) r where r->>'account_type' is distinct from 'live') then
    raise sqlstate 'PT400' using message = 'live accounts only'; end if;
  insert into public.recorded_tax_estimates as t(user_id,broker,year,market,sell_count,missing_count,profit_loss,updated_at)
    select owner_id,x.broker,x.year,x.market,x.sell_count,x.missing_count,x.profit_loss,x.updated_at
    from jsonb_to_recordset(records) x(broker text,year integer,market text,sell_count integer,missing_count integer,profit_loss numeric,updated_at timestamptz)
  on conflict(user_id,broker,year,market) do update set sell_count=excluded.sell_count,missing_count=excluded.missing_count,
    profit_loss=excluded.profit_loss,updated_at=excluded.updated_at where excluded.updated_at>t.updated_at;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke all on function public.sync_recorded_tax(text,jsonb) from public,anon,authenticated;
grant execute on function public.sync_recorded_tax(text,jsonb) to service_role;

create function public.recorded_tax_summary(target_year integer)
returns table(source text,broker text,market text,sell_count bigint,missing_count bigint,profit_loss numeric,updated_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select 'manual'::text,t.broker,t.market,count(*) filter(where t.realized_profit_loss is not null),
    count(*) filter(where t.realized_profit_loss is null),coalesce(sum(t.realized_profit_loss),0),max(t.created_at)
  from public.manual_trades t
  where t.user_id=(select auth.uid()) and not t.cancelled and t.side='SELL' and t.market in ('US','JP')
    and t.traded_on >= make_date(target_year,1,1) and t.traded_on < make_date(target_year+1,1,1)
  group by t.broker,t.market
  union all
  select 'stock_trading'::text,t.broker,t.market,t.sell_count::bigint,t.missing_count::bigint,t.profit_loss,t.updated_at
  from public.recorded_tax_estimates t where t.user_id=(select auth.uid()) and t.year=target_year;
$$;
revoke all on function public.recorded_tax_summary(integer) from public,anon;
grant execute on function public.recorded_tax_summary(integer) to authenticated;
notify pgrst,'reload schema';
commit;
