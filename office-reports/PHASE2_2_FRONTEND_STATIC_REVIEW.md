# Phase 2-2 프론트엔드 정적 변경 검토 및 결함 수정

> 검토일: 2026-07-06 09:01 JST  
> 담당: 이대리 (프론트엔드)  
> 범위: `web/src`의 질문·종목 필터·빈 결과 재검색·429·503·timeout UI와 모바일·다크모드·IME·키보드·접근성

## 판정

**확인된 프론트엔드 코드 결함 3건을 수정하고 클라이언트 회귀 테스트를 추가했다.
TypeScript strict와 전체 API·클라이언트·DB 회귀 24/24를 통과했다. 실브라우저 QA는 별도
미실행 상태를 유지한다.**

이번 검토는 브라우저 실측 통과 판정이 아니다. 현재 프로젝트에는 `web/package-lock.json`,
production build 결과(`web/.next`), 운영 URL이 없으므로 렌더링·조작·접근성 트리 검증은
수행하지 않았다.

## 정적으로 확인한 구현

| 항목 | 판정 | 코드 근거 |
|---|---|---|
| 질문 제출 | 확인 | 질문 trim, 1,000자 제한, 빈 질문 차단, `/api/ask` POST 연결 |
| 종목 필터 | 확인 | 자유 입력·빠른 선택·지우기, 100자 제한, 값이 있을 때만 `company` 전송 |
| 예시 질문 | 확인 | 해당 요청만 빈 `company`로 실행하고 화면의 필터 입력값은 유지 |
| 빈 결과 재검색 | 확인 | 필터 원인 안내 후 동일 질문을 전체 종목으로 즉시 재검색하며 입력 필터도 해제 |
| 429 UI | 확인 | `Retry-After`를 절대 deadline으로 변환하고 현재 시각과의 차이로 계산. 제출·예시·재시도 잠금 및 `visibilitychange` 복귀 동기화 |
| 503 UI | 확인 | `RATE_LIMIT_UNAVAILABLE`의 서버 메시지를 오류 카드에 표시하고 재시도 제공 |
| upstream·client timeout UI | 확인 | 서버 timeout의 `502 UPSTREAM_ERROR` 일반화와 별도로 브라우저 요청에 60초 timeout·취소·고정 한국어 transport 오류 적용 |
| 모바일 | 정적 확인 | 320px 최소 폭, 640px 미디어 쿼리, 긴 답변 줄바꿈, 오류·빈 결과 카드 wrap |
| 다크모드 | 정적 확인 | `prefers-color-scheme: dark` 토큰·입력·버튼·오류·출처 스타일 존재 |
| IME·키보드 | 정적 확인 | 조합 중 Enter 제출 방지, Shift+Enter 줄바꿈, native form submit, focus-visible 적용 |
| 접근성 | 정적 확인 | label/description, `aria-pressed`, alert/status/live region, 결과 포커스 이동, 새 창 라벨 존재. 라이트 muted 토큰은 실제 배경에서 4.64:1 이상 |

## 코드 결함 수정 결과

### 1. 429 deadline 기반 카운트다운과 visibility 복귀 동기화 — 완료

`Retry-After`의 초 또는 HTTP-date를 절대 deadline으로 변환한다. 화면의 남은 시간은 매번
`ceil((deadline - Date.now()) / 1000)`으로 다시 계산하므로 타이머 실행 횟수에 의존하지 않는다.
`visibilitychange`에서도 즉시 계산해 백그라운드 탭·절전 복귀 후 잠금 상태를 실제 경과 시간과
맞춘다.

- 잘못되거나 없는 `Retry-After`는 보수적으로 60초를 사용
- deadline 도달 시 남은 시간을 0으로 만들고 재전송 잠금을 자동 해제

### 2. AbortController 기반 timeout·취소와 네트워크 오류 정규화 — 완료

각 요청에 독립된 `AbortController`와 60초 timeout을 두고 `fetch`의 `signal`에 연결했다. 로딩
카드의 `요청 취소` 버튼으로 사용자가 직접 중단할 수 있으며, 완료·취소·unmount에서 timer와
요청 참조를 정리한다. React 개발 Strict Mode의 effect 재실행에서도 mount 플래그가 복원된다.

- API 응답의 안전한 메시지는 유지
- client timeout, 사용자 취소, 기타 fetch/transport 오류는 각각 고정 한국어 문구로 정규화
- 사용자 취소 시 timeout timer를 먼저 해제해 취소 사유가 timeout으로 덮이지 않게 처리

### 3. 라이트 모드 보조 텍스트 AA 대비 — 완료

라이트 `--text-muted`를 `#667085`로 변경했다. 보조 텍스트가 사용되는 흰색 surface,
`#f8fafc` surface-soft, `#f5f7fa` background와의 계산 대비는 각각 약 **4.97:1, 4.75:1,
4.64:1**로 WCAG AA 일반 텍스트 기준 4.5:1 이상이다.

- 세 실제 배경의 최소 대비 4.5:1을 클라이언트 회귀 테스트로 고정
- 다크 모드 토큰은 기존 통과 값을 유지

## 브라우저 실측이 필요한 항목

다음 항목은 소스 존재만 확인했으며 통과로 판정하지 않았다.

1. 정상·빈 결과·429·503·upstream timeout 응답별 실제 문구, 버튼 상태, 포커스 이동
2. 429 카운트다운의 전면 탭·백그라운드 탭·절전 복귀 동작과 잠금 해제 시각
3. 320·360·375·768px에서 가로 스크롤, 카드 wrap, 긴 종목명·질문·답변·출처 레이아웃
4. 라이트·다크 모드의 텍스트·포커스 링·disabled·hover 실제 대비
5. 한글 IME 조합 중 Enter, 조합 확정 후 Enter, Shift+Enter 줄바꿈
6. Tab·Shift+Tab 순서, 빠른 종목 칩의 `aria-pressed`, 지우기 후 입력 포커스 복귀,
   결과 포커스 및 새 창 출처 링크
7. VoiceOver 등 스크린리더에서 loading/status/alert가 중복 없이 읽히는지와 429 잠금 해제 인지
8. 200% 확대, `prefers-reduced-motion`, 40×40 종목 지우기 터치 영역

## 실행한 검증

- `node web/node_modules/typescript/lib/tsc.js -p web/tsconfig.json --noEmit --incremental false`:
  통과
- `node --test --experimental-loader ./web/tests/ts-loader.mjs ./web/tests/*.test.mjs`:
  24/24 통과(클라이언트 5/5 포함)
- `scripts/qa.sh`: 실패 0건, 경고 3건(개발 의존성·production build·로컬 API 미실행)
- `git diff --check`: 통과
- 색상 상대 휘도 회귀: 라이트 muted의 실제 배경 최소 4.64:1

## 변경 파일

- `web/src/components/ask-panel.tsx`: deadline 카운트다운, visibility 동기화,
  AbortController timeout·취소·정리와 오류 분기 연결
- `web/src/lib/client/ask-request.ts`: deadline 계산과 사용자 노출 오류 정규화 헬퍼
- `web/src/app/globals.css`: 라이트 muted 토큰 AA 조정, 취소 버튼 스타일
- `web/tests/client-ask.test.mjs`: deadline·오류 분기·컴포넌트 연결·AA 대비 회귀 5건
- `office-reports/PHASE2_2_FRONTEND_STATIC_REVIEW.md`: 수정·검증 결과 갱신
- `office-reports/PROGRESS.md`: 진행·완료 기록

커밋·push·배포는 수행하지 않았다.
