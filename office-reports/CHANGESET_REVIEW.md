# Phase 2-2 변경 전수 검토 및 CI·push 판정

> 역사 스냅샷: 이 문서의 49·52개 및 19/19 판정은 작성 시점 기준이다. 최신 단일 판정은
> [최종 변경 검토·배포 승인 보고서](./PHASE2_2_FINAL_DEPLOYMENT_APPROVAL.md)를 따른다.

- 담당: 정사원
- 검토 시각: 2026-07-05 23:23 JST
- 기준 스냅샷: 수정 추적 7개 + 미추적 42개 = **49개**
- 범위: 목적, 중복, 누락, Secret 위험, 커밋 포함 여부
- 제한: 커밋·push·배포·운영 설정 변경 없음

## 결론

**현재 CI·push 단계 진입 불가.** 실행된 오프라인 검증은 통과했지만
`web/package-lock.json`이 없어 `quality.yml`의 `npm ci`가 반드시 실패한다. production
build와 `.next/static` Secret 검사, 운영 DB·Upstash·Vercel·브라우저 실측도 남아 있다.
추가로 Gemini 재시도 시 모델별 RPM 보호 공백 1건과 프론트엔드 중간 결함 3건이 확인됐다.

현재 변경 중 제품 코드·설정·검증 파일은 대부분 커밋 후보로 적절하다. 다만 시각별 통합
보고서 4개는 최신 정식 보고서와 중복되고 일부 제목·내용이 모순되므로 제품 변경 커밋에서
제외하거나 별도 기록 커밋으로 분리해야 한다.

## 검증 근거 통합

| 담당 영역 | 확인 결과 | 판정 |
|---|---|---|
| 백엔드·DB | API 16개 + DB 3개, 총 **19/19 통과** | 모킹·정적 계약 통과, 운영 실증은 아님 |
| TypeScript | 로컬 TypeScript 실행 파일로 strict 검사 통과 | 정식 `npm ci` 설치 결과로 재검증 필요 |
| Secret | 작업 트리·Git 이력·클라이언트 참조 검사 실패 0건 | production 번들 부재로 번들 검사는 SKIP |
| QA 스크립트 | 기본 QA 실패 0건·경고 3건 | 의존성·build·로컬 API 미실행 경고 |
| DB 운영 | `verify_schema.sql` 정적 계약 3/3 통과 | 운영 Supabase 적용·PASS 미확인 |
| 프론트엔드 | 구현·정적 구조 검토 완료 | 운영 URL·브라우저가 없어 실측 전 항목 미완료 |
| Rate Limit | IP 6/60·60/시간·200/일, 글로벌 8, 답변 16, 임베딩 800 정합화 | AI Studio 원본 활성 한도 재확인 필요 |
| 백엔드 변경 검토 | 글로벌 8은 질문 수만 제한해 재시도 시 모델 호출이 최대 24회/분 가능 | 모델별 실제 호출 RPM 카운터 필요 |
| 프론트 정적 검토 | 카운트다운·네트워크 timeout·라이트 muted 대비 결함 3건 | 수정 후 브라우저 실측 필요 |
| CI/CD | workflow 구조·셸·YAML 정적 확인 | lockfile 부재로 quality CI 실행 불가 |

## 파일별 판정 — 수정 추적 7개

| 파일 | 목적·검토 결과 | 커밋 판정 |
|---|---|---|
| `.env.example` | 웹 RAG·Rate Limit 변수 예시. 실제 Secret 없음. 8/16/800 계산값 반영 | 포함 |
| `.github/workflows/daily-briefing.yml` | 중복 실행 방지, 변수화, 변경 시에만 Pages 호출 | 포함, GitHub 실 CI 필요 |
| `.gitignore` | env·Next·Vercel·Python·인증서 산출물 차단 | 포함 |
| `README.md` | Phase 2-2 구조·QA·배포 문서 진입점 | 포함 |
| `SETUP.md` | Actions 변수·Supabase·Pages·Vercel 설정 절차 | 포함 |
| `db/schema.sql` | RLS, 4인자 RPC, service_role 전용 권한 | 포함, 운영 적용은 별도 |
| `docs/PLAN.md` | 로컬 임베딩 표현을 실제 Gemini 임베딩으로 정정 | 포함 |

## 파일별 판정 — 미추적 코드·설정·문서 30개

