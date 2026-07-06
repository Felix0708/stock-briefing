# Phase 2-2 최종 통합 QA 보고서

> 역사 스냅샷: 누적 실행 기록은 보존한다. 최신 작업 트리·회귀 수·승인 판정은
> [최종 변경 검토·배포 승인 보고서](./PHASE2_2_FINAL_DEPLOYMENT_APPROVAL.md)를 따른다.

> 검증일: 2026-07-05 JST  
> 담당: 정사원  
> 범위: 설치·정적 검사·API/DB 회귀·production build·실연동·브라우저·Secret  
> 이 문서는 같은 날짜의 프론트엔드·백엔드 QA 보고서보다 최신 판정을 우선한다.

## 최종 판정

**배포 승인 보류 / Phase 2-2 조건부 미완료**

종목 필터와 rate limit 통합 후 API·DB 모킹 테스트 18건 및 직접 TypeScript 검사는
통과했다. 그러나 lockfile과 정상 의존성 설치가 없어 lint·정상 typecheck·production
build를 재현하지 못했고, 외부 네트워크와 인앱 브라우저 부재로 운영 DB·실서비스·화면
검증도 완료하지 못했다. production 번들이 생성되지 않았으므로 번들 Secret 검사 역시
통과로 처리할 수 없다.

rate limit의 IP·글로벌·모델별 예산 코드와 환경변수 문서는 통합됐지만 실제 Upstash,
AI Studio 예산, Vercel WAF는 설정되지 않았다. 남은 차단 항목을 해소하기 전에는 Vercel
배포를 승인하지 않는다.

## 실행 결과

| 검사 | 결과 | 증거 |
|---|---|---|
| 실행 환경 | 통과 | Node.js `v20.17.0`, npm `10.8.3` |
| lockfile 생성 | 차단 | 온라인 설치는 레지스트리 응답 없이 80초 이상 대기해 중단, 오프라인은 `ENOTCACHED` |
| `npm ci` | 실패 | `web/package-lock.json` 부재로 `EUSAGE` |
| `npm run lint` | 차단 | 정상 설치가 없어 `eslint: command not found` |
| `npm run typecheck` | 차단 | npm 실행 링크가 없어 `tsc: command not found` |
| 직접 TypeScript 검사 | 통과 | `node node_modules/typescript/bin/tsc --noEmit` 종료 0 |
| API·DB 모킹 회귀 | 통과 | 18/18, 실패 0 |
| `npm run build` | 차단 | `next: command not found` |
| `scripts/qa.sh --build` | 실패 | 실패 1건(build), 경고 2건(개발 의존성·로컬 API 미실행) |
| Secret·Python·문서·공백 검사 | 통과 | Secret 실패 0건, Python 구문 정상, Markdown 링크 14개 정상, 이전 경로·공백 오류 없음 |
| 워크플로·셸 문법 | 통과 | Actions YAML 3개 파싱, `scripts/*.sh` 구문 정상 |

API·DB 테스트가 확인한 현재 계약은 다음과 같다.

- 입력·질문·company 경계값과 company RPC 전달
- 정상 답변, 빈 검색 결과, DART URL 필터 및 출처 중복 제거
- Gemini/Supabase 인증·timeout 오류 일반화와 Secret 비노출
- DB 4인자 RPC, RLS, 역할별 권한 및 배포 후 검증 SQL
- Upstash IP·글로벌 제한, Gemini 모델별 예산·재시도 차감, 429·503, 표준 제한 헤더,
  Vercel IP 정규화·HMAC, 전달 헤더 스푸핑 방지
- rate-limit 저장소 장애와 필수 설정 누락의 fail-closed `503 RATE_LIMIT_UNAVAILABLE`

## 실연동·브라우저 결과

루트 로컬 환경에는 Gemini와 Supabase 필수 변수명이 설정돼 있음을 값 출력 없이 확인했다.
서버 모듈을 직접 호출한 결과 Gemini Embedding과 Supabase RPC 모두 상태 코드 없이
`UpstreamError`로 종료됐다. 현재 실행 환경의 외부 네트워크/DNS 제한으로 판단되며,
정상·실데이터 빈 결과·실제 인증/429/5xx 시나리오는 운영 서비스 기준으로 검증하지 못했다.

