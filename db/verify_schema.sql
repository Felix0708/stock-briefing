-- db/schema.sql을 운영 Supabase에 적용한 직후 실행하는 보안·RPC 계약 검사.
-- 실행 예: psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f db/verify_schema.sql

do $$
declare
  rpc regprocedure := to_regprocedure(
    'public.match_filings(vector,integer,text,double precision)'
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

  if to_regprocedure('public.match_filings(vector,integer,text)') is not null then
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
end
$$;

select
  'PASS' as result,
  'filings RLS, match_filings 권한, service_role 접근 검증 완료' as detail;
