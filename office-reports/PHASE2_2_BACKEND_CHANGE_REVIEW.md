# Phase 2-2 백엔드·API·DB 변경 검토 결과

- 담당: 강대리
- 검토일: 2026-07-05 23:18 JST
- 범위: `POST /api/ask`, Rate Limit, Gemini·Supabase 서버 모듈, API·DB 회귀 테스트,
  `db/schema.sql`, `db/verify_schema.sql`
- 제외: 운영 Supabase 적용, Upstash·Vercel 설정, 배포, 커밋·push
- 결론: **로컬 회귀 19/19 및 정적 DB 계약은 통과했다. 설정값 불일치 1건은 수정했고,
  재시도 시 모델 RPM 보호 공백 1건과 운영 적용 대기 항목이 남아 있다.**

## 1. 검증 결과

| 검증 | 결과 | 근거 |
|---|---|---|
| API·DB 회귀 테스트 | **19/19 통과** | API 16건, DB 정적 계약 3건 |
| TypeScript strict | **통과** | `tsc -p web/tsconfig.json --noEmit` |
| Git 공백 검사 | **통과** | `git diff --check` |
| Rate Limit 산술 | **통과** | 답변 RPM `floor(10×0.8)=8`, 답변 RPD `floor(20×0.8)=16`, 임베딩 RPD `floor(1000×0.8)=800` |
| 활성 모델 | **일치** | 답변 `gemini-2.5-flash-lite`, 임베딩 `gemini-embedding-001` |
| SQL 정적 계약 | **통과** | 4인자 RPC, RLS, `SECURITY INVOKER`, 빈 `search_path`, 역할별 revoke/grant 일치 |
| 운영 DB 실증 | **미수행** | 지시대로 운영 Supabase에 적용하지 않음 |

회귀 테스트는 환경변수에서 글로벌 RPM 8, 임베딩 일일 예산 800, 답변 일일 예산 16이
실제 Upstash EVAL 인자로 전달되는지 기존 19개 테스트 안에서 확인하도록 보강했다.

## 2. 발견 및 조치

### 조치 완료: 설정 예시·테스트 값 불일치

기존 예시와 테스트 픽스처가 `RATE_LIMIT_GLOBAL_RPM=12`,
`GEMINI_ANSWER_DAILY_BUDGET=800`을 사용해 최신 전달값과 불일치했다. 그대로 배포 담당에게
전달되면 답변 모델의 RPM·RPD 한도를 초과 설정할 수 있으므로 다음으로 정정했다.

- `RATE_LIMIT_GLOBAL_RPM=8`
- `GEMINI_ANSWER_DAILY_BUDGET=16`
- `GEMINI_EMBEDDING_DAILY_BUDGET=800`

사용자가 제공한 수치가 실측 원본 한도임이 확정됐다. 답변 8 RPM/16 RPD, 임베딩
80 RPM/800 RPD를 운영값으로 사용하며 재측정하지 않는다.

### 미조치 결함: Gemini 재시도 시 분당 한도 보호 공백

현재 글로벌 RPM 8은 **사용자 질문 수**를 제한하지만 Gemini 호출은 429·5xx·timeout에서
요청당 최대 3회 재시도한다. 일일 모델 예산은 재시도마다 차감하지만 모델별 60초 카운터는
없다. 따라서 장애 구간에는 8개 질문이 같은 모델에 최대 24회 호출 시도를 만들 수 있어,
답변 모델 활성 RPM 10의 80%인 8을 실제 외부 호출 기준으로 보장하지 못한다.

권장 조치는 Gemini 모델별 60초 슬라이딩 카운터를 실제 전송 직전에 원자 차감하는 것이다.
임시로 글로벌 요청 한도를 2로 낮추면 3회 재시도 최악 조건에서도 6회/분으로 막을 수 있으나,
정상 처리량도 과도하게 감소하므로 영구 조치로는 권장하지 않는다.

## 3. DB·RPC·RLS 검토

`db/schema.sql`과 `db/verify_schema.sql`의 계약은 다음 항목에서 일치했다.

- `public.filings` RLS 활성화
- 기존 3인자 `match_filings` 제거 및 4인자 RPC 생성
- company trim·빈 값 무필터·완전 일치, 유사도 임계값, 결과 1~20개 제한
- RPC `SECURITY INVOKER`, 빈 `search_path`
- `anon`·`authenticated`의 RPC·테이블·시퀀스 권한 회수
- `service_role`의 RPC 실행, 테이블 SELECT·INSERT·UPDATE, 시퀀스 USAGE·SELECT 허용
- PostgREST 스키마 캐시 reload

정적 검토와 테스트에서는 결함을 찾지 못했다. 다만 정적 테스트는 운영 DB의 실제 카탈로그,
기존 오버로드 잔존 여부, role 권한 상태를 증명하지 않는다.

## 4. 운영 적용 대기

1. Gemini 모델별 분당 실제 호출 카운터를 보완하고 장애·동시 요청 회귀를 추가한다.
2. 운영 Supabase에 `db/schema.sql`을 적용한 뒤 `db/verify_schema.sql`의 마지막 `PASS`를 확인한다.
3. 운영 Upstash에 HMAC 키와 답변 `8/16`·임베딩 `80/800`을 등록하고 실제 Lua 경계·동시성·timeout을 검증한다.
4. 위 항목 완료 전에는 CI·push·Vercel 배포 승인으로 간주하지 않는다.

## 5. 이번 검토에서 수정한 파일

| 파일 | 변경 내용 |
|---|---|
| `.env.example` | Rate Limit 예시를 글로벌 8·답변 16·임베딩 800으로 정정 |
| `web/.env.local.example` | 웹 서버 환경 예시를 8·16·800으로 정정 |
| `web/README.md` | 글로벌 RPM 설명을 확정값 8로 정정 |
| `docs/RATE_LIMIT_POLICY.md` | 전달 원본 한도와 80% 계산값, 운영 등록 대기 상태 반영 |
| `web/tests/api-route.test.mjs` | 기존 19개 수를 유지하며 8·16·800의 실제 EVAL 전달을 검증 |
| `office-reports/PROGRESS.md` | 작업 완료 상태 기록 |
| `office-reports/PHASE2_2_BACKEND_CHANGE_REVIEW.md` | 본 검토 보고서 작성 |

애플리케이션 런타임 코드와 DB SQL은 수정하지 않았다. 운영 Supabase 적용, 커밋, push,
Vercel 배포도 수행하지 않았다.