인앱 브라우저 목록은 비어 있었고 Next.js 실행 파일도 없어 로컬 서버를 기동할 수 없었다.
따라서 데스크톱, 320·360·375·768px, 다크모드, 키보드, 한글 IME, 200% 확대,
상태 안내 및 실제 접근성 동작은 미검증이다. 정적 코드에서는 아래 항목만 확인했다.

- Enter/Shift+Enter/IME 조합 방지, 로딩 중 입력 잠금, 결과 포커스 이동
- 종목 필터 요청 연동, 예시 질문의 전체 검색, 필터 지우고 재검색
- 429 `Retry-After` 카운트다운, 재시도 잠금
- `role`, `aria-live`, `aria-pressed`, 새 창 DART 링크 이름, focus-visible
- 320px 최소 폭, 모바일 미디어 쿼리, 다크모드, reduced-motion, 긴 텍스트 줄바꿈

정적 확인은 실제 브라우저 통과를 대체하지 않는다.

## 남은 배포 차단 사항

1. **lockfile·production 검증 부재**  
   네트워크 가능한 환경에서 lockfile을 생성·검토하고 `npm ci`, lint, typecheck, API·DB
   테스트, build, `scripts/qa.sh --build`를 모두 종료 0으로 통과해야 한다.

2. **rate limit 운영 설정 미반영**  
   환경 예시와 배포표에는 Upstash 연결, IP HMAC 키, 글로벌 RPM, 모델별 일일 예산이
   반영됐다. 그러나 현재 로컬 환경에는 이 필수 값들이 없고 Upstash·Vercel 프로젝트도
   연결되지 않아 실제 Route는 fail-closed 503으로 종료된다.

3. **운영 서비스 미검증**  
   최신 `db/schema.sql` 적용과 `db/verify_schema.sql` 실행, 실제 Gemini·Supabase 정상·빈
   결과·인증·429·5xx·timeout, 로그/응답 Secret 비노출을 운영 환경에서 확인해야 한다.

4. **브라우저·production 번들 미검증**  
   지정 뷰포트, 라이트·다크, 키보드·IME·접근성·429/503 화면을 확인하고 `.next/static`의
   Secret 검사를 통과해야 한다. 현재 `.next` 산출물은 없다.

5. **외부 운영 정책 미반영**  
   AI Studio 활성 RPM/RPD 확인, Upstash 생성·Analytics 비활성화, Vercel WAF
   `POST /api/ask` 60회/10분/IP 설정이 필요하다.

## 재검증 순서

```bash
cd web
npm install
# 생성된 package-lock.json과 dependency diff 검토
rm -rf node_modules
npm ci --no-audit --no-fund
npm run lint
npm run typecheck
npm run test:api
npm run build
cd ..
scripts/qa.sh --build
```

운영 환경변수와 DB 스키마 적용 후 로컬/Preview 서버에 대해 실제 API와 브라우저 QA를
수행한다. 위 차단 사항이 모두 해소되고 최종 QA가 실패 0건일 때만 배포 승인으로 변경한다.

Git push, 운영 Supabase 변경, Vercel 배포는 수행하지 않았다.

---

## 2026-07-05 20:05 JST 최종 배포 게이트 통합 검증 (정사원)

> 담당: 최종 배포 게이트 통합 검증 — 오차장 production 번들 Secret grep 교차확인,
> API·DB 회귀·TypeScript strict·`qa.sh`·`git diff --check` 재확인, 담당별 완료/차단
> 대조 체크리스트, 최종 판정.

### 최종 판정

**배포 승인 보류 유지.** 이번 세션에서도 `npm`·`node <스크립트>`·`bash <스크립트>` 실행이
전부 승인 거부되어(오차장 19:48 JST 보고와 동일한 harness 명령 게이트) 실행 기반 재검증을
직접 재현하지 못했다. 대신 permission이 허용하는 `git`·`rg`/`grep`·파일 읽기로 교차검증을
수행했고, 그 범위 안에서는 기존 보고와 100% 일치했다. **새로운 차단 사유도, 새로운 완료
사유도 없다** — 상태는 19:48 JST 보고 이후 변동 없음.

### 1) production 번들 Secret grep 교차확인

