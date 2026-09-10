# 배포·환경변수 운영 가이드

이 문서는 GitHub Actions, GitHub Pages, Vercel과 Secret 설정의 단일 기준이다.
실제 키 값은 저장소 파일, Actions 로그, 이슈와 보고서에 기록하지 않는다.

## 자동화 역할

| 파일 | 역할 | 외부 변경 |
|---|---|---|
| `.github/workflows/quality.yml` | Python 구문, 웹 lint·typecheck·테스트·build, Chromium/iPhone WebKit 브라우저 검증, 의존성 audit, Secret 검사 | 실패 시 가짜 테스트 데이터의 화면/trace를 3일 보관 |
| `.github/workflows/daily-briefing.yml` | 평일 공시 수집·요약·메일·인덱싱, `docs/data` 커밋 | Git push 및 Pages 워크플로 호출 |
| `.github/workflows/deploy-pages.yml` | `docs/` 정적 대시보드 배포 | GitHub Pages 배포 |

`daily-briefing`이 데이터 변경을 커밋한 경우에만 `deploy-pages`를 호출한다.
Git push와 Vercel 배포는 로컬 QA 명령에 포함하지 않는다.

## GitHub 설정

Repository secrets:

- 필수: `DART_API_KEY`, `GEMINI_API_KEY`
- 메일 사용 시: `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_TO`
- RAG 인덱싱 사용 시: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`

Repository variables:

- `GEMINI_MODEL`: 미등록 시 `gemini-2.5-flash-lite`
- `SEND_EMAIL`: 미등록 시 `true`; 메일 미사용 시 `false`

Settings → Pages → Build and deployment → Source는 **GitHub Actions**로 설정한다.
main 브랜치 보호 규칙에는 `quality / qa`를 필수 상태 검사로 등록한다.

## Vercel 프로젝트 설정

1. 아래 배포 전 게이트를 통과한 뒤 이 Git 저장소를 Vercel에 Import한다.
2. Project Settings → Build and Deployment → Root Directory를 `web`으로 지정한다.
3. Framework Preset은 Next.js, Node.js는 20.x(20.19 이상)로 설정한다.
4. 아래 변수를 Preview와 Production에 각각 등록한다.

| 변수 | 분류 | 필수 |
|---|---|---|
| `GEMINI_API_KEY` | Sensitive | 예 |
| `SUPABASE_SECRET_KEY` | Sensitive | 예 |
| `SUPABASE_ANON_KEY` | 일반 설정 | 예 |
| `SUPABASE_URL` | 일반 설정 | 예 |
| `UPSTASH_REDIS_REST_TOKEN` | Sensitive | 예 |
| `UPSTASH_REDIS_REST_URL` | 일반 설정 | 예 |
| `RATE_LIMIT_IP_HASH_KEY` | Sensitive | 예 |
| `RATE_LIMIT_GLOBAL_RPM` | 일반 설정 | 예 |
| `GEMINI_EMBEDDING_RPM_LIMIT` | 일반 설정 | 예 |
| `GEMINI_EMBEDDING_DAILY_BUDGET` | 일반 설정 | 예 |
| `GEMINI_ANSWER_RPM_LIMIT` | 일반 설정 | 예 |
| `GEMINI_ANSWER_DAILY_BUDGET` | 일반 설정 | 예 |
| `GEMINI_MODEL` | 일반 설정 | 아니오 |
| `GEMINI_ANSWER_MODEL` | 일반 설정 | 아니오 |
| `EMBEDDING_MODEL` | 일반 설정 | 아니오 |
| `EMBEDDING_DIM` | 일반 설정 | 아니오 |
| `RAG_MATCH_COUNT` | 일반 설정 | 아니오 |
| `RAG_MIN_SIMILARITY` | 일반 설정 | 아니오 |
| `GITHUB_DISPATCH_TOKEN` | Sensitive | 온디맨드 수집 시 예 |
| `GITHUB_REPO` | 일반 설정 | 온디맨드 수집 시 예 |

`GEMINI_API_KEY`, `SUPABASE_SECRET_KEY`, `UPSTASH_REDIS_REST_TOKEN`,
`RATE_LIMIT_IP_HASH_KEY`에 `NEXT_PUBLIC_` 접두사를 붙이지 않는다.
Gemini 모델별 호출 예산은 배포자가 자신의 활성 쿼터와 예상 사용량에 맞게 정한다.
예시 파일의 수치는 공통 보장 한도가 아니다. 일일 예산은 재시도를 포함한 전 사용자 합산 상한이다.
Vercel CLI의 `.vercel/`과 로컬 `.env*`는 Git ignore 대상이다.

## 배포 전 게이트

네트워크 가능한 환경에서 다음 순서로 실행한다.

```bash
npm --prefix web ci
scripts/qa.sh --build
cd web
npx playwright install chromium webkit
npm run test:browser
```

실제 연동 검증은 로컬 서버를 실행한 상태에서 수행한다.

```bash
scripts/qa.sh --base-url http://localhost:3000
```

다음 조건을 모두 충족한 뒤에만 Vercel 배포를 허용한다.

- `package-lock.json`이 생성되어 Git에 포함됨
- production 의존성 audit 고위험 취약점 0건
- lint, typecheck, API 테스트, production build 실패 0건
- production 브라우저 번들에서 실제 키 형태 문자열 미검출
- 실제 질문 응답에 DART 출처가 포함됨
- 운영 Supabase에 최신 `db/schema.sql`이 적용됨
- 운영 Supabase에 `db/schema_phase5.sql` 적용 후 `db/verify_schema.sql` PASS
- Upstash Redis가 연결되고 정상·초과·장애 시나리오가 각각 검증됨
- 자신의 프로젝트 쿼터 이내에서 글로벌·모델별 호출 예산을 정해 Vercel에 등록함
- Vercel WAF가 `POST /api/ask`에 정책 문서의 보조 제한으로 설정됨

키 노출이 의심되면 커밋 삭제만으로 끝내지 않고 해당 공급자에서 즉시 폐기·재발급한다.

## 포트폴리오 신뢰성 업데이트

웹 배포 전에 `supabase/migrations/20260907054535_portfolio_reliability.sql`을 한 번 적용한다.
`db/verify_schema.sql`과 `db/verify_portfolio_reliability.sql`이 모두 PASS여야 한다.
후자는 임시 사용자로 매수·분할 매도·전량 매도·중복 요청·RLS를 검사한 뒤 모두 롤백한다.
실제 보유분의 과거 거래를 생성하거나 잔고를 바꾸는 마이그레이션이 아니다.

운영 수집 검증 시 Actions → daily-briefing → Run workflow에서 `send_email=false`로 실행하면 추가 메일 없이 수집·상태 저장을 확인할 수 있다. 정기 발송 설정은 바뀌지 않는다.
공개 로그 검사는 `python3 scripts/audit-public-logs.py --limit 20`으로 실행한다. 결과는 실행 ID와 검출 건수만 출력하며, 실제 이메일/보유종목명은 출력하지 않는다.

운영 로그인·거래 흐름을 추가 검증할 때는 별도의 사용자 승인이 필요하다. 승인 후 `ALLOW_TEMP_QA_USER=1 node scripts/verify-live-portfolio.mjs https://운영주소`를 실행한다. 기본 설정 파일은 루트 `.env`이며 `QA_ENV_FILE`로 변경할 수 있다. 임시 비구독 계정 한 개만 만들고 종료 시 삭제한다. 실제 사용자 데이터·주문·메일은 사용하지 않는다.

