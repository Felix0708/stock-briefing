# 연동 계좌 자산 이력 v1

기존 보유종목 스냅샷과 별도 기능이다. 웹에서는 주문을 실행하지 않는다.
종목이 없고 현금만 있는 계좌도 수신 기록이 있으면 계좌 선택에 표시된다.
JPY 자산 이력은 이번 계약에 포함하지 않는다. 기존 일본 보유종목 기능은 변경하지 않는다.

## 운영 적용 순서

공개 push·운영 배포 승인 확인 후 진행한다. 로컬 테스트 통과는 운영 적용 완료를 뜻하지 않는다.

1. Stock-Briefing Supabase 프로젝트인지 확인한다.
2. [추가 전용 마이그레이션](../supabase/migrations/20260910145025_account_equity_history.sql)을 적용한다. 기존 잔고와 과거 기록을 삭제하지 않는다.
3. RLS 및 함수 실행권을 확인한다. `authenticated`는 자신의 이력 SELECT만, `service_role`은 수신 함수 실행과 이력 쓰기만 허용한다. `anon` 접근은 금지한다.
4. 해당 커밋의 웹 배포가 READY인지 확인한다. 기존 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, 공개 Auth 키를 재사용하며 새 비밀값은 없다.
5. 비로그인 GET, 잘못된 Bearer PUT의 401 및 격리 QA 계정의 한 점/null 분해값/재전송/409/소유자 분리를 검증한다.
6. Stock-Trading에 수신 준비 완료를 전달한 뒤 실제 전송을 켠다. 처음에는 실제 수집한 한 점만 있어도 정상이다.

## PUT /api/sync/account-equity

기존 회원별 연동 토큰을 `Authorization: Bearer sb_sync_…` 헤더로 사용한다.
본문은 정확히 `{ "version": 1, "series": [...] }`이며 회원 ID를 받지 않는다.
소유자는 서버가 토큰 해시에서 결정한다. 원문 토큰이나 증권사 계좌번호·키를 저장하지 않는다.

각 시리즈 필드:

| 필드 | 값 |
| --- | --- |
| account_ref | 실제 계좌의 로컬 매핑에 보존하는 무작위 UUID. 계좌번호나 키 지문이 아님 |
| broker / account_type | KIWOOM 또는 KIS / paper 또는 live |
| currency / scope | KRW 또는 USD / overseas 또는 account-total-assets |
| date_timezone | Asia/Seoul |
| return_method | daily-sampled-linked-modified-dietz 또는 null |
| return_base_at | 원래 수익률 기준 관측 시각 또는 null |
| points | 아래 관측값 배열 |

각 관측값은 정확히 `date`, `valued_at`, `collected_at`, `calculated_at`, `equity`, `cash`, `stock_value`, `return_index`, `return_status`, `source`를 포함한다.

- 날짜는 수집 시각의 한국시간 YYYY-MM-DD다. 시각은 초 단위 및 최대 밀리초 ISO 형식이다. 전송 시각으로 과거 `collected_at`을 바꾸지 않는다.
- `valued_at`은 증권사가 평가 시각을 제공하지 않으면 null이다. `calculated_at`은 해당 계산 버전의 시각이며 수집 시각보다 빠를 수 없다. 미래 시각은 5분 오차까지만 허용한다.
- 금액과 지수는 정수부 최대 16자리·소수부 최대 8자리의 소수 **문자열** 또는 null이다. 과학 표기는 금지한다. `cash`만 음수를 허용한다.
- 미확인 현금·주식 금액은 null이다. 총자산에서 역산하거나 0으로 채우지 않는다.
- `return_status`: verified / insufficient_samples / cash_flows_unverified / scope_unverified / invalid_data.
- verified만 지수를 가지며 총자산과 method/base가 필수다. 나머지는 지수 null이다. method/base는 함께 null이거나 함께 지정한다. 한 점을 임의의 0% 수익률로 표시하지 않는다.
- `source`는 KIWOOM_US_EQUITY 또는 KIS_ACCOUNT_EQUITY이며 broker와 일치해야 한다. 키움은 미국주식·USD 결제예정 예수금 포함이며 출금가능금액과 구분한다. 한투 분해값이 확인되지 않으면 총자산만 표시한다.
- 요청당 1MiB, 시리즈 20개, 전체 관측값 500개 이하. 같은 계좌·범위·통화·날짜 중복은 거부한다.

응답은 `{ "ok": true, "synced": 변경한_관측값_수 }`다. 오류는 400 형식, 401 토큰, 409 동일 관측·계산 시각의 내용 충돌, 413 용량, 502 저장 실패다.

회원·계좌 식별자·broker·실/모의·통화·범위·날짜별로 저장한다. `collected_at`이 최신인 값이 우선이며 같으면 `calculated_at`을 비교한다. 완전히 같은 재전송은 변경 0건이다. 같은 두 시각에 내용이 다르면 전체 요청을 409로 취소한다. 늦게 도착한 과거 값은 최신을 덮지 않는다. 빠진 날짜/계좌나 빈 배열은 삭제를 의미하지 않는다.

## GET /api/account-equity

로그인 쿠키가 필요하다. 토큰 전용 PUT과 달리 사용자의 Auth 세션과 RLS를 사용한다.

- 쿼리 없음: `{ series: [...] }`에 시리즈별 최신 관측값을 반환한다.
- `account_ref`, `broker`, `account_type`, `currency`, `scope` 지정: `{ points: [...], next: 날짜_또는_null }`을 반환한다. 모든 조건이 필수다.
- 선택 쿼리 `from=YYYY-MM-DD`, `before=YYYY-MM-DD`. 내림차순 최대 500건. `next`를 다음 요청의 `before`로 보낸다.
- 각 반환 관측값은 시리즈 메타데이터와 별도의 서버 `received_at`을 포함한다. 응답은 캐시하지 않는다.

## 표시와 복구 범위

자산 그래프는 일별 마지막 수집값이며 종가가 아니다. 날짜 공백, 미확인 수익률, 기준일/산식 변경은 선으로 잇지 않는다. 기간 필터는 표시 기간만 바꾸며 수익률을 새로 0%로 만들지 않는다. 서로 다른 통화·평가 범위를 합산하거나 오늘 환율로 과거 자산을 재평가하지 않는다.

계좌 선택은 등록 보유종목·비중·자동매매 성과의 증권사 및 실/모의 필터에도 적용된다. 기존 보유종목에는 실제 계좌 UUID가 없으므로 같은 증권사의 여러 실계좌까지 구분할 수는 없다. 직접 등록 금액을 연동 총자산에 더하지 않는다.

기존 포트폴리오 JSON/CSV 및 암호화 백업 범위는 변경하지 않았다. 새 자산 이력은 해당 백업의 복원/교체 대상이 아니다. Stock-Trading의 계좌 식별자 포함 관측 원본을 보존하고 이 API로 재전송하여 복구한다. 식별자 없는 기존 과거 자료는 현재 계좌에 임의로 붙이지 않는다.

검증: `npm run test:api --prefix web`, `npm run test:browser --prefix web`. 로컬 PostgreSQL 격리 DB에서 RLS, 원자성, 재전송과 정정 충돌을 실행하고 데스크톱/iPhone에서 화면·조작을 검증한다.
