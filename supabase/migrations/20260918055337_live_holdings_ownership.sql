begin;

-- Reuse the existing account-keyed manual ledger: ISA keys never collide with general accounts.
alter table public.holdings drop constraint holdings_broker_check;
alter table public.holdings drop constraint holdings_source_account_broker_check;
alter table public.holdings add constraint holdings_broker_check check(broker in
 ('MANUAL','KIWOOM','KIS','KIWOOM_ISA','KIS_ISA','MIRAE','NH','SAMSUNG','KB','SHINHAN','TOSS','KAKAOPAY','DAISHIN','OTHER','LEGACY'));
alter table public.holdings add constraint holdings_source_account_broker_check check(
 (source='manual' and account_type='manual' and broker<>'LEGACY') or
 (source='stock_trading' and account_type in ('paper','live') and broker in ('KIWOOM','KIS','LEGACY')));
alter table public.holdings add constraint holdings_isa_market_check check(broker not in ('KIWOOM_ISA','KIS_ISA') or market='KR');
alter table public.manual_trades drop constraint manual_trades_broker_check;
alter table public.manual_trades add constraint manual_trades_broker_check check(broker in
 ('MANUAL','KIWOOM','KIS','KIWOOM_ISA','KIS_ISA','MIRAE','NH','SAMSUNG','KB','SHINHAN','TOSS','KAKAOPAY','DAISHIN','OTHER'));
alter table public.manual_trades add constraint manual_trades_isa_market_check check(broker not in ('KIWOOM_ISA','KIS_ISA') or market='KR');

alter table public.account_collection_status drop constraint account_collection_status_code_check;
alter table public.account_collection_status add constraint account_collection_status_code_check
 check(code in ('total_verified','other_currency_assets','total_unverified','collection_failed','ip_not_registered'));
do $$ begin
 execute replace(pg_get_functiondef('public.sync_account_status(text,jsonb)'::regprocedure),
   '''total_unverified'',''collection_failed''','''total_unverified'',''collection_failed'',''ip_not_registered''');
end $$;

-- Complete latest snapshots are isolated from the trading process's replacement endpoint.
create table public.broker_holdings (
 user_id uuid not null references auth.users(id) on delete cascade,
 broker text not null check(broker in ('KIWOOM','KIS')),
 account_kind text not null check(account_kind in ('general','isa')),
 market text not null check(market in ('KR','US')),
 collected_at timestamptz not null,
 holdings jsonb not null check(jsonb_typeof(holdings)='array'),
 primary key(user_id,broker,account_kind,market),
 check(account_kind<>'isa' or market='KR')
);
alter table public.broker_holdings enable row level security;
revoke all on public.broker_holdings from public,anon,authenticated;
grant select on public.broker_holdings to authenticated;
grant select,insert,update,delete on public.broker_holdings to service_role;
create policy broker_holdings_own on public.broker_holdings for select to authenticated using((select auth.uid())=user_id);

