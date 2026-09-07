"""HTML 브리핑 메일 발송 (Gmail SMTP).

Gmail은 2단계 인증 + 앱 비밀번호로 SMTP를 쓸 수 있다 (SETUP.md 참고).
나중에 Resend/SES 등으로 바꾸려면 이 파일만 교체하면 된다.
"""

import smtplib
import imaplib
import re
from html import escape
from datetime import datetime
from zoneinfo import ZoneInfo
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

DISCLAIMER = (
    "본 메일은 공시 정보를 AI가 요약한 것으로, 오류가 있을 수 있으며 "
    "투자 권유가 아닙니다. 투자 판단의 책임은 본인에게 있습니다."
)


def build_html(sections: list[dict], extra_note: str | None = None) -> str:
    """sections: [{"company": str, "summary_html": str, "filings": [dict]}]"""
    today = datetime.now(ZoneInfo("Asia/Seoul")).strftime("%Y-%m-%d")
    blocks = []
    for s in sections:
        links = " · ".join(
            f'<a href="{escape(f["url"], quote=True)}" style="color:#888;font-size:12px;">{escape(f["report_nm"])}</a>'
            for f in s["filings"]
        )
        blocks.append(
            f"""
            <div style="margin-bottom:28px;">
              <h2 style="font-size:17px;border-bottom:2px solid #333;padding-bottom:6px;">
                {escape(s["company"])} <span style="color:#999;font-weight:normal;font-size:13px;">공시 {len(s["filings"])}건</span>
              </h2>
              {s["summary_html"]}
              <p style="margin-top:4px;">원문: {links}</p>
            </div>"""
        )

    body = "\n".join(blocks) if blocks else "<p>이번 브리핑에 포함된 공시가 없습니다. 아래 조회 상태를 확인해 주세요.</p>"
    if extra_note:
        body += f'<p style="color:#999;font-size:13px;margin-top:20px;">{escape(extra_note)}</p>'
    return f"""
    <html><body style="font-family:'Apple SD Gothic Neo',sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#222;">
      <h1 style="font-size:20px;">📈 아침 공시 브리핑 <span style="font-size:14px;color:#999;">{today}</span></h1>
      {body}
      <hr style="border:none;border-top:1px solid #ddd;margin-top:32px;">
      <p style="font-size:11px;color:#aaa;">{DISCLAIMER}</p>
    </body></html>"""


def send(
    smtp_host: str,
    smtp_port: int,
    user: str,
    password: str,
    to: str,
    html: str,
    subject: str | None = None,
    message_id: str | None = None,
) -> None:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject or f"📈 아침 공시 브리핑 {datetime.now(ZoneInfo('Asia/Seoul')):%m/%d}"
    msg["From"] = user
    msg["To"] = to
    if message_id:
        msg["Message-ID"] = message_id
    msg.attach(MIMEText(html, "html", "utf-8"))

    with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=30) as server:
        server.login(user, password)
        server.sendmail(user, [addr.strip() for addr in to.split(",")], msg.as_string())


def was_sent(user: str, password: str, message_id: str) -> bool:
    """Search only this app's exact Message-ID in Gmail Sent. Never fetch email content."""
    if not re.fullmatch(r"<stock-briefing\.[0-9a-f-]{36}@stock-briefing\.local>", message_id):
        raise ValueError("Not an application Message-ID")
    with imaplib.IMAP4_SSL("imap.gmail.com", timeout=30) as client:
        client.login(user, password)
        result, folders = client.list()
        if result != "OK":
            raise RuntimeError("Sent folder lookup failed")
        for folder in folders or []:
            if not isinstance(folder,bytes):
                continue
            match = re.match(rb'^\(([^)]*)\) "[^"]*" (.+)$',folder)
            if match and b"\\sent" in match[1].lower().split():
                result, _ = client.select(match[2], readonly=True)
                if result != "OK":
                    raise RuntimeError("Sent folder unavailable")
                result, ids = client.uid("search",None,"HEADER","Message-ID",f'"{message_id}"')
                if result != "OK":
                    raise RuntimeError("Delivery verification failed")
                return bool(ids and ids[0])
        raise RuntimeError("Sent folder not found")
