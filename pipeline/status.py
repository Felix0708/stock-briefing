"""Private operational status; never put member identities or exceptions in public logs."""
from datetime import datetime, timezone
import requests
from .holdings import _secret_headers


def timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def save(settings, table, row, conflict):
    if not settings.rag_enabled:
        return False
    try:
        response = requests.post(
            f"{settings.supabase_url}/rest/v1/{table}",
            params={"on_conflict": conflict},
            headers={**_secret_headers(settings), "Prefer": "resolution=merge-duplicates,return=minimal"},
            json=row, timeout=15,
        )
        response.raise_for_status()
        return True
    except Exception:
        print("⚠ 실행 상태 저장 실패 (개인정보·외부 응답 생략)")
        return False


def record_run(settings, state):
    row = {"id": 1, "status": state, "checked_at": timestamp()}
    if state == "success":
        row["last_success_at"] = row["checked_at"]
    return save(settings, "briefing_runs", row, "id")


def delivery(settings, user_id, state, count=0):
    row = {"user_id": user_id, "status": state, "filing_count": count, "checked_at": timestamp()}
    if state == "sent":
        row["last_sent_at"] = row["checked_at"]
    return save(settings, "briefing_deliveries", row, "user_id")
