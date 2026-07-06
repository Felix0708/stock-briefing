# 배포·환경변수 운영 가이드

이 문서는 GitHub Actions, GitHub Pages, Vercel과 Secret 설정의 단일 기준이다.
실제 키 값은 저장소 파일, Actions 로그, 이슈와 보고서에 기록하지 않는다.

## 자동화 역할

| 파일 | 역할 | 외부 변경 |
|---|---|---|
| `.github/workflows/quality.yml` | Python 구문, 웹 lint·typecheck·테스트·build, Secret 정적 검사 | 없음 |
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
3. Framework Preset은 Next.js, Node.js는 20.x로 설정한다.
4. 아래 변수를 Preview와 Production에 각각 등록한다.

| 변수 | 분류 | 필수 |
|---|---|---|
| `GEMINI_API_KEY` | Sensitive | 예 |
| `SUPABASE_SECRET_KEY` | Sensitive | 예 |
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

`GEMINI_API_KEY`, `SUPABASE_SECRET_KEY`, `UPSTASH_REDIS_REST_TOKEN`,
`RATE_LIMIT_IP_HASH_KEY`에 `NEXT_PUBLIC_` 접두사를 붙이지 않는다.
Gemini 확정 운영값은 답변 모델 8 RPM·16 RPD, 임베딩 모델 80 RPM·800 RPD다. 답변 모델의
16 RPD는 재시도를 포함한 전 사용자 합산 상한이며, 실사용 유입 시 무료 티어 병목이 된다.
Vercel CLI의 `.vercel/`과 로컬 `.env*`는 Git ignore 대상이다.

## 배포 전 게이트

네트워크 가능한 환경에서 다음 순서로 실행한다.

```bash
npm --prefix web install
scripts/qa.sh --build
```

실제 연동 검증은 로컬 서버를 실행한 상태에서 수행한다.

```bash
scripts/qa.sh --base-url http://localhost:3000
```

다음 조건을 모두 충족한 뒤에만 Vercel 배포를 허용한다.

- `package-lock.json`이 생성되어 Git에 포함됨
- lint, typecheck, API 테스트, production build 실패 0건
- production 브라우저 번들에서 실제 키 형태 문자열 미검출
- 실제 질문 응답에 DART 출처가 포함됨
- 운영 Supabase에 최신 `db/schema.sql`이 적용됨
- Upstash Redis가 연결되고 정상·초과·장애 시나리오가 각각 검증됨
- 확정값 `RATE_LIMIT_GLOBAL_RPM=8`, 답변 `8/16`, 임베딩 `80/800`을 Vercel에 등록함
- Vercel WAF가 `POST /api/ask`에 정책 문서의 보조 제한으로 설정됨

키 노출이 의심되면 커밋 삭제만으로 끝내지 않고 해당 공급자에서 즉시 폐기·재발급한다.
