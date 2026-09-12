# 연동 계좌 자산 이력 v1

기존 보유종목 스냅샷과 별도 기능이다. 웹에서는 주문을 실행하지 않는다.
종목이 없고 현금만 있는 계좌도 수신 기록이 있으면 계좌 선택에 표시된다.
JPY 자산 이력은 이번 계약에 포함하지 않는다. 기존 일본 보유종목 기능은 변경하지 않는다.

## 운영 적용 순서

공개 push·운영 배포 승인 확인 후 진행한다. 로컬 테스트 통과는 운영 적용 완료를 뜻하지 않는다.

1. Stock-Briefing Supabase 프로젝트인지 확인한다.
2. [추가 전용 마이그레이션](../supabase/migrations/20260910145025_account_equity_history.sql)을 적용한다. 기존 잔고와 과거 기록을 삭제하지 않는다.
   이어서 [국내 자산 범위 확장](../supabase/migrations/20260912074043_account_equity_domestic.sql)을 적용한다. 국내 계열 송신은 수신 DB와 웹 배포가 모두 완료된 뒤 켠다.
   [원화 총자산·상세 검증 확장](../supabase/migrations/20260912081020_account_equity_breakdown.sql)도 적용한다. 기존 행·계열 식별자는 변경하지 않으며, 확장 송신은 수신 배포 완료 후 켠다.
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
| account_ref | 실제 계좌 또는 검증된 연결 조합의 로컬 매핑에 보존하는 무작위 UUID. 계좌번호나 키 지문이 아님 |
| account_group_ref (선택) | 실행기에 명시 연결된 계좌 묶음의 무작위 UUID. 동일 물리계좌라는 의미가 아니며, 미제공 시 생략(null 아님) |
| broker / account_type | KIWOOM 또는 KIS / paper 또는 live |
| currency / scope | 아래 출처별 조합만 허용: domestic, overseas, account-total-assets |
| date_timezone | Asia/Seoul |
| return_method | daily-sampled-linked-modified-dietz 또는 null |
| return_base_at | 원래 수익률 기준 관측 시각 또는 null |
| points | 아래 관측값 배열 |

각 관측값은 `date`, `valued_at`, `collected_at`, `calculated_at`, `equity`, `cash`, `stock_value`, `return_index`, `return_status`, `source`를 필수로 포함하며, 아래 `breakdown`만 선택적으로 추가할 수 있다. 다른 임의 필드는 거부한다. 기존 v1 요청도 그대로 받는다.

- 날짜는 수집 시각의 한국시간 YYYY-MM-DD다. 시각은 초 단위 및 최대 밀리초 ISO 형식이다. 전송 시각으로 과거 `collected_at`을 바꾸지 않는다.
- `valued_at`은 증권사가 평가 시각을 제공하지 않으면 null이다. `calculated_at`은 해당 계산 버전의 시각이며 수집 시각보다 빠를 수 없다. 미래 시각은 5분 오차까지만 허용한다.
- 금액과 지수는 정수부 최대 16자리·소수부 최대 8자리의 소수 **문자열** 또는 null이다. 과학 표기는 금지한다. `cash`만 음수를 허용한다.
- 미확인 현금·주식 금액은 null이다. 총자산에서 역산하거나 0으로 채우지 않는다.
- `return_status`: verified / insufficient_samples / cash_flows_unverified / scope_unverified / invalid_data.
- verified만 지수를 가지며 총자산과 method/base가 필수다. 나머지는 지수 null이다. method/base는 함께 null이거나 함께 지정한다. 한 점을 임의의 0% 수익률로 표시하지 않는다.
- `source`는 다음 조합만 허용한다. `KIWOOM_KR_EQUITY`는 KIWOOM/domestic/KRW, `KIWOOM_US_EQUITY`는 KIWOOM/overseas/USD, `KIWOOM_ACCOUNT_EQUITY`는 KIWOOM/account-total-assets/KRW, `KIS_ACCOUNT_EQUITY`는 KIS/account-total-assets/KRW다. 키움 해외 현금은 USD 결제예정 예수금을 포함하며 출금가능금액과 구분한다. 분해값이 확인되지 않으면 null로 보내고 총자산만 표시한다.
- 키움 국내 계열은 국내 연결에 대응하는 별도 무작위 `account_ref`를 보존한다. 계좌번호·API 키 자체를 식별자로 보내지 않는다. 기존 해외 계열의 식별자나 과거 관측값을 국내 자산에 재사용하지 않는다. 한투 전체자산에는 국내·해외가 이미 포함되므로 한투 국내 계열을 추가하지 않는다.
- 키움 국내 총자산은 추정예탁자산이며, 현금은 D+2 추정예수금이다. 송신자는 대출·조회 페이지 완전성을 확인하고 현금+주식 평가액과 보고 총액의 차이가 2원 이내인 경우에만 현금을 숫자로 보낸다. 불일치·미확인은 null이며 즉시 출금가능금액으로 표시하지 않는다.
- 요청당 1MiB, 시리즈 20개, 전체 관측값 500개 이하. 같은 계좌·범위·통화·날짜 중복은 거부한다.

