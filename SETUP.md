# 셋업 가이드 (전부 무료, 약 30분)

## 1. DART API 키 발급 (5분)

1. https://opendart.fss.or.kr 접속 → 우측 상단 **인증키 신청/관리**
2. 회원가입 후 **인증키 신청** (사용 목적: 개인 연구용으로 적으면 됨)
3. 즉시 발급됨. 이메일로도 옴. 하루 20,000건 무료.

## 2. Gemini API 키 발급 (2분)

1. https://aistudio.google.com/apikey 접속 (구글 계정 로그인)
2. **Create API key** 클릭 → 키 복사
3. 카드 등록 없이 무료 티어 사용 가능 (Flash 모델, 하루 1,500 요청)

## 3. Gmail 앱 비밀번호 발급 (5분)

일반 비밀번호로는 SMTP 로그인이 안 되고, "앱 비밀번호"가 필요함.

1. 구글 계정 → 보안 → **2단계 인증** 활성화 (이미 켜져 있으면 생략)
2. https://myaccount.google.com/apppasswords 접속
3. 앱 이름 아무거나(예: stock-briefing) 입력 → 생성된 16자리 비밀번호 복사

## 4. 로컬 테스트 (맥북)

```bash
cd stock-briefing
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# .env 파일 열어서 위에서 발급한 키 3개 + 메일 주소 입력

# watchlist.yaml에 본인 관심 종목 입력 후:
python -m pipeline.main --dry-run   # 메일 안 보내고 briefing_preview.html 생성
open briefing_preview.html          # 결과 미리보기

python -m pipeline.main             # 실제 메일 발송 테스트
```

## 5. GitHub 자동화

1. GitHub에 **public** 저장소 생성 (public이어야 Actions 무료 무제한)
2. 코드 push (`.env`는 .gitignore 덕분에 자동 제외됨 — 절대 직접 올리지 말 것)
3. 저장소 → Settings → Secrets and variables → Actions → **New repository secret** 으로 아래 5개 등록:
   - `DART_API_KEY`
   - `GEMINI_API_KEY`
   - `SMTP_USER`
   - `SMTP_PASSWORD`
   - `MAIL_TO`
4. Actions 탭 → daily-briefing → **Run workflow** 로 수동 실행해서 메일 오는지 확인
5. 이후 매일 아침 07:30(한국/일본 시간)에 자동 발송됨

## 6. 웹 대시보드 켜기 (GitHub Pages, 2분)

1. 저장소 → Settings → **Pages**
2. Source: **Deploy from a branch** / Branch: `main` / Folder: **`/docs`** → Save
3. 1~2분 뒤 `https://<깃허브아이디>.github.io/<저장소이름>/` 에서 대시보드 접속 가능
4. 폰 브라우저로 열어도 반응형으로 잘 보임. 홈 화면에 추가하면 앱처럼 사용 가능
5. 이메일이 필요 없으면 secrets에 `SEND_EMAIL=false` 대신 워크플로우 env에 추가하거나,
   SMTP secrets를 등록하지 않고 `SEND_EMAIL` 환경변수를 `false`로 두면 됨

로컬에서 대시보드 미리보기 (dry-run 후):

```bash
python -m http.server 8000 --directory docs
# 브라우저에서 http://localhost:8000 접속
```

## 7. Phase 2 — RAG 인덱싱 켜기 (Supabase)

1. Supabase 대시보드 → **SQL Editor** → `db/schema.sql` 내용 전체 붙여넣기 → **Run**
   (테이블 + 검색 함수가 생성됨. "Success"만 나오면 성공)
2. `.env`에 추가:
   ```
   SUPABASE_URL=https://<프로젝트ID>.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_... (Settings → API Keys → Secret keys)
   ```
3. GitHub 저장소 secrets에도 같은 이름으로 2개 등록
4. 이후 파이프라인이 돌 때마다 공시 원문이 자동으로 벡터 DB에 쌓임
   (설정이 없으면 이 단계는 조용히 건너뛰므로 Phase 1 동작에는 영향 없음)

## 문제 해결

- **"'회사명'을 찾지 못함"**: watchlist.yaml의 이름이 DART 등록 법인명과 달라서 그런 것. dart.fss.or.kr에서 회사 검색해 정확한 명칭 확인.
- **SMTP 로그인 실패**: 앱 비밀번호(16자리)를 썼는지, 2단계 인증이 켜져 있는지 확인.
- **Gemini 429 에러**: 무료 티어 분당 요청 제한. 종목 수가 아주 많지 않으면 발생 안 함.
