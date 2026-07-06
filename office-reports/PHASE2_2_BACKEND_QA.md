# Phase 2-2 백엔드·인프라 검증 보고서

> 검증일: 2026-07-05  
> 담당: 강대리  
> 범위: `db/schema.sql`, Gemini 임베딩·답변, Supabase RPC, `/api/ask`

## 판정

**조건부 미완료**

로컬 정적 검사와 모킹 회귀 테스트는 통과했다. 다만 현재 실행 환경에서 외부 DNS와
인앱 브라우저를 사용할 수 없어 운영 Supabase 스키마 적용, 실제 Gemini·Supabase 정상
질문, 실데이터 검색 결과 없음, 실제 인증 오류·타임아웃 검증은 수행하지 못했다.

## 이번 수정

- `sb_secret_` 형식의 Supabase 키를 JWT Bearer로 보내던 헤더 구성을 수정했다.
  새 Secret key는 `apikey` 헤더로만 보내고, 레거시 `service_role` JWT만
  `Authorization: Bearer` 헤더를 함께 보낸다.
- `db/schema.sql`의 4인자 `match_filings` 계약에 맞춰 API가
  `match_threshold`를 명시적으로 전달하도록 수정했다.
- 새 Secret key 헤더, DB 임계값 전달, 외부 요청 타임아웃 재시도 회귀 테스트를 추가했다.

## 검증 결과

| 항목 | 결과 | 근거 |
|---|---|---|
| API Route 모킹 회귀 테스트 | 통과 | 7/7 |
| TypeScript strict 검사 | 통과 | 기존 TypeScript 실행 파일로 `tsc --noEmit` 수행 |
| Secret 정적 검사 | 통과 | 실제 키 패턴, `NEXT_PUBLIC_` Secret, Client Component 참조 미검출 |
| `git diff --check` | 통과 | 공백 오류 없음 |
| 정상 의존성 설치 | 차단 | `registry.npmjs.org` DNS 조회 실패 |
| production build·lint | 차단 | `node_modules` 불완전, `eslint-config-next@15.5.20` 로컬 캐시 없음 |
| 운영 스키마 적용 | 차단 | DB 연결 정보·Supabase 대시보드 세션 없음, 외부 DNS 차단 |
| 실제 Gemini·Supabase 시나리오 | 차단 | 두 서비스 호스트 DNS 조회 실패 |
| 브라우저 QA | 차단 | 인앱 브라우저 인스턴스 없음 |

## 운영 환경에서 남은 실행

1. 네트워크가 가능한 환경에서 `npm --prefix web install`을 실행해 lockfile을 생성한다.
2. 운영 DB 연결 문자열을 안전하게 주입한 뒤 아래처럼 스키마를 적용한다.

   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f db/schema.sql
   ```

3. `npm --prefix web run lint`, `npm --prefix web run typecheck`,
   `scripts/qa.sh --build`를 실행한다.
4. 서버를 실제 키로 기동한 뒤 정상 질문과 높은 임계값의 결과 없음 요청을 확인한다.
5. 별도 프로세스에서 가짜 Gemini/Supabase 키와 짧은 네트워크 타임아웃을 주입해
   API가 일반화된 5xx JSON만 반환하고 Secret·stack을 노출하지 않는지 확인한다.

운영 스키마 적용 전에는 4인자 RPC와 권한 제한이 실제 DB에 존재한다고 간주하면 안 된다.
