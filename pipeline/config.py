"""설정 로더.

환경변수(.env 또는 GitHub Actions secrets)와 watchlist.yaml을 읽는다.
모든 외부 의존 값(API 키, 모델명, 메일 주소)은 여기서만 접근한다.
→ 나중에 설정 방식을 바꿔도 이 파일만 수정하면 됨.
"""

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from dotenv import load_dotenv

# 프로젝트 루트의 .env를 로드 (로컬 실행용. Actions에서는 secrets가 env로 주입됨)
ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


@dataclass
class Settings:
    # --- API 키 ---
    dart_api_key: str = os.getenv("DART_API_KEY", "")
    gemini_api_key: str = os.getenv("GEMINI_API_KEY", "")

    # --- Gemini ---
    # 무료 티어 정책이 바뀌면 여기(환경변수)만 바꾸면 됨
    gemini_model: str = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
    embedding_model: str = os.getenv("EMBEDDING_MODEL", "gemini-embedding-001")
    embedding_dim: int = int(os.getenv("EMBEDDING_DIM", "768"))  # db/schema.sql의 vector(768)과 일치해야 함

    # --- Supabase (Phase 2 RAG용. 비워두면 임베딩 저장을 건너뜀) ---
    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_secret_key: str = os.getenv("SUPABASE_SECRET_KEY", "")

    # --- 메일 (Gmail 기준. 앱 비밀번호 필요 → SETUP.md 참고) ---
    smtp_host: str = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port: int = int(os.getenv("SMTP_PORT", "465"))
    smtp_user: str = os.getenv("SMTP_USER", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    mail_to: str = os.getenv("MAIL_TO", "")  # 쉼표로 여러 명 지정 가능

    # --- 동작 옵션 ---
    # 공시 원문에서 요약에 사용할 최대 글자 수 (Gemini 토큰 절약)
    doc_max_chars: int = int(os.getenv("DOC_MAX_CHARS", "8000"))
    # 조회 기간(일). 1이면 어제~오늘 공시를 수집
    lookback_days: int = int(os.getenv("LOOKBACK_DAYS", "1"))
    # 신규 공시가 없어도 "없음" 메일을 보낼지
    send_empty_briefing: bool = os.getenv("SEND_EMPTY_BRIEFING", "false").lower() == "true"
    # 이메일 발송 여부 (false면 웹 대시보드용 JSON 저장만 수행)
    send_email: bool = os.getenv("SEND_EMAIL", "true").lower() == "true"

    watchlist: list[str] = field(default_factory=list)

    def validate(self) -> None:
        required = [
            ("DART_API_KEY", self.dart_api_key),
            ("GEMINI_API_KEY", self.gemini_api_key),
        ]
        if self.send_email:  # 메일을 안 쓰면 SMTP 설정은 필수가 아님
            required += [
                ("SMTP_USER", self.smtp_user),
                ("SMTP_PASSWORD", self.smtp_password),
                ("MAIL_TO", self.mail_to),
            ]
        missing = [name for name, value in required if not value]
        if missing:
            raise SystemExit(f"환경변수 누락: {', '.join(missing)} (.env 또는 secrets 확인)")

    @property
    def rag_enabled(self) -> bool:
        """Supabase 설정이 있으면 임베딩 저장(RAG 인덱싱)을 수행."""
        return bool(self.supabase_url and self.supabase_secret_key)


def load_settings() -> Settings:
    settings = Settings()
    watchlist_path = ROOT / "watchlist.yaml"
    with open(watchlist_path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    settings.watchlist = data.get("companies", [])
    if not settings.watchlist:
        raise SystemExit("watchlist.yaml에 종목이 없습니다.")
    return settings
