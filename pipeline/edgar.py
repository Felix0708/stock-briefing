"""SEC EDGAR 클라이언트 (미국 공시).

미국판 DART. 공식 무료 API로, 키는 필요 없지만 두 가지 규칙이 있다:
- User-Agent에 서비스명과 연락처를 명시할 것 (없으면 차단됨)
- 초당 10회 요청 제한

사용하는 엔드포인트:
1. company_tickers.json : 전체 상장사 티커 → CIK 매핑 (일 단위 캐시)
2. submissions/CIK{...}.json : 회사별 최근 제출 목록
3. Archives/edgar/... : 공시 원문 (HTML)

반환 형식은 dart.fetch_filings와 동일한 dict로 맞춘다
→ 요약·인덱싱·알림·Q&A 등 하위 파이프라인을 그대로 재사용하기 위함.
"""

import json
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from .retry import with_retry

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

# SEC 요구사항: 서비스명 + 연락처. 환경변수로 재정의 가능.
USER_AGENT = os.getenv(
    "SEC_USER_AGENT",
    "stock-briefing personal project (github.com/Felix0708/stock-briefing)",
)

# 브리핑에 포함할 서식 (Form 4 내부자거래는 건수가 너무 많아 제외)
FORM_NAMES_KO = {
    "8-K": "수시보고 (8-K)",
    "8-K/A": "수시보고 정정 (8-K/A)",
    "10-Q": "분기보고서 (10-Q)",
    "10-Q/A": "분기보고서 정정 (10-Q/A)",
    "10-K": "연차보고서 (10-K)",
    "10-K/A": "연차보고서 정정 (10-K/A)",
    "6-K": "외국기업 수시보고 (6-K)",
    "20-F": "외국기업 연차보고 (20-F)",
    "DEF 14A": "주주총회 위임장 (DEF 14A)",
    "S-1": "증권신고서 (S-1)",
    "SC 13D": "대량보유 보고 (SC 13D)",
    "SC 13D/A": "대량보유 변동 (SC 13D/A)",
    "SC 13G": "대량보유 보고 (SC 13G)",
    "SC 13G/A": "대량보유 변동 (SC 13G/A)",
}

_last_request_at = 0.0


def _get(url: str, timeout: int = 30) -> requests.Response:
    """SEC 호출. 초당 10회 제한을 지키기 위해 호출 간 최소 간격을 둔다."""
    global _last_request_at

    def call() -> requests.Response:
        global _last_request_at
        wait = 0.12 - (time.time() - _last_request_at)
        if wait > 0:
            time.sleep(wait)
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=timeout)
        _last_request_at = time.time()
        resp.raise_for_status()
        return resp

    return with_retry(call, label="EDGAR")


def load_ticker_ciks() -> dict[str, int]:
    """티커 → CIK 매핑 (일 단위 캐시). 예: {"AAPL": 320193, "DELL": 1571996}"""
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / f"edgar_ciks_{datetime.now():%Y%m%d}.json"

    if cache_file.exists():
        raw = json.loads(cache_file.read_text())
    else:
        raw = _get("https://www.sec.gov/files/company_tickers.json", timeout=60).json()
        cache_file.write_text(json.dumps(raw))

    mapping: dict[str, int] = {}
    for item in raw.values():
        ticker = str(item.get("ticker", "")).upper()
        cik = item.get("cik_str")
        if ticker and isinstance(cik, int):
            mapping[ticker] = cik
    return mapping


def fetch_filings(ticker: str, cik: int, lookback_days: int) -> list[dict]:
    """특정 티커의 최근 공시 목록 (dart.fetch_filings와 동일한 형식).

    submissions JSON의 recent 블록은 병렬 배열 구조:
    form[i], filingDate[i], accessionNumber[i], primaryDocument[i] 가 한 건.
    """
    since = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    data = _get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json").json()
    recent = data.get("filings", {}).get("recent", {})

    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    accessions = recent.get("accessionNumber", [])
    documents = recent.get("primaryDocument", [])
    descriptions = recent.get("primaryDocDescription", [])

    filings = []
    for i in range(len(forms)):
        form = forms[i]
        date = dates[i]
        if date < since:
            break  # 최신순 정렬이므로 기간을 벗어나면 중단
        if form not in FORM_NAMES_KO:
            continue

        accession = accessions[i]
        acc_nodash = accession.replace("-", "")
        document = documents[i] if i < len(documents) else ""
        description = descriptions[i] if i < len(descriptions) else ""

        report_nm = FORM_NAMES_KO[form]
        if description and description.lower() not in {form.lower(), "form " + form.lower()}:
            report_nm += f" — {description[:60]}"

        filings.append(
            {
                "report_nm": report_nm,
                "rcept_no": accession,  # 고유 ID (RAG 중복 스킵에 사용)
                "rcept_dt": date.replace("-", ""),
                "flr_nm": ticker,
                "url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{document}"
                if document
                else f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik:010d}",
                # 원문 텍스트 추출용 (dart와 달리 문서 URL을 직접 안다)
                "_doc_url": f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{document}"
                if document
                else "",
            }
        )
    return filings


_TAG_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_HTML_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def fetch_document_text(filing: dict, max_chars: int) -> str:
    """공시 원문 HTML을 순수 텍스트로 반환 (실패 시 빈 문자열 — 제목만으로 요약 가능)."""
    doc_url = filing.get("_doc_url", "")
    if not doc_url:
        return ""
    try:
        raw = _get(doc_url, timeout=60).text
    except Exception:
        return ""

    text = _TAG_RE.sub(" ", raw)
    text = _HTML_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text).strip()
    return text[:max_chars]
