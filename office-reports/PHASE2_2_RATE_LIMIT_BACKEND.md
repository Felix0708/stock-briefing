# Phase 2-2 Rate Limit·API·DB 계약 구현 보고

- 담당: 강대리
- 작성일: 2026-07-05 JST
- 범위: `/api/ask`, 서버 모듈, 공유 오류 타입, API·DB 회귀 테스트
- 기준 정책: [`docs/RATE_LIMIT_POLICY.md`](../docs/RATE_LIMIT_POLICY.md)
- 결론: **코드 및 오프라인 회귀 검증 완료, 운영 인프라 적용은 배포 게이트로 잔존**

## 1. 구현 결과

### 영속형 요청 제한

- Upstash Redis REST `EVAL` 한 번으로 아래 네 슬라이딩 윈도우를 함께 판정한다.
  - IP별 6회/60초
  - IP별 60회/1시간
  - IP별 200회/24시간
  - 앱 전체 `RATE_LIMIT_GLOBAL_RPM`회/60초(정책 상한 8)
- 모든 키를 같은 Redis hash tag에 배치하고, 검사와 허용 요청 기록을 하나의 Lua
  스크립트에서 수행해 일부 창만 기록되는 경쟁 상태를 차단했다.
- Gemini 임베딩·답변 모델은 각각 60초 RPM과 최근 24시간 RPD를 두 키로 관리하고,
  단일 `EVAL`에서 두 창을 원자적으로 판정·기록한다. `requestJson()`의 매 시도 직전
  훅에서 차감하므로 429/5xx/timeout 재시도도 실제 호출 시도 수에 포함된다.
- Upstash 설정 누락·인증 실패·timeout·응답 형식 오류는 fail-closed
  `503 RATE_LIMIT_UNAVAILABLE`로 처리하며 Gemini·Supabase를 호출하지 않는다.

### IP 및 Secret 처리

- Vercel 운영 환경에서 플랫폼이 제공하는 `x-vercel-forwarded-for`만 신뢰한다.
- IPv4/IPv6를 검증·정규화하고, IP가 없거나 유효하지 않으면 요청별 임의 값이 아닌
  `unknown` 공용 버킷을 사용한다.
- 원본 IP는 32자 이상 `RATE_LIMIT_IP_HASH_KEY`로 HMAC-SHA256 처리하며 Redis 키나 로그에
  저장하지 않는다.
- Upstash token, IP HMAC key 및 원본 IP가 Redis 명령 본문·API 오류 응답에 노출되지 않도록
  테스트로 고정했다.

### HTTP 오류 계약

- 자체 제한 초과: `429 RATE_LIMITED`
- 제한 저장소 설정·장애: `503 RATE_LIMIT_UNAVAILABLE`
- 429에는 `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`을
  초 단위로 반환한다.
- 모든 API 응답은 `Cache-Control: no-store`를 유지한다.

## 2. company·DB 계약 회귀

- `company`는 문자열만 허용하고 trim 후 빈 값은 필터 없음(`null`)으로 전달한다.
- trim 후 100자는 허용하고 101자는 `400 INVALID_REQUEST`로 거부한다.
- Supabase RPC에는 `filter_company`, `match_count`, `match_threshold`를 계약대로 전달한다.
- 정적 DB 회귀 테스트로 다음을 고정했다.
  - 4인자 `match_filings(vector, integer, text, float)`와 이전 3인자 함수 제거
  - company trim·완전 일치, 임계값 필터, 결과 개수 1~20 제한
  - `filings` RLS 활성화
  - `SECURITY INVOKER`, 빈 `search_path`
  - `anon`·`authenticated` 권한 회수와 `service_role` 전용 실행·테이블 권한
- [`db/verify_schema.sql`](../db/verify_schema.sql)은 운영 적용 직후 위 계약을 실제 DB에서
  실패 즉시 검증하도록 구성했다.

## 3. 변경 파일