| 파일 | 목적·검토 결과 | 커밋 판정 |
|---|---|---|
| `.github/workflows/quality.yml` | `npm ci` fail-closed 품질 게이트 | 조건부 포함: lockfile 필수 |
| `db/verify_schema.sql` | 운영 RLS·RPC·역할 권한 검증 | 포함 |
| `docs/DEPLOYMENT.md` | GitHub·Vercel·Secret·배포 게이트 단일 기준 | 포함 |
| `docs/DESIGN_STOCK_FILTER.md` | 필터 UX 설계와 구현 상태 | 포함, 구현 완료 표기 정정 |
| `docs/RATE_LIMIT_POLICY.md` | 제한 수치·원자성·운영 절차 | 포함, AI Studio 재확인 조건 유지 |
| `scripts/check-markdown-links.py` | Markdown 로컬 링크 검사 | 포함 |
| `scripts/check-secrets.sh` | env·키 패턴·이력·클라이언트·번들 검사 | 포함, 알려진 패턴 기반 한계 있음 |
| `scripts/qa.sh` | 저장소 통합 QA 오케스트레이션 | 포함 |
| `web/.env.local.example` | 웹 서버 전용 환경변수 예시 | 포함 |
| `web/README.md` | 웹 실행·검증·환경변수 안내 | 포함 |
| `web/eslint.config.mjs` | Next·TypeScript ESLint 설정 | 포함 |
| `web/next-env.d.ts` | Next TypeScript 선언 | 포함 |
| `web/next.config.ts` | Next 설정 진입점 | 포함 |
| `web/package.json` | 고정 의존성·검증 스크립트 | 조건부 포함: lockfile과 함께 |
| `web/tsconfig.json` | strict TypeScript·`src` alias | 포함 |
| `web/src/app/api/ask/route.ts` | 입력·Rate Limit·오류 계약 API | 포함 |
| `web/src/app/globals.css` | 반응형·다크·접근성·상태 UI | 포함, 실브라우저 QA 필요 |
| `web/src/app/layout.tsx` | 한국어 메타데이터·루트 레이아웃 | 포함 |
| `web/src/app/page.tsx` | 질문 화면 셸·고지 | 포함 |
| `web/src/components/ask-panel.tsx` | 필터·질문·429·빈 결과·출처 UI | 포함, 실브라우저 QA 필요 |
| `web/src/lib/ask-types.ts` | API 요청·응답 공용 타입 | 포함 |
| `web/src/lib/server/ask.ts` | 검색·출처 정규화·답변 흐름 | 포함 |
| `web/src/lib/server/config.ts` | 서버 환경변수 검증 | 포함 |
| `web/src/lib/server/gemini.ts` | 임베딩·근거 답변 호출 | 포함 |
| `web/src/lib/server/http.ts` | timeout·재시도·오류 일반화 | 포함 |
| `web/src/lib/server/rate-limit.ts` | Upstash 원자 제한·IP HMAC·모델 예산 | 포함 |
| `web/src/lib/server/supabase.ts` | 4인자 RPC·Secret key 방식 분기 | 포함 |
| `web/tests/api-route.test.mjs` | API·Rate Limit 회귀 16개 | 포함 |
| `web/tests/db-schema.test.mjs` | DB 정적 계약 3개 | 포함 |
| `web/tests/ts-loader.mjs` | Node 테스트용 TS 로더 | 포함 |

## 파일별 판정 — 미추적 보고서 12개

| 파일 | 목적·중복 검토 | 커밋 판정 |
|---|---|---|
| `office-reports/PHASE2_2_QA.md` | 최신 통합 QA 기준 문서 | 포함 |
| `office-reports/INFRA_CICD_REPORT.md` | 인프라·CI 차단 근거 | 포함 |
| `office-reports/PHASE2_2_BACKEND_QA.md` | 백엔드 검토 근거 | 포함 |
| `office-reports/PHASE2_2_DB_APPLY_VERIFY.md` | 운영 DB 미적용 상태·재개 절차 | 포함 |
| `office-reports/PHASE2_2_FRONTEND_QA.md` | 미실측 프론트 QA 범위 | 포함 |
| `office-reports/PHASE2_2_IMPLEMENTATION_REPORT.md` | 구현 범위 요약 | 포함 |
| `office-reports/PHASE2_2_RATE_LIMIT_BACKEND.md` | Rate Limit 구현 근거 | 포함 |
| `office-reports/PROGRESS.md` | 작업 중단·재개용 진행 기록 | 포함 |
| `office-reports/2026-07-05_0557_프로젝트 구조 정리.md` | 이후 정식 보고서와 상당 부분 중복 | 제품 커밋 제외, 필요 시 기록 커밋 |
| `office-reports/2026-07-05_0713_Phase 2-2 마무리.md` | 최신 QA와 중복·일부 과거 수치 포함 | 제품 커밋 제외, 필요 시 기록 커밋 |
| `office-reports/2026-07-05_1052_Phase 2-2 로컬 검증 마무리 & 운영 인계 준비.md` | 채팅형 서문·과거 permission 원인으로 최신 상태와 충돌 | 제품 커밋 제외 |
| `office-reports/2026-07-05_1329_Phase 2-2 운영 배포 완료.md` | 내용은 배포 보류인데 파일명은 배포 완료로 모순 | 제품 커밋 제외 또는 파일명 정정 후 기록 분리 |

> 기존 통합 보고서의 “48개”는 오집계다. `PROGRESS.md`를 포함하면 검토 시작 시점은
> 49개였다. 검토 도중 담당자 보고서 2개와 이 보고서가 추가되어 최종 작업 트리는 52개다.