| 확인 | 결과 |
|---|---|
| `web/.next` 존재 여부 | **없음** — `ls web/.next` → `No such file or directory` |
| 번들 Secret grep 재현 가능 여부 | **불가** — 검사 대상(번들)이 아예 생성된 적 없음 |
| 소스 레벨 `AIzaSy` 검색 (`web/`, `pipeline/`, `db/`, `docs/`, `scripts/`) | **0건** |
| 소스 레벨 `NEXT_PUBLIC_(GEMINI_API_KEY\|SUPABASE_SECRET_KEY\|SUPABASE_SERVICE)` 검색 (`web/`) | **0건** |
| `sb_secret_`·`eyJhbGciOiJIUzI1Ni` 매치 | `check-secrets.sh`·`qa.sh`의 패턴 정의, `supabase.ts`의 접두사 검증 문자열뿐 — 실제 키 아님 |
| `git ls-files '*.env*'` | `.env.example` 단 하나만 추적 |

오차장의 "번들 Secret 0건" 결론은 **번들이 없어 원천적으로 검사 자체가 성립하지 않는다**는
의미였고, 이번 재확인도 동일 결론이다. 소스 레벨 검사는 오차장 보고와 완전히 일치해
교차확인 통과로 처리하되, **production 번들 Secret 검사는 여전히 "미실시"이지 "통과"가
아니다.** 이 구분을 배포 게이트 판정에 반영한다.

### 2) 실행 기반 검증 재확인 결과

| 검사 | 이번 세션 결과 | 비고 |
|---|---|---|
| `git diff --check` | **통과** (직접 재실행, 종료 0) | 공백 오류 없음 |
| 소스 Secret 정적 검사 (`rg` 수동 재현) | **통과** | 위 표 참고 |
| `npm -v` / `npm ci` / `npm run test:api` 등 | **차단** | 세션이 명령 실행 자체를 승인 거부, `npm -v`조차 거부됨 |
| `node <스크립트>` (예: `tsc --version` 직접 실행) | **차단** | 동일 게이트 |
| `bash scripts/qa.sh` | **차단** | 동일 게이트 |
| `web/package-lock.json` | 여전히 없음 | 19:48 JST 이후 변동 없음 |
| `web/node_modules/.bin` | 여전히 없음 | `next`·`react`·`typescript` 등 일부만 존재, 실행 파일 없음 |
| `web/.next` | 여전히 없음 | production build 이력 없음 |

API·DB 회귀(19/19)·TypeScript strict·`qa.sh` 실행 결과는 **직접 재실행으로 재현하지
못했다.** 대신 테스트 파일을 읽기 전용으로 대조해 구조적 정합성만 확인했다:
`web/tests/api-route.test.mjs`에 `test(` 16건, `web/tests/db-schema.test.mjs`에 3건으로
합계 19건이 존재해 강대리의 "API·DB 19/19 통과" 보고와 **테스트 개수는 일치**한다. 다만
이는 코드 대조이지 실행 재현이 아니므로 "통과 재확인"이 아니라 "정합성 확인"으로만
기록한다.

### 3) 배포 게이트 통합 체크리스트 (담당별 완료 vs 잔존 차단)

| 담당 | 완료 | 잔존 차단 |
|---|---|---|
| 오차장 (인프라·CI/CD) | `.gitignore` 통합, `quality.yml`(`npm ci` fail-closed), `docs/DEPLOYMENT.md`, rate-limit 환경변수 예시·Vercel 변수표 반영, 소스 Secret 정적 검사 | lockfile 생성, Upstash·Vercel 프로젝트 실연결, WAF 규칙 적용, production 번들 Secret 검사(대상 부재) |
| 강대리 (백엔드·DB·rate-limit) | `db/schema.sql`(4인자 RPC·RLS·권한), `db/verify_schema.sql`, `rate-limit.ts`(IP·글로벌·모델별 예산 원자 판정, IP HMAC, fail-closed 503), API·DB 회귀 19/19(코드 기준), TypeScript strict(코드 기준) | 운영 Supabase에 `schema.sql` 적용 및 `verify_schema.sql` 실행, 실제 Gemini·Supabase 정상/빈 결과/인증오류/timeout 호출 |
| 최과장 (분석·리서치) | `docs/RATE_LIMIT_POLICY.md` 확정(IP 6/60·60/1h·200/24h, 전체 12/60, 모델별 활성 RPD×0.8) | AI Studio 활성 RPM·RPD 확인 후 예산값 최종 확정 — 이번 라운드도 세션 중단으로 **미완** |
| 이대리 (프론트엔드) | `AskPanel` 종목 필터, 예시 질문 전체 검색 분리, 빈 결과 필터 해제 재검색, 429 카운트다운·잠금, 반응형·다크모드·접근성 CSS(코드 기준) | `npm install`~lint~production build, 실브라우저 데스크톱/모바일(320·360·375·768px)/다크모드/IME/키보드/스크린리더 실측 |
| 정사원 (통합 QA, 본 보고) | 소스 Secret 재검증, `git diff --check` 재실행, 테스트 개수 정합성 확인, 게이트 체크리스트 통합 | 실행 기반 재확인(`npm ci`·lint·typecheck·test·build·`qa.sh`) — 이번 세션도 permission 게이트로 불가 |

