"""EDINET 클라이언트 (일본 공시).

일본판 DART/SEC. 단, 구조가 결정적으로 다르다:
- DART/SEC는 "회사별" 조회가 되지만, EDINET은 "날짜별 전체 제출 목록"만 준다.
  → lookback 기간의 각 날짜마다 그날 일본 전체 공시를 받아 secCode로 필터링한다.
- v2부터 API 키(Subscription-Key)가 필수. 환경변수 EDINET_API_KEY로 주입.
- 종목코드는 4자리지만 EDINET secCode는 끝에 0이 붙은 5자리 (7203 → 72030).

공식 XBRL/HTML 또는 PDF 원문을 읽고, 목록 조회 실패를 공시 없음과 구분한다.

반환 형식은 dart.fetch_filings와 동일한 dict로 맞춘다 → 하위 파이프라인 재사용.
API 문서: https://disclosure2dl.edinet-fsa.go.jp/guide/static/disclosure/WZEK0110.html
"""

from datetime import datetime, timedelta
import re
from zoneinfo import ZoneInfo

import requests

from .retry import with_retry
from .documents import extract_text

BASE = "https://api.edinet-fsa.go.jp/api/v2"
_TIMEOUT = 30

# 브리핑에 포함할 주요 서식 (docTypeCode). 대량보유·내부자 등 잡음성 서식은 제외.
DOC_TYPE_KO = {
    "120": "유가증권보고서 (연차)",
    "130": "유가증권보고서 정정",
    "140": "사분기보고서",
    "150": "사분기보고서 정정",
    "160": "반기보고서",
    "170": "반기보고서 정정",
    "180": "임시보고서",
    "190": "임시보고서 정정",
    "200": "유가증권신고서",
    "350": "대량보유보고서",
    "360": "대량보유보고서 정정",
}


def _get(url: str, params: dict) -> requests.Response:
    def call() -> requests.Response:
        resp = requests.get(url, params=params, timeout=_TIMEOUT)
        resp.raise_for_status()
        return resp

    return with_retry(call, label="EDINET")


def fetch_filings(stock_code: str, lookback_days: int, api_key: str) -> list[dict]:
    """일본 종목(4자리 코드)의 최근 공시 목록 (dart.fetch_filings와 동일한 형식).

    EDINET은 날짜별 조회만 되므로, lookback 기간의 각 날짜를 순회하며
    그날 전체 제출 목록에서 이 종목(secCode)만 골라낸다.
    """
    if not api_key:
        return []

    sec_code = stock_code.strip()
    if len(sec_code) == 4:
        sec_code += "0"  # EDINET secCode는 5자리 (끝에 0)

    filings: list[dict] = []
    today = datetime.now(ZoneInfo("Asia/Tokyo"))
    for offset in range(lookback_days + 1):
        day = (today - timedelta(days=offset)).strftime("%Y-%m-%d")
        data = _get(
            f"{BASE}/documents.json",
            {"date": day, "type": "2", "Subscription-Key": api_key},
        ).json()
        if str(data.get("metadata", {}).get("status")) != "200" or not isinstance(data.get("results"), list):
            raise ValueError("EDINET list request did not succeed")

        for item in data.get("results", []):
            if str(item.get("secCode") or "") != sec_code:
                continue
            doc_type = str(item.get("docTypeCode") or "")
            if doc_type not in DOC_TYPE_KO:
                continue

            doc_id = item.get("docID", "")
            description = (item.get("docDescription") or "").strip()
            report_nm = DOC_TYPE_KO[doc_type]
            if description and description != report_nm:
                report_nm += f" — {description[:60]}"

            submit_dt = str(item.get("submitDateTime") or "")[:10].replace("-", "")

            filings.append(
                {
                    "report_nm": report_nm,
                    "rcept_no": doc_id,  # 고유 ID (RAG 중복 스킵)
                    "rcept_dt": submit_dt,
                    "flr_nm": (item.get("filerName") or stock_code).strip(),
                    "_document_type": 1 if str(item.get("xbrlFlag")) == "1" else 2,
                    # EDINET 웹 뷰어 링크
                    "url": f"https://disclosure2.edinet-fsa.go.jp/WEEK0040.aspx?"
                    f"dwn={doc_id}" if doc_id else "https://disclosure2.edinet-fsa.go.jp/",
                }
            )
    return filings


def fetch_document_text(filing: dict, max_chars: int, api_key: str = "") -> str:
    doc_id = filing.get("rcept_no", "")
    if not api_key or not re.fullmatch(r"S[0-9A-Z]{7}", doc_id):
        raise ValueError("Missing EDINET document credentials or ID")
    response = _get(f"{BASE}/documents/{doc_id}", {"type": filing.get("_document_type", 1), "Subscription-Key": api_key})
    text = extract_text(response.content)
    if not text:
        raise ValueError("EDINET document contains no extractable text")
    return text[:max_chars]
