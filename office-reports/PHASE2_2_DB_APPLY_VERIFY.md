# Phase 2-2 운영 DB 스키마 적용·검증 결과 (백엔드)

- 담당: 강대리
- 최종 갱신: 2026-07-06 22:06 JST
- 범위: 운영 Supabase에 `db/schema.sql` 적용 후 `db/verify_schema.sql`로 RLS·RPC·역할별 권한 실증
- DB 코드 무수정 (`db/schema.sql`·`db/verify_schema.sql` 그대로 유지)
- 결론: **라이브 적용·검증은 완료하지 못했다.** 사용자는 운영 콘솔 접근을 승인했지만 현재 연결된 인앱 브라우저가 0개이고, Management API Access Token·DB 연결 URL·로그인된 CLI 프로젝트도 없다. Data API 호스트 역시 재시도에서 DNS 해석 단계로 차단됐다. 정적 계약 테스트는 3/3 통과했지만 이는 운영 DB의 실제 상태를 증명하지 않으므로 배포 게이트는 열린 상태다.

## 0. 2026-07-06 승인 후 재시도

사용자의 운영 Supabase 직접 접근 승인 후 아래 순서로 다시 확인했다.

| 확인 | 결과 |
|---|---|
| 인앱 브라우저 세션 | **0개**. 로그인된 Supabase SQL Editor 접근 불가 |
| Supabase CLI 프로젝트 링크 | 없음 (`supabase/config.toml` 부재) |
| DDL 실행 자격 | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_URL`, `DATABASE_URL` 없음 |
| `GET /rest/v1/filings?select=id&limit=0` | DNS 해석 실패, Supabase 응답 없음 |
| 4인자 `POST /rest/v1/rpc/match_filings` | 768차원 0 벡터·임계값 2의 무결과 요청도 DNS 해석 실패, Supabase 응답 없음 |
| 로컬 DB 계약 회귀 | `node --test web/tests/db-schema.test.mjs` **3/3 PASS** |

운영 DB 변경은 발생하지 않았다. SQL Editor가 연결되거나 DB 연결 URL/Management API Access Token 중 하나가 제공되면 아래 런북 그대로 적용·검증할 수 있다.

## 1. 라이브 적용이 불가능한 사유 (블로커 확정)

이번 라운드에서 실제 운영 DB에 적용/검증하지 못한 직접 원인은 **DDL과 카탈로그 검증 SQL을 실행할 인증·연결 경로가 없음**이다. 다음을 직접 확인했다.

| 확인 항목 | 결과 |
|---|---|
| `psql` / `pg_isready` 설치 | **없음** (`psql not found`, `pg_isready not found`) |
| `supabase` CLI | 설치·실행 가능(`/opt/homebrew/bin/supabase`). 쓰기 가능한 임시 HOME에서 `projects list`를 실행했으나 `SUPABASE_ACCESS_TOKEN` 부재로 거부됨 |
| Supabase 프로젝트 링크 | **없음** (`supabase/` 디렉터리·`config.toml` 부재, 링크 안 됨) |
| DB 직접 연결 정보 | 루트 `.env`에 `SUPABASE_DB_URL`·`DATABASE_URL`·DB 비밀번호·`SUPABASE_ACCESS_TOKEN` 계열 **0건** (키 이름 grep 결과 0) |
| 보유한 Supabase 자격 | `SUPABASE_URL` + `SUPABASE_SECRET_KEY`(service_role)만 존재 |
| CLI 로컬 상태 | `~/.supabase`에는 telemetry/traces만 있고 재사용 가능한 로그인 자격은 확인되지 않음. 기본 HOME에서는 telemetry 임시 파일 쓰기도 sandbox가 거부 |
| 대시보드 경로 | 연결된 인앱 브라우저가 없어 로그인된 Supabase SQL Editor를 사용할 수 없음 |
| 별도 연동 도구 | 이 세션에 Supabase/Postgres MCP 또는 SQL 실행 도구 없음 |

핵심: `verify_schema.sql`은 `DO $$ ... $$`(익명 PL/pgSQL 블록)과 `has_*_privilege()` 카탈로그 함수를 쓰므로 **직접 Postgres 연결(psql 또는 `supabase db`)이 반드시 필요**하다. 보유한 service_role 키는 PostgREST(Data API)까지만 도달하며, PostgREST로는 DDL(`create table`/`grant`/`revoke`)도, 익명 DO 블록도, 카탈로그 권한 조회도 실행할 수 없다. 따라서:

- `db/schema.sql` 적용: **미수행 (경로 없음)**
- `db/verify_schema.sql` 실행: **미수행 (경로 없음)**

임의로 DB URL/비밀번호를 추정하거나 Secret 값을 출력하는 행위는 하지 않았다.

### 1.1 운영 Data API 비파괴 확인 시도

보유한 `SUPABASE_URL`·`SUPABASE_SECRET_KEY`로 데이터 변경 없는 두 요청을 시도했다.

| 요청 | 의도 | 결과 |
|---|---|---|
| `GET /rest/v1/filings?select=id&limit=0` | service_role의 테이블 SELECT 경로 확인 | DNS 해석 실패, HTTP `000` |
| `POST /rest/v1/rpc/match_filings` | 4인자 RPC 존재·service_role EXECUTE 경로 확인 | DNS 해석 실패, HTTP `000` |

두 요청 모두 Supabase에서 받은 응답이 아니므로 테이블/RPC 실패로 판정하지 않았다. 반대로 성공 증거도 없으며, RLS·role grant·`search_path`는 Data API만으로 완전 검증할 수 없다.

## 2. 대체 수행: schema.sql ⇄ verify_schema.sql 정적 교차검증

라이브 실행이 막힌 대신, 운영 담당이 **단 한 번의 수동 적용으로 성공**하도록 두 파일의 계약이 서로 어긋나지 않는지(= 스키마를 올바로 적용해도 검증이 거짓 실패하지 않는지)를 assertion 단위로 전수 대조했다.

| `verify_schema.sql` 단정 (실패 조건) | 충족하는 `db/schema.sql` 구문 | 판정 |
|---|---|---|
| `public.filings`가 `relkind='r'` + `relrowsecurity` | `create table filings (...)` + `alter table filings enable row level security` | ✅ 일치 |
| 4인자 `match_filings(vector,integer,text,double precision)` 존재 | `create or replace function match_filings(vector(768), int, text, float)` (`float`=`double precision`) | ✅ 일치 |
| 3인자 `match_filings(vector,integer,text)` **부재** | `drop function if exists public.match_filings(vector, integer, text)` | ✅ 일치 |
| `anon`·`authenticated` RPC EXECUTE **불가** | `revoke execute ... from public` + `from anon, authenticated` | ✅ 일치 |
| `service_role` RPC EXECUTE **가능** | `grant execute ... to service_role` | ✅ 일치 |
| `anon`·`authenticated` 테이블 권한(SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER) **전무** | `revoke all on table public.filings from public, anon, authenticated` | ✅ 일치 |
| `service_role` 테이블 SELECT·INSERT·UPDATE **각각** 보유 | `grant select, insert, update on table public.filings to service_role` | ✅ 일치 |
| `anon`·`authenticated` 시퀀스 USAGE/SELECT/UPDATE **전무** | `revoke all on sequence public.filings_id_seq from public, anon, authenticated` | ✅ 일치 |
| `service_role` 시퀀스 USAGE·SELECT **각각** 보유 | `grant usage, select on sequence public.filings_id_seq to service_role` | ✅ 일치 |
| `match_filings`가 `SECURITY INVOKER` + 빈 `search_path` | `security invoker` + `set search_path = ''` | ✅ 일치 |

보조 확인:

- **시퀀스 이름**: `id bigint generated always as identity` → 자동 생성 시퀀스명이 `filings_id_seq`로, verify가 참조하는 이름과 일치한다.
- **`float`/`double precision` 등가**: Postgres에서 `float`은 `double precision`의 별칭이라 grant/revoke 시그니처(`...,float`)와 verify의 `...,double precision`이 동일 함수를 가리킨다.
- **`search_path=""` 표현**: 빈 문자열 GUC는 `pg_proc.proconfig`에 `search_path=""`(따옴표 포함)로 저장되며, verify의 `'search_path=""' = any(proconfig)` 검사와 일치한다.
- 현재 소스로 `node --test web/tests/db-schema.test.mjs`를 재실행해 company/4인자 RPC, RLS/server-only 권한, 배포 후 검증 SQL 계약 **3/3 통과**를 확인했다.

**정적 교차검증 실패 항목: 0건.** 두 SQL 파일 간 기대 계약은 일치한다. 다만 운영 DB에서 마지막 `PASS` 행을 직접 확인하기 전에는 라이브 검증 완료로 판정하지 않는다.

## 3. 운영 담당 실행 런북 (택1)

DB 연결이 가능한 환경에서 아래 중 하나로 적용→검증한다. 둘 다 종료코드/`PASS` 문자열로 성공을 판정할 수 있다.

**A. psql + 직접 연결 URL (권장, 스크립트화 가능)**

```bash
# SUPABASE_DB_URL = postgresql://postgres:[DB비밀번호]@db.[ref].supabase.co:5432/postgres
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f db/verify_schema.sql   # 마지막 행에 PASS 출력되면 성공
```

- 선행: `libpq`(psql) 설치, Supabase 대시보드 → Project Settings → Database에서 연결 문자열/비밀번호 확보.

**B. Supabase 대시보드 SQL Editor (도구 설치 불필요, 수동)**

1. SQL Editor에 `db/schema.sql` 전체 붙여넣기 → Run.
2. 새 쿼리에 `db/verify_schema.sql` 전체 붙여넣기 → Run → 결과 그리드에 `PASS` 행이 나오면 통과, `검증 실패: ...` 예외가 뜨면 해당 항목 조치.

두 방법 모두 `verify_schema.sql`이 실패하면 첫 위반 지점의 한국어 예외 메시지로 원인을 특정할 수 있다(위 §2 표의 각 행에 대응).

## 4. 이번 라운드 산출물

- 수정 파일: 본 보고서(`office-reports/PHASE2_2_DB_APPLY_VERIFY.md`), `office-reports/PROGRESS.md`
- DB 코드: `db/schema.sql`·`db/verify_schema.sql` 무수정
- 검증: `node --test web/tests/db-schema.test.mjs` 3/3 통과
- 커밋·push·배포·운영 DB 반영: **미수행**

## 5. 잔여(운영 담당 인계)

1. §3 런북 A 또는 B로 운영 Supabase에 `db/schema.sql` 적용 → `db/verify_schema.sql`로 `PASS` 확인.
2. `PASS` 획득 시 이 항목(운영 DB RLS·RPC 권한 실증)의 배포 게이트를 닫는다.
3. 실패 발생 시 예외 메시지의 항목을 §2 표에서 찾아 해당 grant/revoke 재적용 후 재검증.