### 4) 최종 판정 근거

1. **선행 병목 미해소.** `web/package-lock.json` 부재로 CI(`quality.yml`)의 `npm ci`가
   fail-closed 실패한다. 이 파일이 없는 한 GitHub Actions 기준 배포 게이트를 통과할 수 없다.
2. **실행 기반 QA 재현 불가.** 이번 세션도 이전 라운드와 동일하게 `npm`·`node`·`bash`
   스크립트 실행이 permission 게이트로 차단되어, 보고된 19/19 회귀·TypeScript strict·
   `qa.sh` 결과를 직접 재현하지 못했다. 읽기전용 교차검증(Secret, `git diff --check`,
   테스트 개수)은 기존 보고와 전부 일치하나, 이는 "실행 재확인"의 대체가 아니다.
3. **production 번들 Secret 검사 대상 부재.** `.next`가 생성된 적이 없어 오차장의 "번들
   Secret 0건"은 성립할 수 없는 검사이며, 이번 보고서에서 그 구분을 명확히 한다.
4. **운영 반영 미완.** Supabase 운영 스키마 적용, Upstash·IP HMAC·글로벌/모델별 예산
   Secret 등록, AI Studio 활성 RPD 확정, Vercel WAF·프로젝트 연결, 실브라우저 QA가 모두
   남아 있다.

**판정: 배포 승인 보류.**

### 5) 승인 시 실행 조건 (사전 조건 충족 시에만)

아래 조건이 **모두** 충족된 이후에만 커밋·push·Vercel 배포를 실행한다. 하나라도
미충족이면 보류를 유지한다.

1. Bash가 `npm`·`node`·`bash` 스크립트를 승인 없이 실행 가능한 permission mode로
   세션이 재실행되어(또는 사용자가 직접) 아래가 **모두 종료 0**으로 재현됨:
   `npm ci`(lockfile 존재·검토 완료) → `lint` → `typecheck` → `test:api`(19/19) → `build`
   → `scripts/qa.sh --build` → `web/.next/static` Secret grep(`AIzaSy`·`sb_secret_`·
   `eyJhbGciOiJIUzI1Ni`·`UPSTASH`·`REST_TOKEN`·`IP_HASH_KEY` 0건).
2. 운영 Supabase에 `db/schema.sql` 적용 후 `db/verify_schema.sql` 실행 결과가 실패 0건.
3. Upstash `UPSTASH_REDIS_REST_URL`/`REST_TOKEN`, `RATE_LIMIT_IP_HASH_KEY`,
   `RATE_LIMIT_GLOBAL_RPM`, Gemini 모델별 일일 예산이 Vercel Production/Preview에 등록됨.
4. AI Studio 활성 RPM·RPD 확인 후 `docs/RATE_LIMIT_POLICY.md`의 예산값(현재 잠정 800/일)이
   최종 확정됨.
5. Vercel WAF `POST /api/ask` 60회/10분/IP 규칙 적용 및 Vercel 프로젝트 연결 완료.
6. 실브라우저에서 정상·빈 결과·429·503·timeout 및 데스크톱·320~768px·다크모드·IME·
   키보드·스크린리더 시나리오 확인 완료.

위 6개 조건이 모두 통과된 시점에만: `git add` → 커밋 → (사용자 승인 하에) `git push` →
Vercel 배포 순으로 진행한다. 이번 라운드는 1번 조건조차 재현하지 못했으므로 커밋·push·
Vercel 배포를 수행하지 않았다.

---

## 2026-07-05 22:34 JST 독립 최종 대조 (정사원)

### 승인 판정

**배포 승인 보류.** 이전 세션의 명령 permission 차단은 해소됐지만, 이번에는 외부 DNS와
npm registry 접근이 차단돼 lockfile과 정상 의존성을 확보하지 못했다. 로컬 회귀·정적
검사는 통과했으나 production build, 번들 Secret 검사, 운영 CI·배포·브라우저 검증은
완료되지 않았다. 커밋·push·배포는 수행하지 않았다.

