import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

export const migrations=['db/schema_phase3.sql','db/schema_phase4.sql','db/schema_phase5.sql','db/schema_phase6.sql',
  'supabase/migrations/20260903032539_manual_broker_accounts.sql','supabase/migrations/20260907054535_portfolio_reliability.sql',
  'supabase/migrations/20260907072405_briefing_recovery.sql','supabase/migrations/20260907072434_portfolio_revisions.sql',
  'supabase/migrations/20260907072444_portfolio_backup.sql','supabase/migrations/20260907073219_recovery_verification_hardening.sql',
  'supabase/migrations/20260910145025_account_equity_history.sql',
  'supabase/migrations/20260912074043_account_equity_domestic.sql',
  'supabase/migrations/20260912081020_account_equity_breakdown.sql',
  'supabase/migrations/20260918012641_account_collection_status.sql',
  'supabase/migrations/20260918015154_account_status_consistency.sql',
  'supabase/migrations/20260918031434_recorded_tax_estimates.sql',
  'supabase/migrations/20260918040029_selected_currency_assets.sql',
  'supabase/migrations/20260918052709_isa_account_equity.sql',
  'supabase/migrations/20260918055337_live_holdings_ownership.sql',
  'supabase/migrations/20260918150648_performance_evaluation.sql'];

export async function createDatabase(users, baselineSql='') {
  const db=await PGlite.create();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth,public to anon,authenticated,service_role;
      grant execute on function auth.uid() to anon,authenticated,service_role;`);
    for (const id of users) await db.query('insert into auth.users values($1)',[id]);
    for (const file of migrations) {
      if (baselineSql && file.endsWith('20260907072434_portfolio_revisions.sql')) await db.exec(baselineSql);
      await db.exec(await readFile(new URL('../../'+file,import.meta.url),'utf8'));
    }
    await db.exec('set role service_role');
    return db;
  } catch (error) {await db.close();throw error;}
}
