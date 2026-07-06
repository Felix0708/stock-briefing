# Stock Briefing Web

Phase 2-2 질문·답변 웹앱용 Next.js 프로젝트입니다. Gemini와 Supabase의 비밀키는 브라우저 코드가 아닌 API Route에서만 사용합니다.

## 요구 환경

- Node.js 20.9 이상
- npm 10 이상

## 로컬 실행

```bash
cd web
cp .env.local.example .env.local
# .env.local에 실제 키 입력
npm install
npm run dev
```

브라우저에서 <http://localhost:3000>을 엽니다.

## 검증 명령

저장소 루트에서 공통 QA 스크립트를 실행합니다.

```bash
scripts/qa.sh
scripts/qa.sh --build
```

실행 중인 로컬 서버까지 확인하려면 별도 터미널에서
`scripts/qa.sh --base-url http://localhost:3000`을 실행합니다.

## 환경변수

| 변수 | 용도 | 보안 등급 |
|---|---|---|
| `GEMINI_API_KEY` | 질문 임베딩·답변 생성 | Secret |
| `GEMINI_MODEL` | 답변 생성 모델 | 일반 설정 |
| `GEMINI_ANSWER_MODEL` | 웹 답변 전용 모델. 비우면 `GEMINI_MODEL` 사용 | 일반 설정 |
| `EMBEDDING_MODEL` | 질문 임베딩 모델 | 일반 설정 |
| `EMBEDDING_DIM` | DB 벡터 차원. `db/schema.sql`의 `vector(768)`과 일치해야 함 | 일반 설정 |
| `SUPABASE_URL` | Supabase 프로젝트 URL | 일반 설정 |
| `SUPABASE_SECRET_KEY` | `match_filings` 서버 호출용 Secret key | Secret |
| `UPSTASH_REDIS_REST_URL` | 공개 질문 API rate limit용 Redis REST URL | 일반 설정 |
| `UPSTASH_REDIS_REST_TOKEN` | 공개 질문 API rate limit용 Redis REST token | Secret |
| `RATE_LIMIT_IP_HASH_KEY` | 원본 IP를 Redis에 남기지 않기 위한 HMAC key | Secret |
| `RATE_LIMIT_GLOBAL_RPM` | 앱 전체 60초 요청 상한. 확정값 8 | 일반 설정 |
| `GEMINI_EMBEDDING_RPM_LIMIT` | 재시도를 포함한 임베딩 모델 60초 호출 상한. 확정값 80 | 일반 설정 |
| `GEMINI_EMBEDDING_DAILY_BUDGET` | 임베딩 모델 24시간 호출 예산. 확정값 800 | 일반 설정 |
| `GEMINI_ANSWER_RPM_LIMIT` | 재시도를 포함한 답변 모델 60초 호출 상한. 확정값 8 | 일반 설정 |
| `GEMINI_ANSWER_DAILY_BUDGET` | 답변 모델 24시간 호출 예산. 확정값 16 | 일반 설정 |
| `RAG_MATCH_COUNT` | 검색할 공시 청크 개수 | 일반 설정 |
| `RAG_MIN_SIMILARITY` | 답변 근거로 사용할 최소 코사인 유사도 | 일반 설정 |

`GEMINI_API_KEY`, `SUPABASE_SECRET_KEY`, `UPSTASH_REDIS_REST_TOKEN`,
`RATE_LIMIT_IP_HASH_KEY`에는 `NEXT_PUBLIC_` 접두사를 절대 붙이지 않습니다. 실제 값은
`web/.env.local`과 Vercel 환경변수에만 저장하며, Git에는 `.env.local.example`만
커밋합니다.

확정 실측 원본값은 답변 모델 RPM 10·RPD 20, 임베딩 모델 RPM 100·RPD 1,000이며 위 값은
각각 80%입니다. 모델별 RPM·24시간 RPD는 실제 Gemini 전송 직전에 단일 원자 연산으로
차감되어 재시도도 각 1회로 계산됩니다. 답변 모델 16 RPD는 전 사용자 합산 상한이므로
실사용 유입 시 무료 티어 병목이 됩니다.

Vercel 설정과 배포 전 점검은 [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)를 따릅니다.

## API 구현 기준

- API Route: `src/app/api/ask/route.ts`
- 외부 API 호출: 서버 전용 모듈의 `fetch` 사용
- 검색 RPC: `match_filings`
- 브라우저에는 질문과 최종 응답·출처만 전달하고 Secret key는 전달하지 않음
