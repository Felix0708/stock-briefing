# 📈 Stock Briefing — 내 종목 공시 AI 브리핑

보유 종목을 등록하면 **매일 아침 내 종목의 공시만 AI가 요약해 메일로** 보내주고,
웹에서는 공시에 대해 **질문하면 근거와 함께 답변**(RAG)하며,
🇰🇷🇺🇸🇯🇵 3개 시장 포트폴리오의 **실시간 수익률을 환율 자동 환산**으로 보여주는 서비스.
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
| 💼 **3개 시장 포트폴리오** | 한국·미국·일본 종목 등록(수량·평단가) → 실시간 시세 + USD/JPY 환율 자동 환산 → 원화 기준 수익률·비중 도넛차트 |
| 🔍 **종목 자동완성** | "skt", "삼전", "apple" 같은 입력도 정식 종목명·코드로 해석 |
| 👤 **회원 시스템** | 이메일 로그인(httpOnly 쿠키 세션), 닉네임, 알림 수신 토글. 보유 종목은 RLS로 본인만 접근 |

## 아키텍처

```
[배치 축 — GitHub Actions, 평일 07:30 KST]
  watchlist.yaml + 회원 보유 종목(Supabase)
      → dart.py (DART OpenAPI: 공시 목록·원문)
      → summarize.py (Gemini flash-lite 요약)
      → embed.py (Gemini 임베딩 → Supabase pgvector, RAG 인덱싱)
      → publish.py (GitHub Pages 대시보드 JSON)
      → emailer.py + notify.py (회원별 맞춤 메일, 중요 공시 ⚠️)

[웹 축 — Next.js on Vercel]
  /            공시 Q&A: 질문 → 임베딩 → match_filings 벡터검색 → Gemini 답변+출처
  /portfolio   로그인 · 종목 등록 · 실시간 시세/환율 · 수익률/비중 차트
  /api/*       ask · auth · holdings · quotes · stocks · coverage · collect
                └ collect는 workflow_dispatch로 배치 축의 수집을 원격 실행

[데이터 축 — Supabase]
  filings(공시 청크 + pgvector) · holdings(보유 종목, RLS) · Auth(회원)
```

## 모듈 구조

| 파일 | 역할 |
|---|---|
| `pipeline/main.py` | 오케스트레이터. `--dry-run`, `--index-only`, `--companies`, `--lookback` 지원 |
| `pipeline/dart.py` | DART API 클라이언트 (기업코드 캐시, 공시 목록, 원문 추출) |
| `pipeline/summarize.py` | Gemini 요약 (모델명 주입식, 재시도·종목별 실패 격리) |
| `pipeline/embed.py` | 공시 청크 임베딩 → Supabase 저장 (중복 스킵) |
| `pipeline/holdings.py` | 회원 보유 종목·구독자 조회 (수집 개인화의 데이터원) |
| `pipeline/notify.py` | 회원별 맞춤 메일 (중요 공시 키워드 감지, 발송 상한) |
| `pipeline/emailer.py` / `publish.py` | HTML 메일 발송 / 대시보드 JSON 저장 |
| `web/src/app/api/ask` | RAG 질문 답변 (rate limit, 일일 예산 관리) |
| `web/src/app/api/auth` | 회원 가입·로그인·닉네임·설정 (GoTrue REST + httpOnly 쿠키) |
| `web/src/app/api/holdings` | 보유 종목 CRUD (사용자 토큰 → PostgREST, RLS 강제) |
| `web/src/app/api/quotes` | 한·미·일 시세 + 환율 프록시 (교체 가능하게 격리) |
| `web/src/app/api/stocks` | 종목 자동완성 (국가별 필터) |
| `web/src/app/api/collect` | 온디맨드 수집 트리거 (종목명 자동 해석 → Actions 원격 실행) |
| `db/schema*.sql` | pgvector · holdings · RLS · 권한 (단계별 마이그레이션) |

## 설계 결정 기록 (요약)

자세한 배경은 [DEVLOG.md](DEVLOG.md) 참고.

- **GitHub Actions를 서버로**: public 저장소 무료 무제한 → 유지비 0원 배치.
- **실패 격리 원칙**: 종목·회원·API 하나의 실패가 전체를 멈추지 않는다.
- **비밀은 서버에만**: `NEXT_PUBLIC_` 금지, httpOnly 쿠키 세션, RLS로 행 단위 접근 제어.
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
- [ ] Phase 5: 해외 공시 (미국 SEC EDGAR · 일본 EDINET)
- [ ] Phase 6: 구독 결제 실험 (시세의 공식 API 전환 검토)

---
*본 프로젝트의 요약·답변은 투자 권유가 아니며, 투자 판단의 책임은 이용자 본인에게 있습니다.*
