-- Phase 2: 공시 원문 벡터 저장소
-- 실행 방법: Supabase 대시보드 → SQL Editor → 이 파일 내용 붙여넣기 → Run

-- pgvector 확장 활성화 (Supabase에 내장돼 있어 켜기만 하면 됨)
create extension if not exists vector;

-- 공시 청크 테이블
-- 공시 원문을 약 1,000자 단위(청크)로 쪼개 저장한다.
-- 왜 쪼개는가: 검색 정밀도(질문과 관련된 부분만 매칭) + LLM 컨텍스트 절약
create table if not exists filings (
  id          bigint generated always as identity primary key,
  rcept_no    text not null,          -- DART 접수번호 (공시 고유 ID)
  company     text not null,          -- 기업명
  report_nm   text,                   -- 공시명
  rcept_dt    text,                   -- 접수일 (YYYYMMDD)
  url         text,                   -- DART 원문 링크 (답변 출처 표시용)
  chunk_idx   int  not null,          -- 청크 순번
  content     text not null,          -- 청크 본문
  embedding   vector(768),            -- Gemini 임베딩 (768차원)
  created_at  timestamptz default now(),
  unique (rcept_no, chunk_idx)        -- 같은 공시를 중복 저장하지 않기 위한 제약
);

-- SQL Editor로 만든 public 테이블은 RLS가 자동 활성화되지 않는다.
-- 브라우저/공개 키로는 직접 조회하지 못하게 하고, secret key를 가진
-- 수집 파이프라인과 Next.js API Route에서만 접근한다.
alter table filings enable row level security;

-- 벡터 유사도 검색 인덱스 (HNSW: 속도-정확도 균형이 좋은 방식)
create index if not exists filings_embedding_idx
  on filings using hnsw (embedding vector_cosine_ops);

-- 이전 3개 인자 버전이 남아 PUBLIC으로 호출되는 것을 막는다.
drop function if exists public.match_filings(vector, integer, text);

-- 유사도 검색 함수: Q&A 백엔드가 호출
-- 임계값 필터를 DB에서 적용해 불필요한 행을 API로 보내지 않는다.
create or replace function match_filings(
  query_embedding vector(768),
  match_count     int  default 8,
  filter_company  text default null,
  match_threshold float default 0.35
)
returns table (
  company    text,
  report_nm  text,
  rcept_dt   text,
  url        text,
  content    text,
  similarity float
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    f.company, f.report_nm, f.rcept_dt, f.url, f.content,
    1 - (f.embedding <=> query_embedding) as similarity
  from public.filings f
  where f.embedding is not null
    -- API도 기업명 앞뒤 공백을 제거하지만, RPC를 직접 호출하는 경우까지
    -- 동일하게 처리한다. 빈 문자열은 필터 없음, 그 외에는 정확한 기업명 일치다.
    and (
      nullif(btrim(filter_company), '') is null
      or f.company = btrim(filter_company)
    )
    and 1 - (f.embedding <=> query_embedding) >= match_threshold
  order by f.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 8), 1), 20);
$$;

-- Data API의 기본 함수 EXECUTE 권한을 제거하고 서버 전용 키만 허용한다.
revoke execute on function public.match_filings(vector, integer, text, float) from public;
revoke execute on function public.match_filings(vector, integer, text, float) from anon, authenticated;
grant execute on function public.match_filings(vector, integer, text, float) to service_role;

-- 브라우저 역할은 테이블에 직접 접근할 필요가 없다.
revoke all on table public.filings from public, anon, authenticated;
grant select, insert, update on table public.filings to service_role;
revoke all on sequence public.filings_id_seq from public, anon, authenticated;
grant usage, select on sequence public.filings_id_seq to service_role;

-- PostgREST의 스키마 캐시를 즉시 갱신한다.
notify pgrst, 'reload schema';