### 원화 총자산의 선택 상세 (`breakdown`)

`account-total-assets`/KRW 관측값에서만 허용한다. 검증 실패·미수집·기존 관측이면 객체 자체를 생략한다. null, 부분 객체, 잔차로 만든 현금은 보내지 않는다.

| 필드 | 값 |
| --- | --- |
| status | verified |
| domestic_stock_value_krw | 국내주식 원화 평가액, 소수 문자열 |
| us_stock_value_usd / us_stock_value_krw | 미국주식 USD 평가액 / 당시 환율로 환산한 KRW 평가액, 소수 문자열 |
| cash_krw | 중복 없이 한 번 포함한 원화 기준 현금, 음수 허용 소수 문자열 |
| usd_krw_rate | 0보다 큰 당시 적용 KRW/USD 환율, 소수 문자열 |
| fx_source | 키움 KIWOOM_USD_SELL / 한투 KIS_USD_FIRST |
| observed_at | 상세 관측 ISO 시각. collected_at보다 미래 불가, 차이 120초 이내 |
| source | 키움 KIWOOM_LINKED_V1 / 한투 KIS_RECONCILED_V1 |
| cash_scope | 키움 same-account 또는 separate-accounts / 한투 account |

금액 정밀도는 기존 계약과 같다. 서버·DB 양쪽에서 다음을 **2원 이내**로 대조한다: 국내주식 KRW + 미국주식 KRW + 현금 = 총자산, 미국주식 USD × 당시 환율 = 미국주식 KRW. 기존 point.cash와 point.stock_value가 null이 아니라면 상세 현금 및 국내·미국 주식 합계와도 각각 대조한다. 소수 문자열을 그대로 보존하며 금액 검증에 부동소수점 반올림을 사용하지 않는다.

키움 신규 원화 총계열은 명시된 국내·미국 연결 조합에 대응하는 **새 account_ref**로 시작한다. 송신자가 공식 계좌 범위·중복 현금·환율·다른 통화 및 미수/원화주문 영향을 확인한 경우만 총계열을 만든다. 기존 국내/해외 UUID나 이력은 변경하지 않는다. 한투는 기존 총액 정의·계열을 유지하고, 동일 범위의 분해가 검증될 때만 상세를 추가한다. 미국 외 자산이 섞인 해외 값을 미국주식으로 표시하지 않는다. 상세를 과거 관측에 보강할 때도 아래 정정 규칙(calculated_at 증가)을 지킨다.

응답은 `{ "ok": true, "synced": 변경한_관측값_수 }`다. 오류는 400 형식, 401 토큰, 409 동일 관측·계산 시각의 내용 충돌, 413 용량, 502 저장 실패다.

