# Phase 2-2 최종 변경 검토·배포 승인 보고서

- 기준 시각: 2026-07-06 22:06 JST
- 담당: 정사원 (검토·문서화·체크리스트·리스크)
- 범위: 현재 작업 트리 전수검토, 중복 보고 정리, 로컬 게이트, Preview·Production 브라우저 QA

## 최종 판정

**Production 배포 승인 보류 / push 금지 유지**

코드 결함 보완분과 모킹 회귀는 통과했다. Gemini 원본 한도 10/20·100/1,000과 운영값
8/16·80/800은 사용자 제공 실측값으로 확정됐으며 재측정 대상이 아니다. 그러나 재현 가능한
설치·production build·번들 Secret 검사, 운영 Supabase 스키마, Vercel 적용과 Preview
실브라우저 QA가 완료되지 않았다. 정적 검사나 모킹 결과를 운영 통과로 대체하지 않는다.

## 작업 트리 기준선

`git status --short --untracked-files=all`의 실제 파일 단위 집계를 사용했다.

- 2026-07-05 23:52 기준: 53개(추적 수정 7 + 미추적 46)
- 후속 프론트 파일 2개 추가 후 검토 시작 기준: 55개(추적 수정 7 + 미추적 48)
  - `web/src/lib/client/ask-request.ts`
  - `web/tests/client-ask.test.mjs`
- 이 최종 보고서 추가 후 09:04 기준: 56개(추적 수정 7 + 미추적 49)
- 운영 DB 적용·검증 보고서 추가 후 22:06 기준: **57개(추적 수정 7 + 미추적 50)**

현재 57개 구성은 루트 4, `.github` 2, `db` 2, `docs` 4, `scripts` 3,
`web` 24, `office-reports` 18이다. `.DS_Store`, `node_modules`, `.next`, `.vercel`,
`tsconfig.tsbuildinfo` 등 ignore 대상은 집계하지 않았다. 디렉터리를 축약하는 기본
`git status --short`의 15개 표시는 파일 수로 사용하지 않는다.

## 변경 전수검토 결과

| 영역 | 판정 | 확인 내용 |
|---|---|---|
| Python·Actions | 조건부 적합 | 파이프라인 구문과 Actions YAML 정적 구조는 통과. 실제 GitHub quality CI는 미실행 |
| DB | 조건부 적합 | 4인자 RPC, RLS, `service_role` 권한 계약 3건 통과. 운영 적용·`PASS`는 미확인 |
| API·Rate Limit | 로컬 적합 | IP 3창+글로벌 8 RPM, 모델별 RPM+RPD 원자 판정, fail-closed 계약 확인 |
| 프론트엔드 | 로컬 적합 | 경과시간 429, timeout·취소, 오류 정규화, AA 대비, IME·키보드 구조 확인 |
| Secret | 소스 적합 | 소스·Git 이력 실제 키 패턴 및 금지된 `NEXT_PUBLIC_` Secret 0건 |
| 배포·운영 | 부적합 | lockfile·build·CI·Vercel·운영 설정·실브라우저 증거 없음 |
| 보고서 | 정리 완료 | 본 문서를 최신 단일 판정으로 지정하고 과거 스냅샷에는 대체 안내를 추가 |

검토 중 글로벌 상한이 코드에서 12까지 허용되던 불일치를 8로 제한하고 회귀를 추가했다.
Vercel 변수 표의 모델별 RPM 항목과 정책의 RPM+RPD 원자 차감 설명도 현재 구현에 맞췄다.

## 중복·모순 보고서 정리 노트

본 문서를 승인 판단의 단일 기준으로 사용한다. 기존 파일은 삭제하거나 합치지 않고 당시
상태를 보여주는 역사 기록으로 보존한다.

| 문서군 | 중복·모순 | 처리 기준 |
|---|---|---|
| 날짜형 통합 보고서 6개 | 같은 Phase 2-2 최종 판정을 반복하며 수치·차단 사유가 작성 시점마다 다름 | 역사 스냅샷으로만 사용하고 현재 판정에는 인용하지 않음 |
| `2026-07-05_1329_Phase 2-2 운영 배포 완료.md` | 파일명은 완료이나 본문 판정은 배포 승인 보류 | 파일명 변경 시 링크 파손 위험이 있어 보존하되 완료 증거로 사용 금지 |
| `CHANGESET_REVIEW.md`, `PHASE2_2_QA.md` | 49·52개, 19/19 등 과거 기준이 본문에 남음 | 상단의 역사 스냅샷 안내를 따르고 최신 57개·26/26과 혼용 금지 |
| 백엔드·인프라 세부 보고서 | 과거 한도 미확정 표현, Upstash/Supabase 값 부재 등 당시 환경 상태가 남음 | 원본 한도는 확정. 로컬 값 존재와 Vercel 등록·DB SQL 적용 여부를 구분 |
| `PHASE2_2_FRONTEND_QA.md` | 실행 가능한 체크리스트 없이 미검증 결과만 기록 | Preview URL 연결 후 실행할 수 있도록 절차·합격 기준을 보강 |

