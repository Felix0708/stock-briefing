"""사용자 보유 종목 조회 (Phase 3 개인화).

웹에서 사용자들이 등록한 보유 종목(holdings 테이블)의 종목명을 가져와
watchlist에 합친다 → 보유 종목은 자동으로 매일 수집 대상이 된다.

실패해도 브리핑이 죽지 않도록 호출부에서 예외를 삼킨다.
"""

import requests

from .config import Settings

_TIMEOUT = 15


def _secret_headers(settings: Settings) -> dict:
    headers = {"apikey": settings.supabase_secret_key}
    if not settings.supabase_secret_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {settings.supabase_secret_key}"
    return headers


def fetch_subscribers(settings: Settings) -> list[dict]:
    """브리핑 메일 수신에 동의한 회원 목록 [{id, email}] (GoTrue 관리자 API).

    동의 여부는 user_metadata.briefing_email == True 로 판단한다.
    """
    if not settings.rag_enabled:
        return []
    response = requests.get(
        f"{settings.supabase_url}/auth/v1/admin/users",
        params={"page": 1, "per_page": 200},
        headers=_secret_headers(settings),
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    payload = response.json()
    users = payload.get("users", payload if isinstance(payload, list) else [])
    subscribers = []
    for user in users:
        meta = user.get("user_metadata") or {}
        email = user.get("email")
        if email and meta.get("briefing_email") is True:
            subscribers.append({"id": user.get("id"), "email": email})
    return subscribers


def fetch_holdings_by_user(settings: Settings) -> dict[str, list[str]]:
    """사용자 ID → 보유 종목명 목록."""
    response = requests.get(
        f"{settings.supabase_url}/rest/v1/holdings",
        params={"select": "user_id,stock_name"},
        headers=_secret_headers(settings),
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    result: dict[str, list[str]] = {}
    for row in response.json():
        user_id = str(row.get("user_id", ""))
        name = str(row.get("stock_name", "")).strip()
        if user_id and name:
            result.setdefault(user_id, []).append(name)
    return result


def fetch_holding_companies(settings: Settings) -> list[str]:
    """holdings 테이블의 종목명 목록(중복 제거, 등록순)을 반환.

    secret key는 RLS를 우회하므로 모든 사용자의 종목이 조회된다.
    (개인 식별 정보 없이 종목명만 가져온다)
    """
    if not settings.rag_enabled:
        return []

    # 미국 종목은 DART에 없으므로 국내(KR)만 수집 대상에 합친다
    response = requests.get(
        f"{settings.supabase_url}/rest/v1/holdings",
        params={"select": "stock_name", "market": "eq.KR", "order": "created_at.asc"},
        headers=_secret_headers(settings),
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
