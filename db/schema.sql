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

-- 벡터 유사도 검색 인덱스 (HNSW: 속도-정확도 균형이 좋은 방식)
create index if not exists filings_embedding_idx
  on filings using hnsw (embedding vector_cosine_ops);

-- 유사도 검색 함수: Q&A 백엔드가 호출
-- 질문 임베딩과 코사인 유사도가 높은 청크를 반환
create or replace function match_filings(
  query_embedding vector(768),
  match_count     int  default 8,
  filter_company  text default null
)
returns table (
  company    text,
  report_nm  text,
  rcept_dt   text,
  url        text,
  content    text,
  similarity float
)
language sql stable
as $$
  select
    f.company, f.report_nm, f.rcept_dt, f.url, f.content,
    1 - (f.embedding <=> query_embedding) as similarity
  from filings f
  where filter_company is null or f.company = filter_company
  order by f.embedding <=> query_embedding
  limit match_count;
$$;
