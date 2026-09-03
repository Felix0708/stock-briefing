-- 직접 등록 보유분은 Stock-Trading 자동매매 행과 source로 분리한 채 증권사를 기록한다.
begin;

alter table public.holdings
  drop constraint if exists holdings_broker_check,
  drop constraint if exists holdings_source_account_broker_check;

alter table public.holdings
  add constraint holdings_broker_check check (
    broker in (
      'MANUAL', 'KIWOOM', 'KIS', 'MIRAE', 'NH', 'SAMSUNG', 'KB',
      'SHINHAN', 'TOSS', 'KAKAOPAY', 'DAISHIN', 'OTHER', 'LEGACY'
    )
  ),
  add constraint holdings_source_account_broker_check check (
    (source = 'manual' and account_type = 'manual'
      and broker in (
        'MANUAL', 'KIWOOM', 'KIS', 'MIRAE', 'NH', 'SAMSUNG', 'KB',
        'SHINHAN', 'TOSS', 'KAKAOPAY', 'DAISHIN', 'OTHER'
      )) or
    (source = 'stock_trading' and account_type in ('paper', 'live')
      and broker in ('KIWOOM', 'KIS', 'LEGACY'))
  );

notify pgrst, 'reload schema';
commit;