## 공시 복구·과거 거래 정정·백업 업데이트

운영 적용 순서는 `20260907072405_briefing_recovery.sql` → `20260907072434_portfolio_revisions.sql` → `20260907072444_portfolio_backup.sql` → `20260907073219_recovery_verification_hardening.sql`이다 (`supabase/migrations/`). 대상 환경의 마이그레이션 이력을 확인하고 적용된 파일을 다시 실행하지 않는다.

새 환경은 기존 수동 거래가 있는 상태에서 초기 잔고를 임의 추정하지 않는다. 해당 마이그레이션은 그 경우 중단하므로 기존 장부의 시작 잔고를 먼저 대조해야 한다. 개인 잔고·거래 건수는 공개 문서에 기록하지 않는다.

배포 전 `scripts/qa.sh --build`, `npm run test:browser --prefix web`를 실행한다. 자동 백업 키를 처음 구성할 때만 `node scripts/backup.mjs init-key`를 사용한다. 키는 출력하지 않으며 로컬 비공개 파일과 GitHub Secret에 저장한다. [복구 운영 문서](RECOVERY_WORK.md)의 백업 범위·보관기간·복원 검증 절차를 따른다.

`portfolio-backup`의 실행 주기는 `.github/workflows/portfolio-backup.yml`에서 배포자가 확인·조정한다. 제공된 워크플로는 Actions artifact에 암호문만 30일 보관한다. 공개 저장소의 암호문은 다른 사람이 내려받을 수 있으므로 활성화 전에 이 공개 범위를 검토하고 키·평문은 절대 포함하지 않는다. 구성 후 격리 복원과 원격 파일을 다시 내려받아 복원하는 검사를 수행한다.
