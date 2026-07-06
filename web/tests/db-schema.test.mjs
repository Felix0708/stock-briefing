import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");
const verification = await readFile(
  new URL("../../db/verify_schema.sql", import.meta.url),
  "utf8",
);

test("DB 스키마가 company 필터와 4인자 RPC 계약을 유지한다", () => {
  assert.match(
    schema,
    /create or replace function match_filings\s*\([\s\S]*?filter_company\s+text\s+default null[\s\S]*?match_threshold\s+float\s+default 0\.35/,
  );
  assert.match(schema, /nullif\(btrim\(filter_company\), ''\) is null/);
  assert.match(schema, /f\.company = btrim\(filter_company\)/);
  assert.match(schema, /limit least\(greatest\(coalesce\(match_count, 8\), 1\), 20\)/);
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
