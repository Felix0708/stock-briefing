"""회원별 맞춤 브리핑 메일 (Phase 3 알림).

수신 동의(user_metadata.briefing_email)한 회원에게,
그 회원의 보유 종목에 해당하는 공시만 골라 발송한다.
중요 공시(유상증자·합병 등)가 있으면 제목에 ⚠️를 붙인다.
"""

from datetime import datetime

from . import emailer, holdings
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


def send_personalized(settings: Settings, sections: list[dict]) -> None:
    """회원별로 보유 종목 공시만 추려서 발송."""
    subscribers = holdings.fetch_subscribers(settings)
    if not subscribers:
        print("알림: 수신 동의 회원 없음 → 개인 알림 생략")
        return

    by_user = holdings.fetch_holdings_by_user(settings)
    section_by_company = {section["company"]: section for section in sections}

    sent = 0
    for subscriber in subscribers[:MAX_RECIPIENTS]:
        names = by_user.get(str(subscriber["id"]), [])
        my_sections = [section_by_company[n] for n in names if n in section_by_company]
        if not my_sections:
            continue  # 이 회원의 종목엔 오늘 공시 없음

        important = find_important(my_sections)
        prefix = "⚠️ " if important else ""
        subject = f"{prefix}📈 내 종목 공시 브리핑 {datetime.now():%m/%d}"
        if important:
            subject += f" — {important[0].split(' · ')[1][:20]}"
            if len(important) > 1:
                subject += f" 외 {len(important) - 1}건"

        html = emailer.build_html(my_sections)
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
            print(f"  - 알림 발송: {subscriber['email']} (종목 {len(my_sections)}개"
                  f"{', 중요 ' + str(len(important)) + '건' if important else ''})")
        except Exception as e:
            print(f"  ⚠ 알림 발송 실패 ({subscriber['email']}): {e}")

    print(f"알림: 총 {sent}명에게 발송 완료")
