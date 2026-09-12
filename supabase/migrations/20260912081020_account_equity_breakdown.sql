-- Optional v1 breakdown metadata. Existing observations and identities are unchanged.
begin;

create or replace function public.sync_account_equity(token_hash text, records jsonb)
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  owner_id uuid;
  item jsonb;
  field text;
  detail jsonb;
  detail_keys text[] := array['status','domestic_stock_value_krw','us_stock_value_usd','us_stock_value_krw','cash_krw','usd_krw_rate','fx_source','observed_at','source','cash_scope'];
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
      or exists (select 1 from jsonb_object_keys(item) k where k <> all(required_keys || array['account_group_ref','breakdown']))
      or item->>'date_timezone' is distinct from 'Asia/Seoul'
      or item->>'account_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or item->>'return_status' not in ('verified','insufficient_samples','cash_flows_unverified','scope_unverified','invalid_data')
      or item->>'source' is distinct from (case
        when item->>'broker' = 'KIWOOM' and item->>'currency' = 'KRW' and item->>'scope' = 'domestic' then 'KIWOOM_KR_EQUITY'
        when item->>'broker' = 'KIWOOM' and item->>'currency' = 'USD' and item->>'scope' = 'overseas' then 'KIWOOM_US_EQUITY'
        when item->>'broker' = 'KIWOOM' and item->>'currency' = 'KRW' and item->>'scope' = 'account-total-assets' then 'KIWOOM_ACCOUNT_EQUITY'
        when item->>'broker' = 'KIS' and item->>'currency' = 'KRW' and item->>'scope' = 'account-total-assets' then 'KIS_ACCOUNT_EQUITY'
        else null end)
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

    if item ? 'account_group_ref' and (
      jsonb_typeof(item->'account_group_ref') is distinct from 'string'
      or item->>'account_group_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then raise sqlstate 'PT400' using message = 'invalid account group'; end if;

    if item ? 'breakdown' then
      detail := item->'breakdown';
      if jsonb_typeof(detail) is distinct from 'object' then
        raise sqlstate 'PT400' using message = 'invalid asset breakdown';
      end if;
      if not (detail ?& detail_keys) or (select count(*) from jsonb_object_keys(detail)) <> cardinality(detail_keys)
        or item->>'scope' is distinct from 'account-total-assets' or item->>'currency' is distinct from 'KRW'
        or item->'equity' = 'null'::jsonb or detail->>'status' is distinct from 'verified'
        or detail->>'source' is distinct from (case item->>'broker' when 'KIWOOM' then 'KIWOOM_LINKED_V1' else 'KIS_RECONCILED_V1' end)
        or detail->>'fx_source' is distinct from (case item->>'broker' when 'KIWOOM' then 'KIWOOM_USD_SELL' else 'KIS_USD_FIRST' end)
        or not coalesce(case item->>'broker' when 'KIWOOM' then detail->>'cash_scope' in ('same-account','separate-accounts')
            else detail->>'cash_scope' = 'account' end, false)
      then raise sqlstate 'PT400' using message = 'invalid asset breakdown source'; end if;
      foreach field in array detail_keys loop
        if jsonb_typeof(detail->field) is distinct from 'string' then
          raise sqlstate 'PT400' using message = 'invalid asset breakdown field';
        end if;
      end loop;
      foreach field in array array['domestic_stock_value_krw','us_stock_value_usd','us_stock_value_krw','cash_krw','usd_krw_rate'] loop
        if detail->>field !~ '^-?(0|[1-9][0-9]{0,15})(\.[0-9]{1,8})?$'
          or (field <> 'cash_krw' and left(detail->>field,1) = '-') then
          raise sqlstate 'PT400' using message = 'invalid asset breakdown amount';
        end if;
      end loop;
      if detail->>'observed_at' !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,3})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$' then
        raise sqlstate 'PT400' using message = 'invalid asset breakdown time';
      end if;
      if (detail->>'usd_krw_rate')::numeric <= 0
        or (detail->>'observed_at')::timestamptz > (item->>'collected_at')::timestamptz
        or (detail->>'observed_at')::timestamptz < (item->>'collected_at')::timestamptz - interval '120 seconds'
        or abs((detail->>'domestic_stock_value_krw')::numeric + (detail->>'us_stock_value_krw')::numeric
          + (detail->>'cash_krw')::numeric - (item->>'equity')::numeric) > 2
        or abs((detail->>'us_stock_value_usd')::numeric * (detail->>'usd_krw_rate')::numeric
          - (detail->>'us_stock_value_krw')::numeric) > 2
        or (item->'cash' <> 'null'::jsonb and abs((item->>'cash')::numeric - (detail->>'cash_krw')::numeric) > 2)
        or (item->'stock_value' <> 'null'::jsonb and abs((item->>'stock_value')::numeric
          - (detail->>'domestic_stock_value_krw')::numeric - (detail->>'us_stock_value_krw')::numeric) > 2)
      then raise sqlstate 'PT400' using message = 'asset breakdown reconciliation failed'; end if;
    end if;

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
notify pgrst, 'reload schema';
commit;
