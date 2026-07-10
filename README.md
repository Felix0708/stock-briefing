# 📈 Stock Briefing — 내 종목 공시 AI 브리핑

보유 종목을 등록하면 **매일 아침 내 종목의 공시만 AI가 요약해 메일로** 보내주고,
웹에서는 공시에 대해 **질문하면 근거와 함께 답변**(RAG)하며,
🇰🇷🇺🇸🇯🇵 3개 시장 포트폴리오의 **실시간 수익률을 환율 자동 환산**으로 보여주는 서비스.
서버 없이 GitHub Actions + Vercel 무료 티어로 동작하며 **월 유지비 0원**.

> 🛠 **[개발 여정 보기 (DEVLOG.md)](DEVLOG.md)** — 7일간 무엇을 왜 그렇게 만들었는지의 기록
>
> 기획 배경과 로드맵은 [docs/PLAN.md](docs/PLAN.md), 설치는 [SETUP.md](SETUP.md),
> Phase 2-2 최신 검증 상태는 [office-reports/PHASE2_2_FINAL_DEPLOYMENT_APPROVAL.md](office-reports/PHASE2_2_FINAL_DEPLOYMENT_APPROVAL.md),
> CI/CD와 Vercel 설정은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) 참고.

## 아키텍처

```
┌─────────────────────────────────────────────────┐
│  GitHub Actions (cron: 평일 아침 07:30 KST)      　│
│                                                 │
│  watchlist.yaml                                 │
│       │                                         │
│       ▼                                         │
│  ① dart.py ──── DART OpenAPI                  　│
│  │   기업코드 매핑(캐시) → 신규 공시 목록 → 원문   │     │
│  ▼                                              │
│  ② summarize.py ──── Gemini Flash (무료 티어)     │
│  │   종목당 1회 호출로 공시 묶음 요약 (쿼터 절약)  │　　　　│
│  ▼                                       　　　　　│
│  ③ publish.py ──── docs/data/*.json 저장　　　　　　│
│  │   → GitHub Pages 웹 대시보드에 자동 반영　　　　　　  │
│  ▼                                              │
│  ④ emailer.py ──── Gmail SMTP (선택)　　　　　　　　　│
│      HTML 브리핑 메일 발송                          │
└─────────────────────────────────────────────────┘
```

**보는 방법 2가지** (둘 다 켜거나 하나만 켜도 됨):
- 🌐 웹 대시보드: `https://<아이디>.github.io/<저장소>/` — 모바일 반응형, 날짜별 아카이브
- 📧 이메일: 매일 아침 받은편지함으로 (`SEND_EMAIL=false`로 끌 수 있음)

## 모듈 구조

| 파일 | 역할 |
|---|---|
| `pipeline/config.py` | 환경변수·watchlist 로드. 외부 설정 접근의 단일 창구 |
| `pipeline/dart.py` | DART API 클라이언트 (기업코드 캐시, 공시 목록, 원문 추출) |
| `pipeline/summarize.py` | Gemini 요약. 모델명 주입식 (정책 변경 대비) |
| `pipeline/publish.py` | 웹 대시보드용 JSON 저장 (날짜별 아카이브) |
| `pipeline/emailer.py` | HTML 메일 빌드 + SMTP 발송 (선택) |
| `docs/index.html` | GitHub Pages 대시보드 (반응형, 다크모드, 빌드 도구 없음) |
| `pipeline/main.py` | 오케스트레이터. `--dry-run` 지원 |
| `db/schema.sql` | Supabase pgvector 테이블, RLS, 검색 RPC 정의 |
| `web/src/` | Next.js 질문 UI, API Route, 서버 전용 RAG 모듈 |
| `office-reports/` | 구현·QA 보고서와 진행 기록 |

## 설계 결정 기록

- **이메일 우선, 웹 없음 (Phase 1)**: 프론트를 빼서 완성 속도 확보. 제품 = 아침 메일.
- **종목당 Gemini 1회 호출**: 공시별 호출 대비 무료 쿼터 소모 1/N.
- **원문 추출 실패는 무시**: 제목만으로도 요약 가능하므로 파이프라인을 죽이지 않음.
- **기업코드 일 단위 캐시**: 10만 건 zip을 매 실행마다 받지 않음.

## 실행

```bash
python -m pipeline.main --dry-run   # briefing_preview.html 생성 (발송 없음)
python -m pipeline.main             # 실제 발송
```

전체 저장소 QA는 루트에서 실행합니다.

```bash
scripts/qa.sh          # Secret, Python, 웹 정적 검사
scripts/qa.sh --build  # production build와 브라우저 번들 Secret 검사 포함
```

## 로드맵

- [x] Phase 1: 공시 수집 → AI 요약 → 메일 브리핑 자동화
- [x] Phase 2-1: 공시 임베딩 + pgvector 인덱싱
- [ ] Phase 2-2: RAG Q&A 웹앱 실연동 QA와 Vercel 배포
- [ ] Phase 3: 구독 결제 실험

---
*본 프로젝트의 요약은 투자 권유가 아니며, 투자 판단의 책임은 이용자 본인에게 있습니다.*
