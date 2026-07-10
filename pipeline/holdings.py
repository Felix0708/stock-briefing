"""사용자 보유 종목 조회 (Phase 3 개인화).

웹에서 사용자들이 등록한 보유 종목(holdings 테이블)의 종목명을 가져와
watchlist에 합친다 → 보유 종목은 자동으로 매일 수집 대상이 된다.

실패해도 브리핑이 죽지 않도록 호출부에서 예외를 삼킨다.
"""

import requests

from .config import Settings

_TIMEOUT = 15


def fetch_holding_companies(settings: Settings) -> list[str]:
    """holdings 테이블의 종목명 목록(중복 제거, 등록순)을 반환.

    secret key는 RLS를 우회하므로 모든 사용자의 종목이 조회된다.
    (개인 식별 정보 없이 종목명만 가져온다)
    """
    if not settings.rag_enabled:
        return []

    headers = {"apikey": settings.supabase_secret_key}
    # 신형 sb_secret_ 키는 API 키, 구형 service_role JWT는 Bearer도 필요
    if not settings.supabase_secret_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {settings.supabase_secret_key}"

    response = requests.get(
        f"{settings.supabase_url}/rest/v1/holdings",
        params={"select": "stock_name", "order": "created_at.asc"},
        headers=headers,
        timeout=_TIMEOUT,
    )
    response.raise_for_status()

    seen: set[str] = set()
    companies: list[str] = []
    for row in response.json():
        name = str(row.get("stock_name", "")).strip()
        if name and name not in seen:
            seen.add(name)
            companies.append(name)
    return companies
