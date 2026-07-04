# 📈 Stock Briefing — 아침 공시 AI 브리핑

관심 종목의 신규 공시(DART)를 매일 아침 AI가 요약해서 이메일로 보내주는 파이프라인.
서버 없이 GitHub Actions로 동작하며 **월 유지비 0원**.

> 기획 배경과 로드맵은 [docs/PLAN.md](docs/PLAN.md), 설치는 [SETUP.md](SETUP.md) 참고.

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

## 로드맵

- [x] Phase 1: 공시 수집 → AI 요약 → 메일 브리핑 자동화
- [ ] Phase 2: 공시 임베딩 + RAG Q&A 웹앱 (Next.js + pgvector)
- [ ] Phase 3: 구독 결제 실험

---
*본 프로젝트의 요약은 투자 권유가 아니며, 투자 판단의 책임은 이용자 본인에게 있습니다.*