| 파일 | 변경 내용 |
|---|---|
| `web/src/lib/server/rate-limit.ts` | Upstash 원자 슬라이딩 윈도우, 글로벌 제한, 모델별 RPM·24시간 RPD, IP HMAC, 헤더 생성 |
| `web/src/app/api/ask/route.ts` | 요청 선차단, 429·503 오류 계약, 제한 헤더 전파 |
| `web/src/lib/server/http.ts` | 외부 요청 매 시도 직전 예산 차감 훅 |
| `web/src/lib/server/gemini.ts` | 임베딩·답변 모델별 실제 호출 예산 연동 |
| `web/src/lib/ask-types.ts` | `RATE_LIMITED`, `RATE_LIMIT_UNAVAILABLE` 타입 추가 |
| `web/tests/api-route.test.mjs` | rate limit·IP·장애·예산·company 경계 회귀 테스트 |
| `web/tests/db-schema.test.mjs` | RLS·RPC·company SQL 계약 정적 테스트 |
| `db/schema.sql` | RLS·4인자 RPC·권한·company/임계값 계약 |
| `db/verify_schema.sql` | 운영 DB 적용 후 권한·함수 계약 검증 SQL |
| `office-reports/PROGRESS.md` | 구현 단계별 진행 기록 |

패키지 파일은 수정하지 않았고 Git push도 수행하지 않았다.

## 4. 검증 결과

| 검증 | 결과 |
|---|---|
| API·DB Node 회귀 테스트 | 21/21 통과 (API 18, DB 3) |
| TypeScript strict (`tsc --noEmit`) | 기존 통과, 현재 세션은 실행 파일 부재로 재실행 불가 |
| `scripts/qa.sh` | 실패 0, 경고 3 |
| Secret 정적 검사 | 실패 0 |
| `git diff --check` | 통과 |
| ESLint | 실행 파일 부재로 미실행 |

`scripts/qa.sh`의 경고는 정상 의존성 설치 미완료, production build 미실행, 로컬 API 서버
미기동이다. rate-limit 코드 회귀 실패는 남아 있지 않다.

## 5. 운영 잔여 게이트

1. Vercel에 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
   `RATE_LIMIT_IP_HASH_KEY`, `RATE_LIMIT_GLOBAL_RPM`, 모델별 RPM·24시간 RPD를 등록한다.
2. 확정된 글로벌 8 RPM·답변 8/16·임베딩 80/800을 Vercel 환경변수에 등록한다.
3. 운영 Supabase에 `db/schema.sql`을 적용한 뒤 `db/verify_schema.sql`을 실행한다.
4. 실제 Upstash에서 각 창 경계·동시 요청·timeout을 검증하고 Vercel WAF 보조 규칙을 적용한다.
5. 정상 의존성 설치 후 lint·production build·실서비스 브라우저 QA를 완료한다.

## 6. 2026-07-06 모델별 RPM·RPD 후속 구현

- 임베딩과 답변 모델 각각에 대해 60초 RPM과 최근 24시간 RPD 키를 두고,
  Upstash `EVAL` 한 번에 두 창을 판정·기록하도록 보완했다.
- `requestJson()`의 `beforeAttempt` 훅에서 실제 Gemini 전송 직전 차감하므로
  최초 호출과 429·5xx·timeout 재시도가 모두 RPM·RPD에 각 1회로 반영된다.
- 모델 한도 초과는 외부 호출 전 `429 RATE_LIMITED`, Upstash 장애는
  `503 RATE_LIMIT_UNAVAILABLE`로 fail-closed 처리한다.
- 확정 운영값은 임베딩 80 RPM/800 RPD, 답변 8 RPM/16 RPD다. 답변 16 RPD는 재시도를
  포함한 전 사용자 합산 상한이며 실사용 유입 시 무료 티어 병목이 된다.
- API 18건에 분당 한도 선차단, 두 키의 Redis Cluster hash tag 일치,
  80/800 인자 전달, 재시도 3회의 각 EVAL 차감 계약을 포함했다.

최신 로컬 검증은 API·클라이언트·DB 회귀 26/26 통과다. TypeScript 소스는
기존 strict 검증을 통과했으나, 현재 세션은 `web/node_modules/.bin/tsc`가 없어 다시
실행하지 못했다. 이는 npm lockfile·완전 설치·production build 배포 게이트와 함께
남아 있으며, 이번 백엔드 런타임·회귀 구현 범위에서는 추가 실패가 없다.