테스트 수 19/19·22/22·25/25는 실패가 아니라 테스트 추가 전 시점의 기록이다. 최신 코드의
승인 근거는 26/26만 사용한다. 작업 트리 56→57 변화도 DB 적용 보고서 1개 추가에 따른 것으로
누락이나 삭제가 아니다.

## 직접 실행 결과

| 검사 | 결과 |
|---|---|
| API·클라이언트·DB 회귀 | **26/26 통과** |
| TypeScript strict 직접 실행 | **통과** |
| `scripts/qa.sh` | **통과**, 실패 0·경고 3 |
| `git diff --check` | **통과** |
| 셸 구문·Markdown 로컬 링크 | **통과** |
| npm Registry | **실패**, `ENOTFOUND registry.npmjs.org` |
| `npm ci` | **실패**, `web/package-lock.json` 부재 `EUSAGE` |
| npm lint/typecheck/build | **실패**, 정상 설치 부재로 실행 파일 없음(127) |
| `scripts/qa.sh --build` | **실패**, 회귀 통과 후 build 부재 실패 1·경고 2 |
| production 번들 Secret | **미실시**, `web/.next/static` 없음 |

## Preview 브라우저 QA

22:06 JST 재시도에서도 인앱 브라우저 목록은 0개였다. `web/.vercel/project.json`, 확정
Preview URL, `web/package-lock.json`, `web/.next`도 없다. 따라서 아래 항목은 **미검증**이다.

| 시나리오 | Preview | 로컬 모킹/정적 근거 |
|---|---|---|
| 정상 답변·DART 출처 | 미검증 | API 정상 응답·출처 중복 제거 회귀 통과 |
| 빈 결과·필터 해제 재검색 | 미검증 | 빈 출처 API와 UI 분기 정적 확인 |
| 429·경과시간 카운트다운 | 미검증 | Retry-After·deadline·재전송 잠금 회귀 통과 |
| 503 fail-closed | 미검증 | 설정 누락·Upstash 장애 API 회귀 통과 |
| 60초 timeout·사용자 취소 | 미검증 | 클라이언트 Abort·오류 정규화 회귀 통과 |
| 모바일 320·360·375·768px | 미검증 | 반응형 CSS만 정적 확인 |
| 다크모드·reduced motion | 미검증 | 미디어 쿼리만 정적 확인 |
| 한글 IME·Enter/Shift+Enter | 미검증 | `isComposing` 분기만 정적 확인 |
| Tab·포커스·스크린리더 | 미검증 | role·live region·focus 이동만 정적 확인 |
| 200% 확대·실제 대비 | 미검증 | 라이트 muted 색상 계산 대비 4.5:1 이상 회귀 통과 |

승인 순서는 **Preview QA 완료 → 사장님 GO/STOP → Production 배포 → Production 스모크
QA**다. Production QA는 Preview 승인 전에 완료할 수 없으므로 현재 Preview 승인 조건과
혼합하지 않는다. 상세 실행 절차와 증거 양식은 `PHASE2_2_FRONTEND_QA.md`를 따른다.

## 승인 차단 리스크

1. lockfile이 없어 `quality.yml`의 `npm ci`가 반드시 실패한다.
2. production build와 브라우저 번들이 없어 실행·Secret 노출 여부를 검증하지 못했다.
3. `quality.yml`을 포함한 Phase 2-2 전체 변경이 미추적/미커밋이므로 GitHub CI 증거가 없다.
4. 운영 Supabase에 `schema.sql` 적용 후 `verify_schema.sql`의 `PASS`를 확보하지 못했다.
5. 로컬 Upstash·Supabase 값은 준비됐지만 Vercel 이관, IP HMAC 등록, WAF 적용 증거가 없다.
6. Preview URL과 연결 가능한 브라우저가 없어 사용자 경로 전 항목이 미검증이다.

## 승인 전 체크리스트

- [ ] 네트워크 가능한 환경에서 `web/package-lock.json` 생성 및 dependency diff 검토
- [ ] `npm ci → lint → typecheck → test:api → build → scripts/qa.sh --build` 종료 0
- [ ] `web/.next/static` 실제 키 패턴 이중 검사 0건
- [ ] 운영 Supabase schema 적용과 `verify_schema.sql` 결과 `PASS`
- [x] Gemini 실측 원본 한도와 80% 운영값 확정(10/20→8/16, 100/1,000→80/800)
- [ ] Vercel Preview·Production 환경변수, 새 HMAC Secret, WAF 적용
- [ ] GitHub `quality / qa` 성공 확인
- [ ] 위 브라우저 QA 표의 Preview 전 항목 실측 및 증거 기록
- [ ] 사장님 Production GO 후 배포 및 Production 스모크 QA

Preview QA와 사장님 GO 전에는 Production 배포를 승인하지 않는다. 커밋·push는 별도 지시
전까지 금지한다. 이번 작업에서는 git push, Vercel 연결·배포, 운영 Secret 등록, DB 변경을
수행하지 않았다.
