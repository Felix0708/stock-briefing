# 공개 API Rate Limit 정책 (`POST /api/ask`)

- 담당: 최과장
- 공식 문서 확인일: 2026-07-05 JST (Google 문서 최종 갱신: 2026-07-03 UTC)
- 상태: **Phase 2-2 한도 확정, 운영 등록 대기**. 전달받은 실측 원본 한도와 80% 운영값을
  확정값으로 사용한다.
- 관련 문서: [배포 가이드](./DEPLOYMENT.md) · [기획서](./PLAN.md)

## 1. 결론

공개 Q&A API는 **Upstash Redis의 원자적 서버 측 제한을 주 방어선**으로 사용한다.
Vercel Hobby WAF의 IP 고정 윈도우 규칙 1개는 대량 트래픽을 함수 진입 전에 거르는 보조
방어선으로 사용한다. 프로세스 메모리 카운터는 서버리스 인스턴스마다 분리·초기화되므로
운영 제한 수단으로 사용하지 않는다.

확정 한도는 다음과 같다.

| 범위 | 한도 | 방식 |
|---|---:|---|
| 익명 IP | **6회 / 60초** | 슬라이딩 윈도우 |
| 익명 IP | **60회 / 1시간** | 슬라이딩 윈도우 |
| 익명 IP | **200회 / 24시간** | 슬라이딩 윈도우 |
| 앱 전체 | **8회 / 60초** | 슬라이딩 윈도우 |
| Gemini 답변 모델 | **8회 / 60초** | 활성 RPM 10의 80%, 실제 외부 호출 시도 횟수 기준 |
| Gemini 답변 모델 | **16회 / 최근 24시간** | 활성 RPD 20의 80%, 실제 외부 호출 시도 횟수 기준 |
| Gemini 임베딩 모델 | **80회 / 60초** | 활성 RPM 100의 80%, 실제 외부 호출 시도 횟수 기준 |
| Gemini 임베딩 모델 | **800회 / 최근 24시간** | 활성 RPD 1,000의 80%, 실제 외부 호출 시도 횟수 기준 |
| Vercel WAF 보조선 | **60회 / 10분 / IP** | Hobby가 지원하는 고정 윈도우 1규칙 |

실측 원본 한도는 답변 모델 RPM 10·RPD 20, 임베딩 모델 RPM 100·RPD 1,000으로 확정됐다.
80% 운영값은 글로벌 8 RPM, 답변 8 RPM·16 RPD, 임베딩 80 RPM·800 RPD다. 이 값은
재측정 대상이 아니며, Vercel 운영 환경변수 등록만 남아 있다.

> **용량 한계:** 무료 티어의 답변 모델 RPD 20을 80%로 제한하므로 **16회/최근 24시간이
> 전 사용자 합산 상한**이다. 재시도도 1회씩 차감되어 성공 답변은 16개보다 적을 수 있다.
> 포트폴리오 시연에는 사용할 수 있지만 실사용 유입 시 가장 먼저 병목이 되므로, 사용량 증가
> 시 유료 티어 전환 또는 공급자 쿼터 상향이 필요하다.

## 2. 요청 1건의 비용 구조

현재 코드의 `answerQuestion()`은 정상 질문 1건마다 아래 호출을 수행한다.

1. Gemini `gemini-embedding-001`의 `embedContent` 1회
2. Supabase `match_filings` RPC 1회
3. Gemini `gemini-2.5-flash-lite`의 `generateContent` 1회

따라서 질문 1건은 기본적으로 **Gemini 2회 + Supabase 1회**다. 외부 요청 모듈은
429·일부 5xx에 재시도하므로, 일일 예산은 허용된 사용자 질문 수가 아니라 **실제 Gemini
호출 시도마다** 차감해야 한다. 그래야 재시도가 발생해도 공급자 쿼터 보호가 유지된다.

## 3. 공식 쿼터 확인 결과

### 3-1. Gemini Developer API

- 최신 공식 문서는 대화형 RPM·TPM·RPD를 고정 표로 보장하지 않고, 프로젝트의 사용 등급과
  상태에 따라 달라지는 **AI Studio 활성 한도**를 기준으로 안내한다.
- 한도는 API 키별이 아니라 **Google Cloud 프로젝트별**로 합산된다.
- RPD는 **미국 태평양 시간 자정**에 초기화되며, 공식 문서도 명시값은 보장 용량이 아니라고
  고지한다.
- Google 공식 문서의 현재 대화형 한도 섹션은 모델별 고정 RPM/RPD 표를 공개하지 않는다.
  과거 공개값은 참고 이력으로만 보존하며 현재 프로젝트의 운영값 근거로 사용하지 않는다.

