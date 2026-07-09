-- Phase 3: 로그인 사용자의 보유 종목 (포트폴리오)
-- 실행 방법: Supabase 대시보드 → SQL Editor → 이 파일 내용 붙여넣기 → Run
--
-- 인증 방식: Supabase Auth (GoTrue) 이메일+비밀번호.
-- 웹 서버는 사용자 access token을 Bearer로 전달해 PostgREST를 호출하고,
-- 아래 RLS 정책이 "자기 행만" 접근을 DB 차원에서 강제한다.

create table if not exists holdings (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  stock_code  text not null check (stock_code ~ '^[0-9]{6}$'),  -- 한국 종목코드 6자리
  stock_name  text not null check (char_length(stock_name) between 1 and 50),
  quantity    numeric(18,4) not null check (quantity > 0),
  avg_price   numeric(18,2) not null check (avg_price > 0),     -- 평균 매수 단가 (원)
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  unique (user_id, stock_code)  -- 같은 종목은 사용자당 1행 (재등록 시 갱신)
);

alter table holdings enable row level security;

-- 자기 행만 조회/생성/수정/삭제 가능
drop policy if exists "holdings_select_own" on holdings;
create policy "holdings_select_own" on holdings
  for select using (auth.uid() = user_id);

drop policy if exists "holdings_insert_own" on holdings;
create policy "holdings_insert_own" on holdings
  for insert with check (auth.uid() = user_id);

drop policy if exists "holdings_update_own" on holdings;
create policy "holdings_update_own" on holdings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "holdings_delete_own" on holdings;
create policy "holdings_delete_own" on holdings
  for delete using (auth.uid() = user_id);

-- updated_at 자동 갱신
create or replace function set_holdings_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists holdings_updated_at on holdings;
create trigger holdings_updated_at
  before update on holdings
  for each row execute function set_holdings_updated_at();