회원·계좌 식별자·broker·실/모의·통화·범위·날짜별로 저장한다. `collected_at`이 최신인 값이 우선이며 같으면 `calculated_at`을 비교한다. 완전히 같은 재전송은 변경 0건이다. 같은 두 시각에 내용이 다르면 전체 요청을 409로 취소한다. 늦게 도착한 과거 값은 최신을 덮지 않는다. 빠진 날짜/계좌나 빈 배열은 삭제를 의미하지 않는다.

## GET /api/account-equity

로그인 쿠키가 필요하다. 토큰 전용 PUT과 달리 사용자의 Auth 세션과 RLS를 사용한다.

- 쿼리 없음: `{ series: [...] }`에 시리즈별 최신 관측값을 반환한다.
- `account_ref`, `broker`, `account_type`, `currency`, `scope` 지정: `{ points: [...], next: 날짜_또는_null }`을 반환한다. 모든 조건이 필수다.
- 선택 쿼리 `from=YYYY-MM-DD`, `before=YYYY-MM-DD`. 내림차순 최대 500건. `next`를 다음 요청의 `before`로 보낸다.
- 각 반환 관측값은 시리즈 메타데이터와 별도의 서버 `received_at`을 포함한다. 응답은 캐시하지 않는다.

## 표시와 복구 범위

두 증권사 공통 화면은 **원화 총자산(현금 포함) → 국내주식/미국주식 평가액(현금 제외)/공통 현금**이다. 시장별 현금을 임의 배분하지 않는다. 총계열이 없으면 동일 카드 구조로 미수집을 표시한다. 상세 누락은 '상세 미확인'이며 0으로 채우지 않는다. 수신 화면만으로 공급자 실패 원인을 알 수 없으므로 마지막 수집·수신 시각과 Stock-Trading 수집·전송 확인 안내를 제공한다.

자산 그래프는 일별 마지막 수집값이며 종가가 아니다. 국내·미국 그래프는 원화 **주식 평가액 추이이지 수익률이 아니다**. 누적 수익률은 기존 검증된 총계열 기준만 표시한다. 날짜 공백, 상세 누락, 미확인 수익률, 계좌 묶음/기준일/산식 변경은 선으로 잇지 않는다. 기간 필터는 표시 기간만 바꾸며 수익률을 새로 0%로 만들지 않는다. 웹에서 다른 계열 금액을 더하거나 오늘 환율로 과거 자산을 재평가하지 않는다. 키움 기존 국내/해외 계열은 '기존 기록'으로 별도 접근하며 총계열에 이어 붙이지 않는다.

계좌 선택은 등록 보유종목·비중·자동매매 성과의 증권사 및 실/모의 필터에도 적용된다. 키움 국내/해외 계열을 선택하면 보유종목·비중은 각각 국내/미국 시장으로 제한한다. 매매 성과는 기존 계약상 전체 시장 집계이므로 별도 안내하며 임의 분할하지 않는다. 기존 보유종목에는 실제 계좌 UUID가 없으므로 같은 증권사의 여러 실계좌까지 구분할 수는 없다. 직접 등록 금액을 연동 총자산에 더하지 않는다.

기존 포트폴리오 JSON/CSV 및 암호화 백업 범위는 변경하지 않았다. 새 자산 이력은 해당 백업의 복원/교체 대상이 아니다. Stock-Trading의 계좌 식별자 포함 관측 원본을 보존하고 이 API로 재전송하여 복구한다. 식별자 없는 기존 과거 자료는 현재 계좌에 임의로 붙이지 않는다.

검증: `npm run test:api --prefix web`, `npm run test:browser --prefix web`. 로컬 PostgreSQL 격리 DB에서 RLS, 원자성, 재전송과 정정 충돌을 실행하고 데스크톱/iPhone에서 화면·조작을 검증한다.