글로벌 8 RPM은 확정된 앱 정책 상한이다. 실측 원본 한도에 80%를 적용한 결과는 다음과 같다.

```text
GLOBAL_RPM = min(8, floor(answer_model_RPM × 0.8), floor(embedding_model_RPM × 0.8))
```

### 3-1-1. 확정 한도 근거표 (오차장 등록용)

**2026-07-06 확정 결과**:

- 공식 Rate limits 문서는 2026-07-03 UTC에 갱신됐으며 RPM·TPM·RPD가 프로젝트별로
  적용된다고 명시한다.
- 프로젝트의 실제 환경 설정은 답변 `gemini-2.5-flash-lite`, 임베딩
  `gemini-embedding-001`이다. 답변 모델은 루트 `.env`, 임베딩 모델은 코드 기본값과
  `.env.example`을 대조했다. API 키 값은 출력하지 않았다.
- 사용자가 제공한 수치가 해당 프로젝트의 실측 원본 한도임을 확인했으며 재측정하지 않는다.
- 원본 한도에 대한 80% 산술 계산과 코드·테스트·환경변수 예시의 값을 대조했다.

| 모델 | 용도 | 활성 RPM | 활성 RPD | 80% RPM | 80% RPD | 운영 설정 |
|---|---|---:|---:|---:|---:|---|
| `gemini-2.5-flash-lite` | 답변 생성 (`generateContent`) | 확정 10 | 확정 20 | **8** | **16** | `GEMINI_ANSWER_RPM_LIMIT=8`, `GEMINI_ANSWER_DAILY_BUDGET=16` |
| `gemini-embedding-001` | 질문 임베딩 (`embedContent`) | 확정 100 | 확정 1,000 | **80** | **800** | `GEMINI_EMBEDDING_RPM_LIMIT=80`, `GEMINI_EMBEDDING_DAILY_BUDGET=800` |

확정 계산:

```text
RATE_LIMIT_GLOBAL_RPM          = min(8, floor(10 × 0.8), floor(100 × 0.8)) = 8
GEMINI_ANSWER_RPM_LIMIT        = floor(10 × 0.8)    = 8
GEMINI_EMBEDDING_RPM_LIMIT     = floor(100 × 0.8)   = 80
GEMINI_ANSWER_DAILY_BUDGET     = floor(20 × 0.8)    = 16
GEMINI_EMBEDDING_DAILY_BUDGET  = floor(1,000 × 0.8) = 800
```

한도값은 확정됐다. Vercel 운영 환경변수 등록과 실제 Upstash 검증이 끝날 때까지 배포 게이트를
유지한다.

### 3-2. Supabase Free

- Free 조직은 활성 프로젝트 2개까지 사용할 수 있다.
- 데이터베이스 크기 쿼터는 프로젝트당 **500 MB**, 통합 egress는 조직당 **5 GB**다.
- 현재 사용하는 PostgREST RPC에 대해 공식 문서가 일반적인 분당 요청 하드리밋을 제시하지는
  않는다. 이 서비스에서는 DB 크기·egress·공유 컴퓨트가 실질 제약이다.
- 따라서 Supabase 수치로 별도 요청 한도를 높이지 않는다. Gemini보다 먼저 적용되는 앱 자체
  제한으로 RPC 부하도 함께 제한한다.

### 3-3. Vercel Hobby

- 월 포함량은 Function 호출 **100만 회**, Active CPU **4시간**, Provisioned Memory
  **360 GB-hours**, Fast Data Transfer **100 GB**다.
- Hobby도 WAF rate limiting을 **프로젝트당 1규칙** 사용할 수 있다. 키는 IP 또는 JA4,
  알고리즘은 고정 윈도우, 창은 10초~10분이며 허용 요청 **100만 회**가 포함된다.
- WAF만으로는 1시간·24시간·글로벌 예산을 함께 표현할 수 없고 고정 윈도우 경계 버스트도
  발생한다. 따라서 WAF는 `POST /api/ask`의 **60회/10분/IP** 보조선으로만 사용한다.

### 3-4. Upstash Redis Free

- 무료 DB 한도는 월 **500,000 commands**, 저장공간 **256 MB**, 대역폭 **10 GB**,
  최대 **10,000 commands/s**다. 과거의 “일 10,000 commands” 정책은 폐기됐다.
- 공식 SDK 기준 슬라이딩 윈도우 `limit()`은 최초 5 commands, 이후 허용 요청은 보통
  4 commands를 사용한다. Analytics를 켜면 호출마다 1 command가 추가된다.
- 이 프로젝트 규모에서는 무료 한도로 충분하지만, 여러 창과 Gemini 실호출 예산을 함께
  계산해야 하므로 **Analytics는 끄고** Vercel 로그의 집계 정보만 사용한다.

