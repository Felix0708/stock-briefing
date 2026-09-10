# 📈 Stock Briefing — 내 종목 공시 AI 브리핑

보유 종목을 등록하면 **매일 아침 내 종목의 공시만 AI가 요약해 메일로** 보내주고,
웹에서는 공시에 대해 **질문하면 근거와 함께 답변**(RAG)하며,
🇰🇷🇺🇸🇯🇵 3개 시장 포트폴리오의 **최근 조회 시세 기준 수익률을 환율 환산**으로 보여주는 서비스.
서버 없이 GitHub Actions + Vercel 무료 티어로 동작하며 **월 유지비 0원**.

> 🛠 **[개발 여정 보기 (DEVLOG.md)](DEVLOG.md)** — 7일간 무엇을 왜 그렇게 만들었는지의 기록
>
> 기획 배경과 로드맵은 [docs/PLAN.md](docs/PLAN.md), 설치는 [SETUP.md](SETUP.md),
> CI/CD와 Vercel 설정은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 참고.

## 주요 기능

| 기능 | 설명 |
|---|---|
| 🌅 **아침 맞춤 브리핑** | 매일 07:30, 회원별로 자기 보유 종목의 신규 공시만 AI 요약해 메일 발송. 유상증자·합병 등 중요 공시는 제목에 ⚠️ 표시 |
| 💬 **공시 Q&A (RAG)** | "삼성전자 시설투자 얼마야?" → 벡터 검색으로 관련 공시 원문을 찾아 근거 링크와 함께 답변 |
| 📥 **온디맨드 수집** | DB에 없는 종목을 질문하면 그 자리에서 수집 버튼 → GitHub Actions가 최근 90일 공시를 인덱싱 → 완료 시 자동 재검색 |
| 💼 **3개 시장 포트폴리오** | 최근 시세·환율 조회, 계좌/증권사 필터, 통화 보기 저장. 일부 시세·환율 누락 시 합계와 추정 비중에 표시 |
| 📝 **직접 투자 매매 이력** | 실제 체결 내역을 기록해 직접 잔고·평단 갱신, 통화/증권사별 실현손익 집계. 실제 주문은 보내지 않음 |
| 📡 **공시·메일 상태** | 종목별 수집 완료/신규 없음/실패 구분, 최근 성공 시각과 본인 메일 전달 결과 확인 |
| 🔍 **종목 자동완성** | "skt", "삼전", "apple" 같은 입력도 정식 종목명·코드로 해석 |
| 👤 **회원 시스템** | 이메일 로그인(httpOnly 쿠키 세션), 닉네임, 알림 수신 토글. 보유 종목은 RLS로 본인만 접근 |
| 🔗 **Stock-Trading 연동** | 회원별 1회 표시 토큰으로 로컬 러너의 전체 잔고 스냅샷 동기화. 서버에는 SHA-256 해시만 저장 |
| 🕶️ **공개 범위 동의** | 기본 비동의. watchlist와 동의 회원의 종목명만 익명·중복 제거해 공개 브리핑에 포함 |

## 아키텍처

```
[배치 축 — GitHub Actions, 평일 07:30 KST]
  내부 수집: watchlist.yaml + 전 회원 보유 종목(Supabase)
      → dart.py (DART OpenAPI: 공시 목록·원문)
      → summarize.py (Gemini flash-lite 요약)
      → embed.py (Gemini 임베딩 → Supabase pgvector, RAG 인덱싱)
      → publish.py (공개 JSON은 watchlist + 공개 동의 종목만)
      → emailer.py + notify.py (회원별 맞춤 메일, 중요 공시 ⚠️)

[웹 축 — Next.js on Vercel]
  /            공시 Q&A: 질문 → 임베딩 → match_filings 벡터검색 → Gemini 답변+출처
  /portfolio   로그인 · 종목 등록 · 연동 토큰 · 공개 동의 · 수익률/비중 차트
  /api/*       ask · auth · holdings · integration-token · sync/holdings · quotes 등
                └ collect는 workflow_dispatch로 배치 축의 수집을 원격 실행

[데이터 축 — Supabase]
  filings · holdings(RLS) · member_settings(RLS) · integration_tokens(서버 전용 해시) · Auth
```

## 모듈 구조

