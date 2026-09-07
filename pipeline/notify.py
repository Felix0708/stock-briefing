"""회원별 맞춤 브리핑 메일 (Phase 3 알림).

수신 동의(user_metadata.briefing_email)한 회원에게,
그 회원의 보유 종목에 해당하는 공시만 골라 발송한다.
중요 공시(유상증자·합병 등)가 있으면 제목에 ⚠️를 붙인다.
"""

from datetime import datetime, timezone
import smtplib
from zoneinfo import ZoneInfo

from . import emailer, holdings, status, recovery
from .config import Settings

# 투자 판단에 큰 영향을 주는 공시 키워드 (report_nm 기준 부분 일치)
IMPORTANT_KEYWORDS = [
    "유상증자",
    "무상증자",
    "감자",
    "합병",
    "분할",
    "전환사채",
    "신주인수권",
    "교환사채",
    "공개매수",
    "대량보유",
    "영업정지",
    "상장폐지",
    "관리종목",
    "불성실공시",
    "소송",
    "파산",
    "회생",
    "영업(잠정)실적",
    "매출액또는손익구조",
]

MAX_RECIPIENTS = 50  # Gmail 일일 한도 보호


def find_important(sections: list[dict]) -> list[str]:
    """중요 공시명 목록을 반환."""
    found = []
    for section in sections:
        for filing in section["filings"]:
            name = filing.get("report_nm", "")
            if any(keyword in name for keyword in IMPORTANT_KEYWORDS):
                found.append(f"{section['company']} · {name}")
    return found


def send_personalized(settings: Settings, sections: list[dict], collection_results: list[dict] | None = None) -> set[str]:
    """회원별로 보유 종목 공시만 추려서 발송. 발송된 이메일 집합을 반환.

    반환값은 main.py가 관리자 전체 브리핑과의 중복 발송을 막는 데 쓴다
    (맞춤 메일을 받은 주소에는 전체 브리핑을 다시 보내지 않음).
    """
    if settings.rag_enabled:
        return send_durable(settings, collection_results or [])
    subscribers = holdings.fetch_subscribers(settings)
    if not subscribers:
        print("알림: 수신 동의 회원 없음 → 개인 알림 생략")
        return set()

    by_user = holdings.fetch_holdings_by_user(settings)
    section_by_company = {section["company"]: section for section in sections}

    sent = 0
    sent_emails: set[str] = set()
    empty = {row["company"] for row in collection_results or [] if row["status"] == "empty"}
    for index, subscriber in enumerate(subscribers):
        names = list(dict.fromkeys(by_user.get(str(subscriber["id"]), [])))
        my_sections = [section_by_company[n] for n in names if n in section_by_company]
        count = sum(len(section["filings"]) for section in my_sections)
        if not settings.send_email:
            status.delivery(settings, subscriber["id"], "disabled")
            continue
        if index >= MAX_RECIPIENTS:
            status.delivery(settings, subscriber["id"], "limit_reached", count)
            continue
        if not my_sections:
            state = "no_filings" if all(name in empty for name in names) else "collection_failed"
            status.delivery(settings, subscriber["id"], state)
            continue
        if not settings.smtp_user or not settings.smtp_password:
            status.delivery(settings, subscriber["id"], "failed", count)
            continue

        important = find_important(my_sections)
        prefix = "⚠️ " if important else ""
        subject = f"{prefix}📈 내 종목 공시 브리핑 {datetime.now(ZoneInfo('Asia/Seoul')):%m/%d}"
        if important:
            subject += f" — {important[0].split(' · ')[1][:20]}"
            if len(important) > 1:
                subject += f" 외 {len(important) - 1}건"

        quiet = [n for n in names if n in empty]
        unknown = [n for n in names if n not in section_by_company and n not in empty]
        notes = []
        if quiet:
            notes.append(f"조회 완료 · 신규 공시 없음: {', '.join(quiet)}")
        if unknown:
            notes.append(f"수집 미완료 · 공시 유무 확인 불가: {', '.join(unknown)}")
        extra_note = " / ".join(notes) or None
        html = emailer.build_html(my_sections, extra_note=extra_note)
        try:
            emailer.send(
                settings.smtp_host,
                settings.smtp_port,
                settings.smtp_user,
                settings.smtp_password,
                subscriber["email"],
                html,
                subject=subject,
            )
            sent += 1
            sent_emails.add(subscriber["email"].strip().lower())
            status.delivery(settings, subscriber["id"], "sent", count)
            print("  - 맞춤 알림 발송 완료")
        except Exception:
            status.delivery(settings, subscriber["id"], "failed", count)
            print("  ⚠ 맞춤 알림 발송 실패 (수신자·외부 응답 생략)")

    print(f"알림: 총 {sent}명에게 발송 완료")
    return sent_emails


