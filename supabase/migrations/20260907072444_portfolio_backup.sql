begin;

-- Backups contain account data, never API keys, login credentials or integration tokens.
create table public.portfolio_restore_points (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);
create index portfolio_restore_points_owner on public.portfolio_restore_points(user_id,created_at desc);
alter table public.portfolio_restore_points enable row level security;
revoke all on public.portfolio_restore_points from public,anon,authenticated;
grant select,insert on public.portfolio_restore_points to service_role;
grant usage,select,update on sequence public.holdings_id_seq,public.manual_adjustments_id_seq,public.manual_trades_id_seq,public.manual_trade_revisions_id_seq to service_role;

create function public.portfolio_snapshot(owner_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare result jsonb:='{}'; name text; rows jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  foreach name in array array['holdings','trading_performance','integration_sync_status','manual_baselines','manual_adjustments','manual_trades','manual_trade_revisions'] loop
    -- Preserve decimal precision through browser/Node JSON parsing: numeric columns become strings.
    execute format('select coalesce(jsonb_agg(row order by row::text),''[]''::jsonb) from
      (select (select jsonb_object_agg(key,case when jsonb_typeof(value)=''number'' then to_jsonb(value::text) else value end)
        from jsonb_each(to_jsonb(t))) as row from public.%I t where user_id=$1) s',name) into rows using owner_id;
    result:=result||jsonb_build_object(name,rows);
  end loop;
  return jsonb_build_object('format','stock-briefing.portfolio','version',1,'owner_id',owner_id,'data',result);
end;
$$;

create function public.export_portfolio(owner_id uuid, previous boolean default false) returns text
language plpgsql security invoker set search_path='' as $$
declare snapshot jsonb;
begin
  if previous then
    select p.snapshot into snapshot from public.portfolio_restore_points p where p.user_id=owner_id order by created_at desc limit 1;
    if snapshot is null then raise exception 'No restore point' using errcode='22023'; end if;
  else snapshot:=public.portfolio_snapshot(owner_id); end if;
  return (snapshot||jsonb_build_object('fingerprint',md5(snapshot::text),'exported_at',clock_timestamp()))::text;
end;
$$;

create function public.restore_portfolio(owner_id uuid, archive_text text, expected_fingerprint text, apply boolean default false) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare archive jsonb; current jsonb; name text; count_before integer; inserted integer; point_id uuid; projection jsonb; supplied jsonb;
begin
  if octet_length(archive_text)>20000000 then raise exception 'Backup exceeds 20 MB' using errcode='22023'; end if;
  archive:=archive_text::jsonb;
  if archive->>'format'<>'stock-briefing.portfolio' or archive->>'version'<>'1' or archive->>'owner_id' is distinct from owner_id::text
    or jsonb_typeof(archive->'data')<>'object' or (select count(*) from jsonb_object_keys(archive->'data'))<>7 then
    raise exception 'Invalid backup or owner' using errcode='22023'; end if;
  foreach name in array array['holdings','trading_performance','integration_sync_status','manual_baselines','manual_adjustments','manual_trades','manual_trade_revisions'] loop
    if jsonb_typeof(archive->'data'->name) is distinct from 'array' then raise exception 'Missing backup table' using errcode='22023'; end if;
    if exists(select 1 from jsonb_array_elements(archive->'data'->name) r where r->>'user_id' is distinct from owner_id::text) then
      raise exception 'Wrong row owner' using errcode='22023'; end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
  current:=public.portfolio_snapshot(owner_id);
  if md5(current::text) is distinct from expected_fingerprint then raise exception 'Portfolio changed; preview again' using errcode='22023'; end if;
  if not apply then
    return jsonb_build_object('holdings',jsonb_array_length(archive->'data'->'holdings'),'trades',jsonb_array_length(archive->'data'->'manual_trades'),
      'revisions',jsonb_array_length(archive->'data'->'manual_trade_revisions'),'fingerprint',expected_fingerprint);
  end if;
  insert into public.portfolio_restore_points(user_id,snapshot) values(owner_id,current) returning id into point_id;
  perform set_config('app.manual_replay','on',true);
  -- Deletions are scoped to the authenticated owner, inside this single transaction.
  foreach name in array array['manual_trade_revisions','manual_trades','manual_adjustments','manual_baselines','holdings','trading_performance','integration_sync_status'] loop
    execute format('delete from public.%I where user_id=$1',name) using owner_id;
  end loop;
  foreach name in array array['manual_baselines','manual_adjustments','manual_trades','manual_trade_revisions','holdings','trading_performance','integration_sync_status'] loop
    execute format('insert into public.%I overriding system value select * from jsonb_populate_recordset(null::public.%I,$1)',name,name)
      using archive->'data'->name;
    get diagnostics inserted=row_count;
    count_before:=jsonb_array_length(archive->'data'->name);
    if inserted<>count_before then raise exception 'Restore count mismatch'; end if;
  end loop;
  if exists(select 1 from public.manual_trade_revisions r left join public.manual_trades t on t.id=r.trade_id
    where r.user_id=owner_id and t.user_id is distinct from owner_id) then raise exception 'Invalid revision owner'; end if;
  if exists(select 1 from public.manual_trades where user_id=owner_id and (original_input is null or traded_on>(now() at time zone 'Asia/Seoul')::date)) then
    raise exception 'Invalid trade history'; end if;
  select coalesce(jsonb_agg(jsonb_build_array(market,stock_code,broker,stock_name,quantity,avg_price) order by market,stock_code,broker),'[]') into supplied
    from public.holdings where user_id=owner_id and source='manual';
  perform public.rebuild_manual_portfolio(owner_id);
  select coalesce(jsonb_agg(jsonb_build_array(market,stock_code,broker,stock_name,quantity,avg_price) order by market,stock_code,broker),'[]') into projection
    from public.holdings where user_id=owner_id and source='manual';
  if projection is distinct from supplied then raise exception 'Backup ledger and balance do not agree' using errcode='22023'; end if;
  -- Existing IDs are restored exactly. Advance identity sequences without moving them backwards.
  foreach name in array array['holdings','manual_adjustments','manual_trades','manual_trade_revisions'] loop
    execute format('select setval(pg_get_serial_sequence(''public.%I'',''id''),greatest((select coalesce(max(id),1) from public.%I),
      (select last_value from public.%I)),true)',name,name,name||'_id_seq');
  end loop;
  perform set_config('app.manual_replay','',true);
  return jsonb_build_object('ok',true,'restore_point',point_id);
end;
$$;
revoke all on function public.portfolio_snapshot(uuid),public.export_portfolio(uuid,boolean),public.restore_portfolio(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.portfolio_snapshot(uuid),public.export_portfolio(uuid,boolean),public.restore_portfolio(uuid,text,text,boolean) to service_role;
notify pgrst,'reload schema';
commit;