## 4. 구현 계약

### 4-1. 처리 순서

1. 운영 요청의 신뢰 가능한 IP를 추출하고 HMAC 해시 식별자로 변환한다.
2. 외부 API 호출 전에 IP 3개 창과 글로벌 60초 창을 Upstash에서 원자적으로 판정한다.
3. Gemini 요청을 실제 전송하기 직전에 해당 모델의 60초 RPM과 최근 24시간 RPD 예산을
   하나의 원자적 판정으로 차감한다.
4. 하나라도 초과하면 이후 Gemini·Supabase 호출 없이 즉시 응답한다.

여러 창은 한 요청이 일부 카운터에만 반영되는 경쟁 상태가 없도록 Upstash REST의 원자적 Lua
실행 또는 동일한 원자성을 보장하는 `@upstash/ratelimit` 조합으로 구현한다. 서버 전용 환경
변수 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`을 사용하며 브라우저 번들에
노출하지 않는다.

### 4-2. IP 식별

- Vercel 운영 환경에서는 `@vercel/functions`의 `ipAddress(request)`를 우선 사용한다.
  직접 읽을 때는 Vercel이 제공하는 `x-vercel-forwarded-for`를 사용한다.
- 원본 IP를 Redis 키나 애플리케이션 로그에 저장하지 않고 서버 전용 salt로 HMAC 처리한다.
- 로컬 또는 예외 상황에서 IP가 없으면 요청마다 임의 값을 만들지 말고 `unknown` 공용 버킷을
  사용한다. 식별 실패가 제한 우회로 이어져서는 안 된다.

### 4-3. 장애 시 동작

- Production에서 Upstash 환경변수가 없거나 Redis 판정이 실패하면 **fail closed**로
  `503 RATE_LIMIT_UNAVAILABLE`을 반환하고 외부 API를 호출하지 않는다.
- SDK timeout의 기본 fail-open 결과도 운영에서는 성공으로 취급하지 않는다.
- 로컬 테스트에서 제한을 끄는 기능이 필요하면 production에서 활성화할 수 없는 명시적
  테스트 플래그로 분리한다.

## 5. 응답 계약

앱 자체 제한 초과 응답은 다음과 같다.

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Cache-Control: no-store
Retry-After: <seconds>
RateLimit-Limit: <limit>
RateLimit-Remaining: 0
RateLimit-Reset: <seconds>
```

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "요청이 많아 잠시 후 다시 시도해 주세요."
  }
}
```

- `Retry-After`와 `RateLimit-Reset`은 초과한 창 중 가장 늦은 해제 시점으로 계산한다.
- 공급자 429를 일반 `UPSTREAM_ERROR(502)`로 숨기는 기존 계약과 앱 자체 429를 구분한다.
- Vercel WAF가 먼저 차단하면 플랫폼 429가 앱 JSON 형식이 아닐 수 있으므로 프론트엔드는
  `Content-Type`을 확인하고 비 JSON 429도 같은 사용자 안내로 처리해야 한다.

## 6. 운영 게이트와 모니터링

배포 전 아래 항목을 모두 충족해야 한다.

- [x] 두 모델의 실측 원본 RPM·RPD와 80% 운영값 확정
- [ ] 확정된 글로벌·모델별 RPM·RPD를 Vercel 환경변수에 등록
- [ ] Upstash Free 사용량과 월 command 예상량 확인, Analytics 비활성화
- [ ] Vercel WAF를 `POST /api/ask`, IP, 60회/10분, 429로 설정
- [ ] 정상 요청, 각 창 경계, 동시 요청, IP 없음, Upstash timeout·오류를 테스트
- [ ] 429 JSON·헤더와 WAF 비 JSON 429의 프론트 처리를 브라우저에서 검증
- [ ] Vercel Usage, Upstash command 사용량, Gemini 쿼터, Supabase DB·egress를 주기 확인

Phase 3 로그인 이후에는 IP 제한을 제거하지 않고 사용자 ID 제한을 추가한다. 공유 IP의 오탐을
줄일 수는 있지만, 계정 다중 생성과 로그인 전 남용을 막기 위해 IP 보조선은 유지한다.

## 7. 공식 근거

- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini Developer API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Supabase billing and quotas](https://supabase.com/docs/guides/platform/billing-on-supabase)
- [Vercel platform limits](https://vercel.com/docs/limits)
- [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)
- [Vercel request headers](https://vercel.com/docs/headers/request-headers)
- [Upstash Redis pricing](https://upstash.com/pricing)
- [Upstash rate-limit command costs](https://upstash.com/docs/redis/sdks/ratelimit-ts/costs)
