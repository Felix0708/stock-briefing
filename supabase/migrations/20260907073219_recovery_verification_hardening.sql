begin;
-- now() is the transaction start, which can predate a balance adjustment in the same transaction.
alter table public.manual_trades alter column created_at set default clock_timestamp();
create policy briefing_items_deny_browser on public.briefing_items for all to anon,authenticated using(false) with check(false);
create policy briefing_batches_deny_browser on public.briefing_mail_batches for all to anon,authenticated using(false) with check(false);
create policy briefing_receipts_deny_browser on public.briefing_mail_receipts for all to anon,authenticated using(false) with check(false);
create policy restore_points_deny_browser on public.portfolio_restore_points for all to anon,authenticated using(false) with check(false);
notify pgrst,'reload schema';
commit;
