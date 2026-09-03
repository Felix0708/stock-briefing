-- db/schema.sql을 운영 Supabase에 적용한 직후 실행하는 보안·RPC 계약 검사.
-- 실행 예: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f db/verify_schema.sql

do $$
declare
  rpc regprocedure := to_regprocedure(
    'public.match_filings(extensions.vector,integer,text,double precision)'
  );
  sync_rpc regprocedure := to_regprocedure(
    'public.replace_synced_holdings(uuid,jsonb,jsonb)'
  );
  legacy_sync_rpc regprocedure := to_regprocedure(
    'public.replace_synced_holdings(uuid,jsonb)'
  );
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'filings'
      and c.relkind = 'r'
      and c.relrowsecurity
  ) then
    raise exception '검증 실패: public.filings RLS가 활성화되지 않았습니다.';
  end if;

  if rpc is null then
    raise exception '검증 실패: 4인자 public.match_filings RPC가 없습니다.';
  end if;

  if to_regprocedure('public.match_filings(extensions.vector,integer,text)') is not null then
    raise exception '검증 실패: 이전 3인자 public.match_filings RPC가 남아 있습니다.';
  end if;

  if has_function_privilege('anon', rpc, 'EXECUTE')
     or has_function_privilege('authenticated', rpc, 'EXECUTE') then
    raise exception '검증 실패: 브라우저 역할이 match_filings를 실행할 수 있습니다.';
  end if;

  if not has_function_privilege('service_role', rpc, 'EXECUTE') then
    raise exception '검증 실패: service_role에 match_filings EXECUTE 권한이 없습니다.';
  end if;

  if has_table_privilege(
       'anon',
       'public.filings',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     )
     or has_table_privilege(
       'authenticated',
       'public.filings',
       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
     ) then
    raise exception '검증 실패: 브라우저 역할에 filings 직접 접근 권한이 있습니다.';
  end if;

  -- has_table_privilege의 쉼표 목록은 권한 중 하나만 있어도 참일 수 있으므로
  -- 서버 역할의 필수 권한은 각각 검사한다.
  if not has_table_privilege('service_role', 'public.filings', 'SELECT')
     or not has_table_privilege('service_role', 'public.filings', 'INSERT')
     or not has_table_privilege('service_role', 'public.filings', 'UPDATE') then
    raise exception '검증 실패: service_role의 filings 읽기/쓰기 권한이 부족합니다.';
  end if;

  if has_sequence_privilege('anon', 'public.filings_id_seq', 'USAGE,SELECT,UPDATE')
     or has_sequence_privilege(
       'authenticated',
       'public.filings_id_seq',
       'USAGE,SELECT,UPDATE'
     ) then
    raise exception '검증 실패: 브라우저 역할에 filings 시퀀스 권한이 있습니다.';
  end if;

  if not has_sequence_privilege('service_role', 'public.filings_id_seq', 'USAGE')
     or not has_sequence_privilege('service_role', 'public.filings_id_seq', 'SELECT') then
    raise exception '검증 실패: service_role의 filings 시퀀스 권한이 부족합니다.';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = rpc
      and (prosecdef or not ('search_path=""' = any(coalesce(proconfig, '{}'))))
  ) then
    raise exception '검증 실패: match_filings는 SECURITY INVOKER와 빈 search_path여야 합니다.';
  end if;

  if not exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'vector'
      and n.nspname = 'extensions'
  ) then
    raise exception '검증 실패: vector 확장이 extensions 스키마에 없습니다.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'filings'
      and policyname = 'filings_deny_browser'
      and cmd = 'ALL'
      and roles @> array['anon', 'authenticated']::name[]
      and qual = 'false'
      and with_check = 'false'
  ) then
    raise exception '검증 실패: filings 브라우저 차단 정책이 없습니다.';
  end if;

  if to_regclass('public.integration_tokens') is null
     or to_regclass('public.member_settings') is null
     or to_regclass('public.trading_performance') is null
     or sync_rpc is null
     or legacy_sync_rpc is null then
    raise exception '검증 실패: Phase 5~6 연동 테이블/RPC가 없습니다.';
  end if;

  if not exists (
    select 1
    from pg_attribute
    where attrelid = 'public.holdings'::regclass
      and attname = 'broker'
      and not attisdropped
      and attnotnull
  ) then
    raise exception '검증 실패: holdings.broker 필수 열이 없습니다.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.holdings'::regclass
      and conname = 'holdings_user_source_market_code_account_broker_key'
      and contype = 'u'
      and convalidated
  ) then
    raise exception '검증 실패: holdings 증권사별 유니크 제약이 없습니다.';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.holdings'::regclass
      and conname = 'holdings_source_account_broker_check'
      and contype = 'c'
      and convalidated
      and position('MIRAE' in pg_get_constraintdef(oid)) > 0
      and position('OTHER' in pg_get_constraintdef(oid)) > 0
      and position('stock_trading' in pg_get_constraintdef(oid)) > 0
  ) then
    raise exception '검증 실패: 직접 등록 증권사와 자동매매 출처가 분리되지 않았습니다.';
  end if;

  if has_table_privilege('anon', 'public.integration_tokens', 'SELECT,INSERT,UPDATE,DELETE')
     or has_table_privilege('authenticated', 'public.integration_tokens', 'SELECT,INSERT,UPDATE,DELETE') then
    raise exception '검증 실패: 브라우저 역할이 integration_tokens에 접근할 수 있습니다.';
  end if;

  if not has_table_privilege('service_role', 'public.integration_tokens', 'SELECT')
     or not has_table_privilege('service_role', 'public.integration_tokens', 'INSERT')
     or not has_table_privilege('service_role', 'public.integration_tokens', 'UPDATE')
     or not has_table_privilege('service_role', 'public.integration_tokens', 'DELETE') then
    raise exception '검증 실패: service_role의 integration_tokens 권한이 부족합니다.';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'integration_tokens'
      and policyname = 'integration_tokens_deny_browser'
      and cmd = 'ALL'
      and roles @> array['anon', 'authenticated']::name[]
      and qual = 'false'
      and with_check = 'false'
  ) then
    raise exception '검증 실패: integration_tokens 브라우저 차단 정책이 없습니다.';
  end if;

  if has_table_privilege('anon', 'public.member_settings', 'SELECT,INSERT,UPDATE,DELETE')
     or not has_table_privilege('authenticated', 'public.member_settings', 'SELECT')
     or not has_table_privilege('authenticated', 'public.member_settings', 'INSERT')
     or not has_table_privilege('authenticated', 'public.member_settings', 'UPDATE')
     or has_table_privilege('authenticated', 'public.member_settings', 'DELETE,TRUNCATE,REFERENCES,TRIGGER') then
    raise exception '검증 실패: member_settings 역할별 권한이 안전하지 않습니다.';
  end if;

  if has_function_privilege('anon', sync_rpc, 'EXECUTE')
     or has_function_privilege('authenticated', sync_rpc, 'EXECUTE')
     or not has_function_privilege('service_role', sync_rpc, 'EXECUTE') then
    raise exception '검증 실패: replace_synced_holdings 실행 권한이 안전하지 않습니다.';
  end if;

  if has_function_privilege('anon', legacy_sync_rpc, 'EXECUTE')
     or has_function_privilege('authenticated', legacy_sync_rpc, 'EXECUTE')
     or not has_function_privilege('service_role', legacy_sync_rpc, 'EXECUTE') then
    raise exception '검증 실패: 호환 replace_synced_holdings 실행 권한이 안전하지 않습니다.';
  end if;

  if has_table_privilege('anon', 'public.trading_performance', 'SELECT,INSERT,UPDATE,DELETE')
     or not has_table_privilege('authenticated', 'public.trading_performance', 'SELECT')
     or has_table_privilege('authenticated', 'public.trading_performance', 'INSERT')
     or has_table_privilege('authenticated', 'public.trading_performance', 'UPDATE')
     or has_table_privilege('authenticated', 'public.trading_performance', 'DELETE')
     or not has_table_privilege('service_role', 'public.trading_performance', 'SELECT')
     or not has_table_privilege('service_role', 'public.trading_performance', 'INSERT')
     or not has_table_privilege('service_role', 'public.trading_performance', 'UPDATE')
     or not has_table_privilege('service_role', 'public.trading_performance', 'DELETE') then
    raise exception '검증 실패: trading_performance 역할별 권한이 안전하지 않습니다.';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'trading_performance'
      and policyname = 'trading_performance_select_own'
      and cmd = 'SELECT'
      and 'authenticated' = any(roles)
      and qual like '%auth.uid()%'
      and qual like '%user_id%'
  ) then
    raise exception '검증 실패: trading_performance 본인 읽기 정책이 없습니다.';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = sync_rpc
      and (prosecdef or not ('search_path=""' = any(coalesce(proconfig, '{}'))))
  ) then
    raise exception '검증 실패: replace_synced_holdings는 SECURITY INVOKER와 빈 search_path여야 합니다.';
  end if;

  if exists (
    select 1
    from pg_proc
    where oid = legacy_sync_rpc
      and (prosecdef or not ('search_path=""' = any(coalesce(proconfig, '{}'))))
  ) then
    raise exception '검증 실패: 호환 replace_synced_holdings는 SECURITY INVOKER와 빈 search_path여야 합니다.';
  end if;

  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('holdings', 'member_settings', 'integration_tokens', 'trading_performance')
      and c.relrowsecurity
    group by n.nspname
    having count(*) = 4
  ) then
    raise exception '검증 실패: 회원 데이터 테이블 4개의 RLS가 모두 활성화되지 않았습니다.';
  end if;
end
$$;

select
  'PASS' as result,
  'filings/회원 데이터/자동매매 성과 RLS, RPC, 역할별 최소 권한 검증 완료' as detail;
