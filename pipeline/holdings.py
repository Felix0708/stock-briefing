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


def _fetch_market_rows(settings: Settings) -> list[dict]:
    if not settings.rag_enabled:
        return []
    response = requests.get(
        f"{settings.supabase_url}/rest/v1/holdings",
        params={"select": "user_id,stock_name,stock_code,market", "order": "created_at.asc"},
        headers=_secret_headers(settings),
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    return response.json()


def dedupe_market_targets(rows: list[dict], allowed_user_ids: set[str] | None = None) -> list[dict]:
    """회원·계좌 정보 없이 시장/코드 기준으로 브리핑 대상을 중복 제거한다."""

    seen: set[tuple[str, str]] = set()
    targets: list[dict] = []
    for row in rows:
        user_id = str(row.get("user_id", ""))
        if allowed_user_ids is not None and user_id not in allowed_user_ids:
            continue
        name = str(row.get("stock_name", "")).strip()
        market = str(row.get("market", "KR")).strip() or "KR"
        code = str(row.get("stock_code", "")).strip()
        key = (market, code)
        if name and code and key not in seen:
            seen.add(key)
            targets.append({"name": name, "market": market, "code": code})
    return targets


def fetch_market_targets(settings: Settings) -> list[dict]:
    """전 회원 보유 종목을 내부 수집·개인 알림 대상으로 반환."""
    return dedupe_market_targets(_fetch_market_rows(settings))


def fetch_public_market_targets(settings: Settings) -> list[dict]:
    """명시적으로 동의한 회원의 종목만 익명·중복 제거해 공개 대상으로 반환."""
    if not settings.rag_enabled:
        return []
    response = requests.get(
        f"{settings.supabase_url}/rest/v1/member_settings",
        params={"select": "user_id", "public_briefing_opt_in": "eq.true"},
        headers=_secret_headers(settings),
        timeout=_TIMEOUT,
    )
    response.raise_for_status()
    opted_in = {str(row.get("user_id", "")) for row in response.json() if row.get("user_id")}
    return dedupe_market_targets(_fetch_market_rows(settings), opted_in)