def send_batch(settings, email, member_id, items, extra_note=None):
    batch = recovery.prepare(settings,email,member_id,items)
    if not batch:
        return "already_sent", 0
    batch_id = batch["id"]
    message_id = f"<stock-briefing.{batch_id}@stock-briefing.local>"
    count = len(batch["items"])
    if batch["state"] in ("sending","uncertain"):
        attempted = datetime.fromisoformat(batch["attempted_at"].replace("Z","+00:00"))
        if (datetime.now(timezone.utc)-attempted).total_seconds()<900:
            return "uncertain", count  # The earlier sender may still be in SMTP DATA.
    # A missing/failed lookup never authorizes a blind resend.
    if settings.smtp_host == "smtp.gmail.com":
        if emailer.was_sent(settings.smtp_user,settings.smtp_password,message_id):
            recovery.finish(settings,batch_id,"sent")
            return "sent",count
        if batch["state"] in ("sending","uncertain"):
            if not recovery.rest(settings,'rpc/retry_briefing_batch',method='POST',body={'batch_id':batch_id}):
                return 'uncertain',count
    elif batch["state"] in ("sending","uncertain"):
        return "uncertain",count
    if not recovery.start(settings,batch_id):
        return "uncertain",count
    grouped = {}
    for item in batch["items"]:
        key=(item["market"],item["company"])
        section=grouped.setdefault(key,{"company":item["company"],"market":item["market"],"summary_html":"","filings":[]})
        section["summary_html"]+=item["summary_html"]
        section["filings"].append(item["filing"])
    sections=list(grouped.values())
    subject=f"{'⚠️ ' if find_important(sections) else ''}📈 내 종목 공시 브리핑 {datetime.now(ZoneInfo('Asia/Seoul')):%m/%d}"
    try:
        emailer.send(settings.smtp_host,settings.smtp_port,settings.smtp_user,settings.smtp_password,email,
            emailer.build_html(sections,extra_note=extra_note),subject=subject,message_id=message_id)
    except (smtplib.SMTPAuthenticationError,smtplib.SMTPRecipientsRefused,smtplib.SMTPSenderRefused) as error:
        recovery.finish(settings,batch_id,"failed")
        raise RuntimeError("Mail rejected before acceptance") from error
    except Exception:
        recovery.finish(settings,batch_id,"uncertain")
        return "uncertain",count
    recovery.finish(settings,batch_id,"sent")
    return "sent",count


def send_durable(settings, results):
    subscribers=holdings.fetch_subscribers(settings)
    rows=holdings._fetch_market_rows(settings)
    items=recovery.ready_items(settings)
    recognized=set()
    for index,member in enumerate(subscribers):
        user_id=str(member["id"])
        owned=[row for row in rows if str(row["user_id"])==user_id]
        keys={(row["market"],row["stock_name"]) for row in owned}
        codes={(row["market"],row["stock_code"]) for row in owned}
        mine=[item for item in items if (item["market"],item["company"]) in keys or (item["market"],item["stock_code"]) in codes]
        try:
            if not settings.send_email:
                state,count="disabled",0
            elif index>=MAX_RECIPIENTS:
                state,count="limit_reached",len(mine)
            elif not mine:
                empty={(row["market"],row["company"]) for row in results if row["status"]=="empty"}
                state,count=("no_filings" if keys<=empty else "collection_failed"),0
            else:
                quiet=[row['company'] for row in results if (row['market'],row['company']) in keys and row['status']=='empty']
                unknown=[name for market,name in keys if not any(row['market']==market and row['company']==name and row['status'] in ('success','empty') for row in results)]
                notes=[]
                if quiet: notes.append('조회 완료 · 신규 공시 없음: '+', '.join(quiet))
                if unknown: notes.append('수집 미완료 · 공시 유무 확인 불가: '+', '.join(unknown))
                state,count=send_batch(settings,member["email"],user_id,mine,extra_note=' / '.join(notes) or None)
            status.delivery(settings,user_id,state,count)
            if state in ("sent","already_sent","uncertain"):
                recognized.add(member["email"].strip().lower())
        except Exception:
            status.delivery(settings,user_id,"failed",len(mine))
            # Suppress the administrator fallback after uncertain/failed personalized delivery too.
            recognized.add(member["email"].strip().lower())
            print("⚠ 맞춤 발송/확인 실패 · 다음 실행에서 복구 (개인정보 생략)")
    return recognized
