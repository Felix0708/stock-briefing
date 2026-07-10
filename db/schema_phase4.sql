-- Phase 4: 해외 주식 지원 (미국·일본) — holdings에 시장(market) 구분 추가
-- 실행 방법: Supabase 대시보드 → SQL Editor → 이 파일 내용 붙여넣기 → Run
-- (이미 실행한 적이 있어도 다시 실행하면 일본 지원이 반영됩니다)

alter table holdings drop constraint if exists holdings_stock_code_check;
alter table holdings drop constraint if exists holdings_market_check;

alter table holdings
  add column if not exists market text not null default 'KR';

alter table holdings add constraint holdings_market_check
  check (market in ('KR', 'US', 'JP'));

alter table holdings add constraint holdings_stock_code_check check (
  (market = 'KR' and stock_code ~ '^[0-9]{6}$') or
  (market = 'US' and stock_code ~ '^[A-Z][A-Z0-9.\-]{0,9}$') or
  (market = 'JP' and stock_code ~ '^[0-9A-Z]{4,5}$')
);