### 기준 스냅샷 이후 추가된 담당 보고서

| 파일 | 목적·검토 결과 | 커밋 판정 |
|---|---|---|
| `office-reports/PHASE2_2_BACKEND_CHANGE_REVIEW.md` | 모델별 실제 호출 RPM 보호 공백과 DB 계약 결과 | 포함 |
| `office-reports/PHASE2_2_FRONTEND_STATIC_REVIEW.md` | 프론트 정적 결함 3건과 실측 범위 | 포함 |
| `office-reports/CHANGESET_REVIEW.md` | 49개 기준 전수 판정과 담당 결과 통합 | 포함 |

## 중복·누락·Secret 리스크

### 해소한 항목

- Rate Limit 예시·테스트·정책을 글로벌 8, 답변 16, 임베딩 800으로 정합화했다.
- 종목 필터 설계 문서의 예시 질문·빈 결과·포커스 복귀 “미구현” 표기를 실제 구현과 맞췄다.
- `check-secrets.sh`가 `mktemp` 실패 시 즉시 실패하도록 보완됐다.
- 환경 예시 파일을 키 패턴 검사 대상에 다시 포함했다.
- Client Component 검사 대상을 Gemini·Supabase뿐 아니라 Upstash 토큰·IP HMAC 키까지 넓혔다.
- `qa.sh`의 임시 Python 캐시 디렉터리 생성 실패도 즉시 실패하도록 보완했다.

### 잔존 리스크

1. **lockfile 누락:** `web/package-lock.json` 없이 재현 설치와 quality CI가 불가능하다.
2. **모델 RPM 보호 공백:** 사용자 요청 글로벌 8회/분 뒤 Gemini가 요청당 최대 3회 재시도해
   장애 시 한 모델에 최대 24회/분을 시도할 수 있다. 일일 예산은 보호하지만 활성 RPM 8은
   보장하지 못한다.
3. **프론트 결함:** 429 카운트다운이 timer tick에 의존하고, client fetch timeout이 없으며,
   라이트 모드 `--text-muted` 대비가 약 3.03:1로 일반 텍스트 AA 4.5:1에 못 미친다.
4. **production 미검증:** lint·정식 typecheck·Next build·`.next/static` Secret 검사가 없다.
5. **운영 미검증:** Supabase schema PASS, Upstash, HMAC, Vercel env/WAF가 적용되지 않았다.
6. **브라우저 미검증:** 정상·빈 결과·429·503·timeout, 모바일·다크·IME·키보드·접근성 미실측이다.
7. **Secret 검사 한계:** 알려진 접두사·형식 중심이므로 고엔트로피 일반 토큰을 모두 탐지하지는 못한다.
8. **보고서 중복:** 과거 시점 보고서를 제품 커밋에 섞으면 현재 상태를 잘못 읽을 수 있다.
9. **외부 workflow 미실행:** `daily-briefing`의 push·Pages dispatch와 `quality`는 GitHub에서 실증되지 않았다.

## CI·push 체크리스트

### 현재 통과

- [x] 변경 49개 전수 분류
- [x] API·DB 회귀 19/19
- [x] 직접 TypeScript strict 검사
- [x] 기본 QA 실패 0건
- [x] Secret 정적 검사 실패 0건
- [x] 셸 구문, Markdown 링크, `git diff --check`
- [x] 확정 계산값 8/16/800 문서·예시·테스트 정합화
- [x] 제품 커밋 제외 권고 보고서 4개 식별
- [x] 백엔드·프론트 담당 정적 변경 검토 결과 통합

### CI 전 필수

- [ ] Gemini 모델별 60초 실제 호출 카운터를 전송 직전에 원자 차감하고 재시도 회귀 추가
- [ ] 429 deadline 기반 카운트다운, client fetch timeout·고정 한국어 transport 오류 구현
- [ ] 라이트 모드 muted 텍스트 대비 4.5:1 이상으로 수정
- [ ] npm Registry 가능 환경에서 `web/package-lock.json` 생성
- [ ] lockfile dependency tree·무결성·diff 검토
- [ ] 깨끗한 환경에서 `npm ci --prefix web`
- [ ] lint → typecheck → 19개 회귀 → build → `scripts/qa.sh --build`
- [ ] `.next/static` Secret 이중 검사
- [ ] 제품 커밋과 기록 보고서 커밋 범위 분리

### push 전 필수

- [ ] 위 로컬 CI 체인 전체 종료 0
- [ ] 운영 Supabase `schema.sql` 적용 후 `verify_schema.sql` PASS
- [ ] AI Studio에서 두 활성 모델 원본 RPM·RPD 재확인
- [ ] GitHub `quality / qa` 성공
- [ ] 사용자의 명시적 push 지시

**최종 판정: CI 준비 미완료 / push 금지 유지.**