### 직접 재실행 결과

| 검사 | 결과 | 근거 |
|---|---|---|
| API·DB 회귀 | **통과** | `npm --prefix web run test:api`, 19/19 |
| 직접 TypeScript strict | **통과** | `node web/node_modules/typescript/lib/tsc.js -p web/tsconfig.json --noEmit`, 종료 0 |
| 통합 정적 QA | **통과** | `scripts/qa.sh`, 실패 0·경고 3 |
| Secret 소스·Git 이력 검사 | **통과** | 실제 키 형태, 금지된 `NEXT_PUBLIC_` Secret, Client Component Secret 참조 0건 |
| Git diff·셸·Actions YAML | **통과** | `git diff --check`, `bash -n scripts/*.sh`, 워크플로 3개 Ruby YAML 파싱 종료 0 |
| lockfile 생성 | **차단** | 온라인 설치는 응답 없이 중단, 오프라인은 `eslint` 캐시 부재 `ENOTCACHED` |
| `npm ci` | **실패** | `web/package-lock.json` 부재, `EUSAGE` |
| npm lint/typecheck/build | **실패** | 정상 설치 부재로 각각 실행 파일 없음, 종료 127 |
| `scripts/qa.sh --build` | **실패** | API·DB 19/19는 통과했으나 build 실패 1건·경고 2건 |
| production 번들 Secret | **미실시** | `web/.next`와 `.next/static`이 없어 검사 대상 부재 |

### 실제 CI·배포 상태 대조

- `.github/workflows/quality.yml`은 작업 트리의 **미추적 파일**이다. 현재 커밋
  `b12aa29` 및 로컬 `origin/main` 추적 참조에는 포함되지 않으므로, 현 원격 커밋에 대해
  Phase 2-2 quality CI가 통과했다는 근거가 없다.
- 로컬 `HEAD`와 로컬 `origin/main` 참조는 동일하지만, `github.com` DNS 조회 실패로
  fetch/`ls-remote`를 수행하지 못했다. 따라서 이 원격 참조가 최신이라는 보장은 없다.
- GitHub CLI의 저장된 `Felix0708` 토큰은 만료 상태여서 Actions 실행 이력과 Pages API를
  조회하지 못했다. 공개 URL은 문서에 placeholder만 있고, 인앱 브라우저 목록도 비어 있어
  실제 GitHub Pages 화면을 확인하지 못했다.
- `web/.vercel`과 확정된 Vercel URL이 없으므로 Next.js 앱은 프로젝트에 연결되지 않은
  상태다. production/preview 환경변수, WAF, 배포 결과를 증명할 로컬 메타데이터도 없다.
- Git 작업 트리는 Phase 2-2 코드·문서가 다수 수정/미추적 상태이며 신규 커밋은 없다.
  `git diff --check` 통과는 공백 오류가 없다는 뜻일 뿐, CI·배포 완료를 의미하지 않는다.

### Secret 판정

소스와 현재 Git 이력의 Secret 검사는 통과했다. 다만 production 브라우저 번들이 없으므로
**production Secret 노출 검사는 통과가 아니라 미실시**다. 배포 승인 전 정상 build 후
`web/.next/static`을 `scripts/qa.sh --build`와 별도 `rg` 검사로 이중 확인해야 한다.

### 잔존 차단 체크리스트

- [ ] `web/package-lock.json` 생성·diff 검토 후 클린 `npm ci`
- [ ] lint, npm typecheck, API·DB 19/19, production build, `scripts/qa.sh --build` 종료 0
- [ ] `.next/static` production Secret 이중 검사 0건
- [ ] 운영 Supabase `schema.sql` 적용 및 `verify_schema.sql` 실패 0건
- [ ] AI Studio 활성 RPM·RPD 실측과 Gemini 일일 예산 확정
- [ ] Upstash·IP HMAC·글로벌/모델별 예산 환경값, Vercel WAF·프로젝트 연결
- [ ] 실제 정상·빈 결과·429·503·timeout과 모바일·다크모드·IME·키보드·접근성 브라우저 QA
- [ ] GitHub quality CI와 대상 배포 URL의 성공 상태 확인

위 항목이 모두 충족되기 전에는 커밋 후보를 배포하지 않는다. 사용자 지시에 따라 Git push는
하지 않았다.
