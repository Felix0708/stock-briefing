-- Preserve last-known diagnostic; contradictory same-clock arrivals are not success.
begin;
create or replace function public.sync_account_status(token_hash text, records jsonb) returns integer
language plpgsql security invoker set search_path='' as $$
declare owner_id uuid; item jsonb; changed integer; synced integer:=0; observed timestamptz;
begin
  select t.user_id into owner_id from public.integration_tokens t where t.token_hash=sync_account_status.token_hash for update;
  if owner_id is null then raise sqlstate 'PT401' using message='invalid integration token'; end if;
  if records is null or jsonb_typeof(records)<>'array' then raise sqlstate 'PT400' using message='invalid statuses'; end if;
  if jsonb_array_length(records)>20 or octet_length(records::text)>16384 then raise sqlstate 'PT400' using message='too many statuses'; end if;
  if exists(select 1 from jsonb_array_elements(records) r group by r->>'account_ref',r->>'broker',r->>'account_type' having count(*)>1)
    then raise sqlstate 'PT400' using message='duplicate account status'; end if;
  for item in select value from jsonb_array_elements(records) loop
    if jsonb_typeof(item)<>'object' then raise sqlstate 'PT400' using message='invalid status'; end if;
    if not (item ?& array['account_ref','broker','account_type','checked_at','code'])
      or (select count(*) from jsonb_object_keys(item))<>5
      or exists(select 1 from jsonb_each(item) v where jsonb_typeof(v.value)<>'string')
      or item->>'account_ref' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or item->>'broker' not in ('KIWOOM','KIS') or item->>'account_type' not in ('paper','live')
      or item->>'code' not in ('total_verified','other_currency_assets','total_unverified','collection_failed')
    then raise sqlstate 'PT400' using message='invalid status'; end if;
    begin observed:=(item->>'checked_at')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise sqlstate 'PT400' using message='invalid status timestamp';
    end;
    if not isfinite(observed) or observed>now()+interval '5 minutes' then
      raise sqlstate 'PT400' using message='invalid status timestamp';
    end if;
    if exists(select 1 from public.account_collection_status s
      where s.user_id=owner_id and s.account_ref=(item->>'account_ref')::uuid
        and s.broker=item->>'broker' and s.account_type=item->>'account_type'
        and s.checked_at=observed and s.code<>item->>'code') then
      raise sqlstate 'PT409' using message='conflicting status at same timestamp';
    end if;
    insert into public.account_collection_status(user_id,account_ref,broker,account_type,checked_at,code)
    values(owner_id,(item->>'account_ref')::uuid,item->>'broker',item->>'account_type',observed,item->>'code')
    on conflict(user_id,account_ref,broker,account_type) do update
      set checked_at=excluded.checked_at,code=excluded.code
      where excluded.checked_at>account_collection_status.checked_at;
    get diagnostics changed=row_count; synced:=synced+changed;
  end loop;
  return synced;
end;
$$;
revoke all on function public.sync_account_status(text,jsonb) from public,anon,authenticated;
grant execute on function public.sync_account_status(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
