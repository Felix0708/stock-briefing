begin;

-- Nullable: old snapshots must not look like a measured zero-sample evaluation.
create function public.valid_performance_evaluation(e jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare c jsonb; k text; v jsonb; n numeric; total numeric:=0; reasons numeric:=0;
  decided numeric; seen text[]:=array[]::text[]; cohort_key text;
begin
  if e is null then return true; end if;
  if jsonb_typeof(e)<>'object' or not (e ?& array['version','total_count','eligible_count','excluded_count','reason_counts','cohorts'])
    or e-array['version','total_count','eligible_count','excluded_count','reason_counts','cohorts']<>'{}'::jsonb
    or e->'version'<>'1'::jsonb then return false; end if;
  foreach k in array array['total_count','eligible_count','excluded_count'] loop
    if jsonb_typeof(e->k)<>'number' then return false; end if;
    n:=(e->>k)::numeric;
    if n<0 or n>2147483647 or n<>trunc(n) then return false; end if;
  end loop;
  if (e->>'total_count')::numeric<>(e->>'eligible_count')::numeric+(e->>'excluded_count')::numeric
    or jsonb_typeof(e->'reason_counts')<>'object' or jsonb_typeof(e->'cohorts')<>'array'
    or jsonb_array_length(e->'cohorts')>100 then return false; end if;
  for k,v in select * from jsonb_each(e->'reason_counts') loop
    if not(k=any(array['MOCK_SESSION_LIMIT','SYSTEM_INCIDENT','POLICY_CHANGE','DATA_INSUFFICIENT','EXECUTION_DELAY_UNATTRIBUTED','REVIEW_REQUIRED']))
      or jsonb_typeof(v)<>'number' then return false; end if;
    n:=v::numeric;
    if n<0 or n<>trunc(n) or n>(e->>'excluded_count')::numeric then return false; end if;
    reasons:=reasons+n;
  end loop;
  if reasons<(e->>'excluded_count')::numeric then return false; end if;
  for c in select * from jsonb_array_elements(e->'cohorts') loop
    if jsonb_typeof(c)<>'object' or not(c ?& array['policy_hash','currency','count','wins','losses','draws','win_rate','profit_loss','net_profit_loss','unknown_costs'])
      or c-array['policy_hash','currency','count','wins','losses','draws','win_rate','profit_loss','net_profit_loss','unknown_costs']<>'{}'::jsonb
      or jsonb_typeof(c->'policy_hash')<>'string' or c->>'policy_hash' !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(c->'currency')<>'string' or c->>'currency' not in ('USD','KRW') then return false; end if;
    foreach k in array array['count','wins','losses','draws','unknown_costs'] loop
      if jsonb_typeof(c->k)<>'number' then return false; end if;
      n:=(c->>k)::numeric;
      if n<0 or n>2147483647 or n<>trunc(n) then return false; end if;
    end loop;
    if (c->>'count')::numeric=0 or (c->>'count')::numeric<>(c->>'wins')::numeric+(c->>'losses')::numeric+(c->>'draws')::numeric
      or (c->>'unknown_costs')::numeric>(c->>'count')::numeric then return false; end if;
    if jsonb_typeof(c->'profit_loss')<>'number' or abs((c->>'profit_loss')::numeric)>1e15 then return false; end if;
    if (c->>'unknown_costs')::numeric>0 then
      if c->'net_profit_loss'<>'null'::jsonb then return false; end if;
    elsif jsonb_typeof(c->'net_profit_loss')<>'number' or abs((c->>'net_profit_loss')::numeric)>1e15 then return false;
    end if;
    decided:=(c->>'wins')::numeric+(c->>'losses')::numeric;
    if decided=0 then
      if c->'win_rate'<>'null'::jsonb then return false; end if;
    elsif jsonb_typeof(c->'win_rate')<>'number' or (c->>'win_rate')::numeric not between 0 and 100
      or abs((c->>'win_rate')::numeric-100*(c->>'wins')::numeric/decided)>0.011 then return false;
    end if;
    cohort_key:=(c->>'policy_hash')||':'||(c->>'currency');
    if cohort_key=any(seen) then return false; end if;
    seen:=array_append(seen,cohort_key); total:=total+(c->>'count')::numeric;
  end loop;
  return total=(e->>'eligible_count')::numeric;
exception when others then return false;
end;
$$;
revoke all on function public.valid_performance_evaluation(jsonb) from public,anon,authenticated;
grant execute on function public.valid_performance_evaluation(jsonb) to service_role;

alter table public.trading_performance add column evaluation jsonb;
alter table public.trading_performance add constraint trading_performance_evaluation_valid check (
  public.valid_performance_evaluation(evaluation) and (evaluation is null or
    (account_type='paper' and (evaluation->>'total_count')::numeric=all_count))
);

-- Reuse the current atomic replacement/receipt wrapper and its existing grants.
do $$
declare definition text; marker text:='total:=public.replace_synced_holdings_data(target_user_id,snapshot,performance_snapshot);';
begin
  definition:=pg_get_functiondef('public.replace_synced_holdings(uuid,jsonb,jsonb)'::regprocedure);
  if strpos(definition,marker)=0 then raise exception 'sync wrapper changed; review migration'; end if;
  definition:=replace(definition,marker,marker||$patch$
  update public.trading_performance p set evaluation=nullif(x->'evaluation','null'::jsonb)
  from jsonb_array_elements(performance_snapshot) x
  where p.user_id=target_user_id and p.broker=x->>'broker' and p.account_type=x->>'account_type';
  $patch$);
  execute definition;
end;
$$;
notify pgrst,'reload schema';
commit;
