-- Additive account observations. Never replaces holdings or deletes omitted history.
begin;

create table public.account_equity_points (
  user_id uuid not null references auth.users(id) on delete cascade,
  account_ref uuid not null,
  broker text not null check (broker in ('KIWOOM','KIS')),
  account_type text not null check (account_type in ('paper','live')),
  currency text not null check (currency in ('KRW','USD')),
  scope text not null check (scope in ('overseas','account-total-assets')),
  date date not null,
  collected_at timestamptz not null,
  calculated_at timestamptz not null check (calculated_at >= collected_at),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default clock_timestamp(),
  primary key (user_id, account_ref, broker, account_type, currency, scope, date),
  check (date = (collected_at at time zone 'Asia/Seoul')::date)
);
alter table public.account_equity_points enable row level security;
create policy account_equity_select_own on public.account_equity_points
  for select to authenticated using ((select auth.uid()) = user_id);
revoke all on public.account_equity_points from public, anon, authenticated, service_role;
grant select on public.account_equity_points to authenticated;
grant select, insert, update on public.account_equity_points to service_role;

create function public.sync_account_equity(token_hash text, records jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid;
  item jsonb;
  field text;
  previous public.account_equity_points%rowtype;
  changed integer;
  synced integer := 0;
  required_keys text[] := array['account_ref','broker','account_type','currency','scope',
    'date_timezone','return_method','return_base_at','date','valued_at','collected_at',
    'calculated_at','equity','cash','stock_value','return_index','return_status','source'];
begin
  -- ponytail: serialize a member's batches via the existing token row; per-series locks if write volume grows.
  select t.user_id into owner_id from public.integration_tokens t
    where t.token_hash = sync_account_equity.token_hash for update;
  if owner_id is null then raise sqlstate 'PT401' using message = 'invalid integration token'; end if;
  if records is null or jsonb_typeof(records) <> 'array' then
    raise sqlstate 'PT400' using message = 'invalid account observations';
  end if;
  if jsonb_array_length(records) > 500 or octet_length(records::text) > 1048576 then
    raise sqlstate 'PT400' using message = 'account observations too large';
  end if;
  for item in select value from jsonb_array_elements(records) loop
    if jsonb_typeof(item) <> 'object' or not (item ?& required_keys)
      or (select count(*) from jsonb_object_keys(item)) <> cardinality(required_keys)
      or item->>'date_timezone' is distinct from 'Asia/Seoul'
      or item->>'account_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or item->>'return_status' not in ('verified','insufficient_samples','cash_flows_unverified','scope_unverified','invalid_data')
      or item->>'source' is distinct from (case when item->>'broker' = 'KIWOOM' then 'KIWOOM_US_EQUITY' else 'KIS_ACCOUNT_EQUITY' end)
    then raise sqlstate 'PT400' using message = 'invalid account observation'; end if;
    foreach field in array array['account_ref','broker','account_type','currency','scope','date_timezone','date','collected_at','calculated_at','return_status','source'] loop
      if jsonb_typeof(item->field) <> 'string' then
        raise sqlstate 'PT400' using message = 'invalid observation field';
      end if;
    end loop;
    foreach field in array array['equity','cash','stock_value','return_index'] loop
      if item->field <> 'null'::jsonb and (jsonb_typeof(item->field) <> 'string'
        or item->>field !~ '^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$'
        or (field <> 'cash' and left(item->>field,1) = '-')) then
        raise sqlstate 'PT400' using message = 'invalid observation amount';
      end if;
    end loop;
    if not ((item->'return_method' = 'null'::jsonb and item->'return_base_at' = 'null'::jsonb)
      or (item->>'return_method' = 'daily-sampled-linked-modified-dietz' and jsonb_typeof(item->'return_base_at') = 'string'))
      or (item->>'return_status' = 'verified' and (item->'equity' = 'null'::jsonb or item->'return_index' = 'null'::jsonb or item->'return_method' = 'null'::jsonb))
      or (item->>'return_status' <> 'verified' and item->'return_index' <> 'null'::jsonb)
      or (item->>'collected_at')::timestamptz > now() + interval '5 minutes'
      or (item->>'calculated_at')::timestamptz > now() + interval '5 minutes'
      or (item->>'valued_at')::timestamptz > (item->>'collected_at')::timestamptz
      or (item->>'return_base_at')::timestamptz > (item->>'collected_at')::timestamptz
    then raise sqlstate 'PT400' using message = 'invalid observation basis or time'; end if;

    select * into previous from public.account_equity_points p where p.user_id = owner_id
      and p.account_ref = (item->>'account_ref')::uuid and p.broker = item->>'broker'
      and p.account_type = item->>'account_type' and p.currency = item->>'currency'
      and p.scope = item->>'scope' and p.date = (item->>'date')::date;
    if found and previous.collected_at = (item->>'collected_at')::timestamptz
      and previous.calculated_at = (item->>'calculated_at')::timestamptz and previous.payload <> item then
      raise sqlstate 'PT409' using message = 'conflicting observation revision';
    end if;
    insert into public.account_equity_points(user_id,account_ref,broker,account_type,currency,scope,date,collected_at,calculated_at,payload)
    values(owner_id,(item->>'account_ref')::uuid,item->>'broker',item->>'account_type',item->>'currency',item->>'scope',
      (item->>'date')::date,(item->>'collected_at')::timestamptz,(item->>'calculated_at')::timestamptz,item)
    on conflict (user_id,account_ref,broker,account_type,currency,scope,date) do update
      set collected_at = excluded.collected_at, calculated_at = excluded.calculated_at,
        payload = excluded.payload, received_at = clock_timestamp()
      where (excluded.collected_at,excluded.calculated_at) > (account_equity_points.collected_at,account_equity_points.calculated_at);
    get diagnostics changed = row_count;
    synced := synced + changed;
  end loop;
  return synced;
end;
$$;
revoke all on function public.sync_account_equity(text,jsonb) from public, anon, authenticated;
grant execute on function public.sync_account_equity(text,jsonb) to service_role;

-- SECURITY INVOKER retains the member's RLS; the explicit predicate also applies if called by a privileged role.
create function public.account_equity_series() returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(latest.payload || jsonb_build_object('received_at',latest.received_at)), '[]'::jsonb)
  from (
    select distinct on (account_ref,broker,account_type,currency,scope) payload,received_at
    from public.account_equity_points where user_id = (select auth.uid())
    order by account_ref,broker,account_type,currency,scope,date desc
  ) latest;
$$;
revoke all on function public.account_equity_series() from public, anon, authenticated, service_role;
grant execute on function public.account_equity_series() to authenticated;
notify pgrst, 'reload schema';
commit;