| 파일 | 역할 |
|---|---|
| `pipeline/main.py` | 오케스트레이터. `--dry-run`, `--index-only`, `--companies`, `--lookback` 지원 |
| `pipeline/dart.py` | DART API 클라이언트 (기업코드 캐시, 공시 목록, 원문 추출) |
| `pipeline/edgar.py` | SEC EDGAR 클라이언트 — 미국 공시. DART와 동일한 형식으로 반환해 하위 파이프라인 재사용 |
| `pipeline/edinet.py` | EDINET 클라이언트 — 일본 공시 (날짜별 조회 → secCode 필터). API 키 필요 |
| `pipeline/summarize.py` | Gemini 요약 (모델명 주입식, 재시도·종목별 실패 격리) |
| `pipeline/embed.py` | 공시 청크 임베딩 → Supabase 저장 (중복 스킵) |
| `pipeline/holdings.py` | 회원 보유 종목·구독자 조회 (수집 개인화의 데이터원) |
| `pipeline/notify.py` | 회원별 맞춤 메일 (중요 공시 키워드 감지, 발송 상한) |
| `pipeline/emailer.py` / `publish.py` | HTML 메일 발송 / 대시보드 JSON 저장 |
| `web/src/app/api/ask` | RAG 질문 답변 (rate limit, 일일 예산 관리) |
| `web/src/app/api/auth` | 회원 가입·로그인·닉네임·설정 (GoTrue REST + httpOnly 쿠키) |
| `web/src/app/api/holdings` | 보유 종목 CRUD (사용자 토큰 → PostgREST, RLS 강제) |
| `web/src/app/api/integration-token` | 로그인 회원의 개인 연동 토큰 발급·재발급·폐기. 원문은 발급 응답에서 한 번만 표시 |
| `web/src/app/api/sync/holdings` | 연동 토큰 인증 전체 스냅샷 API. 회원 ID는 토큰 해시 조회 결과에서만 결정 |
| `web/src/app/api/quotes` | 한·미·일 시세 + 환율 프록시 (교체 가능하게 격리) |
| `web/src/app/api/stocks` | 종목 자동완성 (국가별 필터) |
| `web/src/app/api/collect` | 온디맨드 수집 트리거 (종목명 자동 해석 → Actions 원격 실행) |
| `db/schema*.sql` · `supabase/migrations/*.sql` | pgvector · holdings · 자동매매 성과 · RLS · 권한 (단계별 마이그레이션) |

## Stock-Trading 스냅샷 API

계좌 총자산·현금·날짜별 이력은 별도의 [계좌 자산 API v1](docs/ACCOUNT_EQUITY.md)을 사용합니다. 아래 기존 보유종목 API 계약은 그대로 유지합니다.

포트폴리오에서 발급한 토큰을 로컬 Stock-Trading 러너에만 저장하고 다음 계약으로 호출합니다.
같은 종목도 증권사별 행으로 보내며, 같은 증권사·시장·종목·계정유형 안에서만 수량과 가중평균 단가를 합산합니다.

```http
PUT /api/sync/holdings
Authorization: Bearer sb_sync_...
Content-Type: application/json

{
  "holdings": [
    {
      "market": "KR",
      "stock_code": "005930",
      "stock_name": "삼성전자",
      "quantity": 10,
      "avg_price": 71200,
      "account_type": "live",
      "broker": "KIWOOM"
    }
  ],
  "performance": [
    {
      "broker": "KIWOOM",
      "account_type": "live",
      "all": { "count": 12, "wins": 7, "losses": 4, "draws": 1, "win_rate": 63.64 },
      "month": { "count": 3, "wins": 2, "losses": 1, "draws": 0, "win_rate": 66.67 },
      "realized": {
        "KRW": { "count": 8, "profit_loss": 125000, "return_rate": 4.21 },
        "USD": { "count": 4, "profit_loss": -32.5, "return_rate": -1.84 }
      },
      "excluded_full_exits": 2,
      "updated_at": "2026-09-03T00:00:00Z"
    }
  ]
}
```

`account_type`은 `paper` 또는 `live`, `broker`는 `KIWOOM` 또는 `KIS`입니다.
`holdings`와 `performance`는 모두 필수 배열이며, 빈 배열은 해당 자동 동기화 스냅샷 전체 삭제를 뜻합니다.
보유종목과 성과는 한 트랜잭션에서 함께 교체되고 수동 등록 행과 다른 회원 행은 건드리지 않습니다.
성과는 계좌별 집계값만 받으며 원시 주문·체결내역, `user_id`, 증권사 API 키·비밀번호·계좌번호는 요청
필드가 아니므로 보내면 거부됩니다. 완료 거래가 없거나 승·패 없이 무승부만 있으면 `win_rate`는
`null`입니다. 이 데이터와 `important_sections` 공개 JSON은 참고용이고 자동 주문 조건이 아닙니다.

