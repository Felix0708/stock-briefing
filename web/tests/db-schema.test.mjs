import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
const verification = await readFile(
  new URL("../../db/verify_schema.sql", import.meta.url),
  "utf8",
);
const phase5 = await readFile(new URL("../../db/schema_phase5.sql", import.meta.url), "utf8");

test("DB 스키마가 company 필터와 4인자 RPC 계약을 유지한다", () => {
  assert.match(
    schema,
    /create or replace function match_filings\s*\([\s\S]*?filter_company\s+text\s+default null[\s\S]*?match_threshold\s+float\s+default 0\.35/,
  );
  assert.match(schema, /nullif\(btrim\(filter_company\), ''\) is null/);
  assert.match(schema, /f\.company = btrim\(filter_company\)/);
  assert.match(schema, /limit least\(greatest\(coalesce\(match_count, 8\), 1\), 20\)/);
});

test("Phase 5가 토큰 해시·기본 비동의·수동/자동 행을 최소 권한으로 분리한다", () => {
  assert.match(phase5, /token_hash text not null unique check \(token_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  assert.match(phase5, /public_briefing_opt_in boolean not null default false/);
  assert.match(phase5, /source in \('manual', 'stock_trading'\)/);
  assert.match(phase5, /with check \(\(select auth\.uid\(\)\) = user_id and source = 'manual'\)/);
  assert.match(phase5, /revoke all on table public\.integration_tokens from public, anon, authenticated/);
  assert.match(phase5, /grant select, insert, update, delete on table public\.integration_tokens to service_role/);
  assert.match(phase5, /revoke all on table public\.member_settings from public, anon, authenticated/);
  assert.match(phase5, /grant select, insert, update on table public\.member_settings to authenticated/);
});

test("전체 스냅샷 RPC가 중복을 먼저 거부하고 해당 회원의 자동 행만 원자 교체한다", () => {
  assert.match(phase5, /security invoker[\s\S]*?set search_path = ''/);
  assert.match(phase5, /having count\(\*\) > 1[\s\S]*?duplicate holding in snapshot/);
  assert.match(phase5, /where user_id = target_user_id\s+and source = 'stock_trading'/);
  assert.match(phase5, /revoke all on function public\.replace_synced_holdings\(uuid, jsonb\) from public, anon, authenticated/);
  assert.match(phase5, /grant execute on function public\.replace_synced_holdings\(uuid, jsonb\) to service_role/);
});

test("DB 스키마가 RLS와 서버 전용 권한을 적용한다", () => {
  assert.match(schema, /alter table filings enable row level security/);
  assert.match(schema, /security invoker/);
  assert.match(schema, /set search_path = ''/);
  assert.match(
    schema,
    /revoke execute on function public\.match_filings\(vector, integer, text, float\) from anon, authenticated/,
  );
  assert.match(
    schema,
    /grant execute on function public\.match_filings\(vector, integer, text, float\) to service_role/,
  );
  assert.match(
    schema,
    /revoke all on table public\.filings from public, anon, authenticated/,
  );
});

test("배포 후 검증 SQL이 RLS와 역할별 권한을 검사한다", () => {
  assert.match(verification, /c\.relrowsecurity/);
  assert.match(verification, /has_function_privilege\('anon'/);
  assert.match(verification, /has_function_privilege\('service_role'/);
  assert.match(verification, /has_table_privilege\([\s\S]*?'authenticated'/);
  for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
    assert.match(
      verification,
      new RegExp(
        `has_table_privilege\\('service_role', 'public\\.filings', '${privilege}'\\)`,
      ),
    );
  }
  assert.match(verification, /has_sequence_privilege\('anon'/);
  assert.match(verification, /has_sequence_privilege\([\s\S]*?'authenticated'/);
  assert.match(verification, /has_sequence_privilege\('service_role'/);
  assert.match(verification, /SECURITY INVOKER와 빈 search_path/);
});
