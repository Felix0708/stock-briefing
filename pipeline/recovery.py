"""Durable checkpoints, cached filing material and delivery receipts (server-only)."""
from datetime import datetime, timezone
import hashlib
import requests
from .holdings import _secret_headers


def rest(settings, path, *, params=None, body=None, method="GET"):
    response = requests.request(method, f"{settings.supabase_url}/rest/v1/{path}", params=params,
        json=body, headers={**_secret_headers(settings), "Prefer":"resolution=merge-duplicates,return=representation"}, timeout=30)
    response.raise_for_status()
    return response.json() if response.content else None


def lookback(settings, target):
    if not settings.rag_enabled:
        return settings.lookback_days
    rows = rest(settings,"collection_status",params={"market":f"eq.{target['market']}","company":f"eq.{target['name']}","select":"last_success_at"})
    previous = rows[0].get("last_success_at") if rows else None
    if not previous:
        return max(settings.lookback_days,3)
    elapsed = datetime.now(timezone.utc) - datetime.fromisoformat(previous.replace("Z","+00:00"))
    # Two overlapping calendar days cover timezone differences and delayed publication.
    return max(settings.lookback_days,elapsed.days+2)


def cached(settings, market, receipt):
    rows = rest(settings,"briefing_items",params={"market":f"eq.{market}","rcept_no":f"eq.{receipt}","select":"*"})
    return rows[0] if rows and rows[0]["ready"] else None


def save_item(settings, target, filing, text, summary, ready):
    safe = {key:filing[key] for key in ("report_nm","rcept_no","rcept_dt","flr_nm","url") if key in filing}
    rest(settings,"briefing_items",method="POST",params={"on_conflict":"market,rcept_no"},body={
        "market":target["market"],"rcept_no":filing["rcept_no"],"company":target["name"],"stock_code":target["code"],
        "filing":safe,"document_text":text,"summary_html":summary,"ready":ready})


def ready_items(settings):
    result=[]
    while True:
        rows=rest(settings,"briefing_items",params={"ready":"eq.true","select":"market,rcept_no,company,stock_code",
            "order":"market.asc,rcept_no.asc","offset":len(result),"limit":1000})
        result.extend(rows)
        if len(rows)<1000:
            return result


def prepare(settings, email, member_id, items):
    recipient=hashlib.sha256(email.strip().lower().encode()).hexdigest()
    return rest(settings,"rpc/prepare_briefing_batch",method="POST",body={"recipient":recipient,"member_id":member_id,"candidates":items})


def start(settings, batch_id):
    return rest(settings,"rpc/start_briefing_batch",method="POST",body={"batch_id":batch_id})


def finish(settings, batch_id, outcome):
    return rest(settings,"rpc/finish_briefing_batch",method="POST",body={"batch_id":batch_id,"outcome":outcome})