## 설계 결정 기록 (요약)

### 로그인·가입 보호

- 모든 `/api/*` 변경 요청은 공통 Proxy에서 같은 출처의 `Origin`을 요구한다. 다른 출처·누락된 Origin과 교차 사이트 요청은 로그인/쿠키 발급 전에 403으로 차단한다. 공개 Q&A의 POST와 Bearer 토큰 전용 Stock-Trading 동기화 PUT만 제외하며, 각 API의 인증·소유자 검사도 그대로 유지한다. 쿠키 인증 API를 스크립트로 호출할 때는 사이트 URL의 Origin을 함께 보내야 한다.
- 웹 회원가입은 [HIBP Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords)로 유출 비밀번호를 차단한다. 서버에서 SHA-1 해시 앞 5글자만 전송하고 응답 패딩을 사용한다. 비밀번호·전체 해시·이메일은 HIBP에 보내지 않는다. 조회 실패 시 가입만 잠시 중단하고 기존 로그인은 유지한다. SHA-1은 조회 프로토콜용이지 비밀번호 저장 방식이 아니다.
- 현재 Supabase 무료 요금제에는 [기본 유출 비밀번호 보호(Pro 이상)](https://supabase.com/docs/guides/auth/password-security)가 없어 Advisor 경고는 남는다. 위 검사는 **웹 가입 경로의 보완책**이며 직접 Supabase Auth API를 통한 가입·비밀번호 변경이나 기존 비밀번호까지 보호하지 않는다. 유료 전환 없이 경고를 숨기거나 해결됐다고 표시하지 않는다.

### 포트폴리오 계산·거래 기록 기준

- 실계좌 합계에 모의계좌는 포함하지 않는다. 같은 증권사의 직접 등록과 자동 실계좌는 비중을 함께 계산한다.
- 시세가 없는 종목은 평가합계에서 제외하고 반영 종목 수를 표시한다. 비중은 해당 종목의 매입가를 이용한 추정값이라고 안내하며, 환율도 없으면 비중을 계산하지 않는다.
- 상단 매입가는 **현재 환율로 환산한 매입가**다. 원화 손익/누적성과 환산은 참고용이고 실제 환차손익, 수수료, 세금은 포함하지 않는다. 자동매매 누적성과의 JPY 항목은 추가하지 않았다.
- 기존 ‘종목 등록’은 잔고 보정용이다. ‘직접 투자 · 매매 이력’은 기능 적용 당시 잔고를 시작점으로 거래일 순서(같은 날은 입력 시각 순서)로 계산한다. 별도로 직접 보정한 잔고는 해당 시점의 절대 기준으로 유지된다. 시작 잔고에 이미 포함된 과거 매수를 중복 입력하면 안 된다.
- 모든 과거 거래를 정정·취소할 수 있고 이후 매매, 잔고, 평단, 실현손익도 함께 다시 계산한다. 최초 입력과 정정 사유·변경 이력은 보존하며, 잔고가 부족해지는 정정은 전체 취소한다. 같은 요청 ID 재전송은 중복 처리하지 않는다. 잔고 삭제는 매도가 아니며 8초 안에 취소할 수 있다.
- 수집/메일 상태는 기능 적용 이후부터 기록된다. 메일 전달 완료는 SMTP 접수 기준으로, 수신함 도착을 보장하는 표시는 아니다.

웹 전용 `POST /api/manual-trades`는 로그인 세션으로 인증한다. 필수 필드는 `request_id`(UUID), `market`, `stock_code`, `stock_name`, `broker`, `side`(`BUY`/`SELL`), `quantity`, `price`, `traded_on`(YYYY-MM-DD)이다. 사용자 ID는 검증된 세션에서만 정한다. `GET /api/manual-trades`는 최근 50건과 전체 매도 집계를 반환하며 `before` 커서로 이전 이력을 조회한다.
`PATCH /api/manual-trades`는 `request_id`, `trade_id`, `expected_revision`, `trade`(위 거래 필드에서 request_id 제외), `cancelled`, `reason`을 받는다. `GET /api/manual-trades?trade_id=...`로 정정 이력을 확인한다.
기존 `PUT /api/sync/holdings` 계약과 `important_sections`는 변경하지 않았다. Stock-Trading의 추가 수정은 필요 없다.

### 공시 재처리·백업

종목별 마지막 수집 성공 시점부터 누락 기간을 다시 조회한다. 공시별 본문·요약·발송 대기열과 수신자별 전달 기록을 저장하고, SMTP 결과가 불명확하면 Gmail 보낸편지함에서 **앱 전용 Message-ID**를 검색한 뒤 재시도한다. 이전 버전 메일은 승인된 범위인 발신자·수신자·이 앱의 브리핑 제목·공시 접수번호가 모두 일치하는지 검색해 중복을 제외한다. 검색 결과의 ID만 사용하며 메일 제목·본문을 내려받지 않는다. SEC는 같은 공시의 첨부자료까지, EDINET은 XBRL/HTML 또는 PDF 원문을 읽는다. 원문 조회 실패는 ‘공시 없음’이 아니며 제목만 보고 AI 요약을 만들지 않는다.

포트폴리오에서 잔고·매매 CSV와 JSON 백업을 내려받을 수 있다. JSON 복원은 미리보기·교체 확인 후 실행하며 복원 직전 상태를 따로 보관한다. 사용자 승인 후 매일 KST 09:17에 암호화 백업을 생성하고 GitHub Actions에 암호문만 30일 보관하도록 활성화했다. 매번 격리 PostgreSQL에서 복원 대조하며, 첫 원격 백업을 다시 내려받아 복원하는 검사도 통과했다. 범위와 복구 절차는 [복구 운영 문서](docs/RECOVERY_WORK.md)를 참고한다.

자세한 배경은 [DEVLOG.md](DEVLOG.md) 참고.

- **GitHub Actions를 서버로**: public 저장소 무료 무제한 → 유지비 0원 배치.
- **실패 격리 원칙**: 종목·회원·API 하나의 실패가 전체를 멈추지 않는다.
- **비밀은 서버에만**: `NEXT_PUBLIC_` 금지, httpOnly 쿠키 세션, RLS로 행 단위 접근 제어.
- **공개 최소화**: 비동의 보유종목도 개인 메일·RAG 수집에는 사용하지만 `docs/data`에는 포함하지 않음.
- **교체 가능성 격리**: 비공식 시세 API는 `/api/quotes` 한 파일에 가둠 — 공식 API 전환 시 이 파일만 교체.
- **수익률은 현지 통화, 평가액은 원화**: 주가 변동과 환율 변동을 한 숫자에 뭉개지 않는다.

## 실행

```bash
# 파이프라인 (로컬)
python -m pipeline.main --dry-run                     # 미리보기 (발송 없음)
python -m pipeline.main                               # 전체 실행
python -m pipeline.main --index-only --companies "현대차" --lookback 90   # 특정 종목 인덱싱만

# 웹 (web/)
npm run dev          # 로컬 개발
npm run typecheck && npm run lint && npm run test:api  # 검증
```

## 로드맵

- [x] Phase 1: 공시 수집 → AI 요약 → 메일 브리핑 자동화
- [x] Phase 2-1: 공시 임베딩 + pgvector 인덱싱
- [x] Phase 2-2: RAG Q&A 웹앱 + Vercel 배포
- [x] Phase 3: 회원(로그인) · 포트폴리오(수익률·비중) · 회원별 맞춤 알림
- [x] Phase 3.5: 보유 종목 기반 수집 개인화 · 온디맨드 수집 · 종목 자동완성
- [x] Phase 4: 미국·일본 주식 (해외 시세 + 환율 자동 환산)
- [x] Phase 5-1: 미국 공시 (SEC EDGAR — 8-K/10-Q/10-K 및 실제 내부자 매수·매도 Form 4 수집·한국어 요약·RAG 합류)
- [x] Phase 5-2: 일본 공시 (EDINET — 날짜별 조회 + secCode 필터, API 키 필요)
- [ ] Phase 6: 구독 결제 실험 (시세의 공식 API 전환 검토)

---
*본 프로젝트의 요약·답변은 투자 권유가 아니며, 투자 판단의 책임은 이용자 본인에게 있습니다.*
