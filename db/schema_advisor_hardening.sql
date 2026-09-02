-- Supabase Advisor 보안 권고 정리
-- 선행: db/schema.sql, db/schema_phase5.sql

begin;

create schema if not exists extensions;
alter extension vector set schema extensions;

-- 확장 이동 후에도 빈 search_path에서 벡터 연산자를 명시적으로 해석한다.
create or replace function public.match_filings(
  query_embedding extensions.vector(768),
  match_count integer default 8,
  filter_company text default null,
  match_threshold float default 0.35
)
returns table (
  company text,
  report_nm text,
  rcept_dt text,
  url text,
  content text,
  similarity float
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    f.company, f.report_nm, f.rcept_dt, f.url, f.content,
    1 - (f.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.filings f
  where f.embedding is not null
    and (
      nullif(btrim(filter_company), '') is null
      or f.company = btrim(filter_company)
    )
    and 1 - (f.embedding operator(extensions.<=>) query_embedding) >= match_threshold
  order by f.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 8), 1), 20);
$$;

revoke execute on function public.match_filings(extensions.vector, integer, text, float)
  from public, anon, authenticated;
grant execute on function public.match_filings(extensions.vector, integer, text, float)
  to service_role;

drop policy if exists "filings_deny_browser" on public.filings;
create policy "filings_deny_browser" on public.filings
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "integration_tokens_deny_browser" on public.integration_tokens;
create policy "integration_tokens_deny_browser" on public.integration_tokens
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

notify pgrst, 'reload schema';
commit;
