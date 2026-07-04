"""Gemini를 이용한 공시 요약.

설계 포인트:
- 종목당 1회 호출 (공시 여러 건을 한 프롬프트에 묶음) → 무료 티어 요청 수 절약
- 출력은 그대로 메일에 넣을 수 있는 HTML 조각으로 받는다
- 모델명은 config에서 주입 (무료 티어 정책 변경 대비)
"""

from google import genai

SYSTEM_PROMPT = """당신은 한국 주식 공시 분석 어시스턴트입니다.
주어진 공시들을 개인 투자자가 아침에 30초 안에 읽을 수 있도록 요약하세요.

규칙:
- 공시별로 <li> 태그 하나씩. 형식: <li><b>공시명</b>: 핵심 내용 1~2문장. 투자 관점에서 중요하면 그 이유를 짧게.</li>
- 전체를 <ul>...</ul>로 감싸서 출력. 다른 텍스트나 마크다운 코드블록 없이 HTML만 출력.
- 수치(금액, 지분율, 일정)가 있으면 반드시 포함.
- 단순 정정공시나 형식적 공시는 한 문장으로 짧게.
- 매수/매도 추천은 절대 하지 않는다. 사실 요약과 의미 설명까지만."""


def summarize_company(
    api_key: str,
    model: str,
    company: str,
    filings: list[dict],
    doc_texts: dict[str, str],
) -> str:
    """한 기업의 신규 공시 묶음을 HTML <ul> 요약으로 반환."""
    parts = [f"기업: {company}", ""]
    for f in filings:
        parts.append(f"### 공시명: {f['report_nm']} (접수일 {f['rcept_dt']})")
        body = doc_texts.get(f["rcept_no"], "")
        parts.append(f"본문 발췌: {body}" if body else "(본문 없음 — 제목으로만 판단)")
        parts.append("")

    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(
        model=model,
        contents="\n".join(parts),
        config={"system_instruction": SYSTEM_PROMPT, "temperature": 0.3},
    )
    html = (response.text or "").strip()
    # 모델이 규칙을 어기고 코드블록으로 감쌌을 경우 방어
    html = html.removeprefix("```html").removeprefix("```").removesuffix("```").strip()
    return html