create function public.sync_broker_holdings(token_hash text, snapshots jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare owner_id uuid; s jsonb; r jsonb; total integer:=0; changed integer; observed timestamptz;
begin
 select user_id into owner_id from public.integration_tokens t where t.token_hash=sync_broker_holdings.token_hash for update;
 if owner_id is null then raise sqlstate 'PT401' using message='invalid token'; end if;
 if snapshots is null or jsonb_typeof(snapshots)<>'array' then raise sqlstate 'PT400' using message='invalid snapshots'; end if;
 if jsonb_array_length(snapshots)>6 or octet_length(snapshots::text)>262144 then raise sqlstate 'PT400' using message='snapshot limit'; end if;
 if exists(select 1 from jsonb_array_elements(snapshots) x group by x->>'broker',x->>'account_kind',x->>'market' having count(*)>1)
 then raise sqlstate 'PT400' using message='duplicate scope'; end if;
 for s in select value from jsonb_array_elements(snapshots) loop
  if jsonb_typeof(s)<>'object' or not(s ?& array['broker','account_kind','market','collected_at','holdings'])
   or (select count(*) from jsonb_object_keys(s))<>5
   or not coalesce(s->>'broker' in ('KIWOOM','KIS') and s->>'account_kind' in ('general','isa') and s->>'market' in ('KR','US'),false)
   or (s->>'account_kind'='isa' and s->>'market'<>'KR') or jsonb_typeof(s->'holdings')<>'array'
  then raise sqlstate 'PT400' using message='invalid scope'; end if;
  observed:=(s->>'collected_at')::timestamptz;
  if observed is null or not isfinite(observed) or observed>now()+interval '5 minutes' or jsonb_array_length(s->'holdings')>200
  then raise sqlstate 'PT400' using message='invalid observation'; end if;
  if exists(select 1 from jsonb_array_elements(s->'holdings') x group by x->>'stock_code' having count(*)>1)
  then raise sqlstate 'PT400' using message='duplicate holding'; end if;
  for r in select value from jsonb_array_elements(s->'holdings') loop
   if jsonb_typeof(r)<>'object' or not(r ?& array['stock_code','stock_name','quantity','avg_price','automated_quantity'])
    or (select count(*) from jsonb_object_keys(r))<>5
    or jsonb_typeof(r->'stock_code')<>'string' or jsonb_typeof(r->'stock_name')<>'string'
    or char_length(trim(r->>'stock_name')) not between 1 and 50
    or r->>'stock_code' !~ (case s->>'market' when 'KR' then '^[0-9]{6}$' else '^[A-Z][A-Z0-9.-]{0,9}$' end)
    or jsonb_typeof(r->'quantity')<>'number' or jsonb_typeof(r->'avg_price')<>'number'
    or not ((r->>'quantity')::numeric>0 and (r->>'quantity')::numeric<=1e12 and (r->>'avg_price')::numeric>0 and (r->>'avg_price')::numeric<=1e12)
    or not (r->'automated_quantity'='null'::jsonb or (jsonb_typeof(r->'automated_quantity')='number'
      and (r->>'automated_quantity')::numeric between 0 and (r->>'quantity')::numeric))
    or (s->>'account_kind'='isa' and r->'automated_quantity'<>'0'::jsonb)
   then raise sqlstate 'PT400' using message='invalid holding'; end if;
  end loop;
  if exists(select 1 from public.broker_holdings b where b.user_id=owner_id and b.broker=s->>'broker'
   and b.account_kind=s->>'account_kind' and b.market=s->>'market' and b.collected_at=observed and b.holdings<>s->'holdings')
  then raise sqlstate 'PT409' using message='conflicting snapshot'; end if;
  insert into public.broker_holdings values(owner_id,s->>'broker',s->>'account_kind',s->>'market',observed,s->'holdings')
  on conflict(user_id,broker,account_kind,market) do update set collected_at=excluded.collected_at,holdings=excluded.holdings
  where excluded.collected_at>broker_holdings.collected_at;
  get diagnostics changed=row_count; total:=total+changed;
 end loop;
 return total;
end $$;
revoke all on function public.sync_broker_holdings(text,jsonb) from public,anon,authenticated;
grant execute on function public.sync_broker_holdings(text,jsonb) to service_role;
-- The same effective holdings feed must reach morning briefings without duplicates.
create view public.briefing_holdings with (security_invoker=true) as
 select h.user_id,h.stock_code,h.stock_name,h.market,h.created_at from public.holdings h
 where h.account_type='paper' or not exists(select 1 from public.broker_holdings b where b.user_id=h.user_id
  and (case b.account_kind when 'isa' then b.broker||'_ISA' else b.broker end)=h.broker and b.market=h.market)
 union all
 select b.user_id,r->>'stock_code',r->>'stock_name',b.market,b.collected_at
 from public.broker_holdings b cross join lateral jsonb_array_elements(b.holdings) r;
revoke all on public.briefing_holdings from public,anon,authenticated;
grant select on public.briefing_holdings to authenticated,service_role;
notify pgrst,'reload schema';
commit;
