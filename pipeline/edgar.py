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
from urllib.parse import urljoin, urlsplit, unquote
from xml.etree import ElementTree

import requests

from .retry import with_retry
from .documents import Links, extract_text

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

# SEC 요구사항: 서비스명 + 연락처. 환경변수로 재정의 가능.
USER_AGENT = os.getenv(
    "SEC_USER_AGENT",
    "stock-briefing personal project (github.com/Felix0708/stock-briefing)",
)

# 브리핑에 포함할 서식. Form 4는 아래에서 실제 P/S 거래만 선별한다.
FORM_NAMES_KO = {
    "8-K": "수시보고 (8-K)",
    "8-K/A": "수시보고 정정 (8-K/A)",
    "10-Q": "분기보고서 (10-Q)",
    "10-Q/A": "분기보고서 정정 (10-Q/A)",
    "10-K": "연차보고서 (10-K)",
    "10-K/A": "연차보고서 정정 (10-K/A)",
    "6-K": "외국기업 수시보고 (6-K)",
    "6-K/A": "외국기업 수시보고 정정 (6-K/A)",
    "20-F": "외국기업 연차보고 (20-F)",
    "20-F/A": "외국기업 연차보고 정정 (20-F/A)",
    "DEF 14A": "주주총회 위임장 (DEF 14A)",
    "S-1": "증권신고서 (S-1)",
    "SC 13D": "대량보유 보고 (SC 13D)",
    "SC 13D/A": "대량보유 변동 (SC 13D/A)",
    "SC 13G": "대량보유 보고 (SC 13G)",
    "SC 13G/A": "대량보유 변동 (SC 13G/A)",
}

FORM4_NAMES = {"4", "4/A"}

_last_request_at = 0.0


def _get(url: str, timeout: int = 30) -> requests.Response:
    """SEC 호출. 초당 10회 제한을 지키기 위해 호출 간 최소 간격을 둔다."""
    global _last_request_at

    def call() -> requests.Response:
        global _last_request_at
        current=url
        for _ in range(4):
            parsed=urlsplit(current)
            if parsed.scheme!='https' or parsed.netloc not in ('www.sec.gov','data.sec.gov'):
                raise ValueError('SEC request cannot leave official hosts')
            wait = 0.12 - (time.time() - _last_request_at)
            if wait > 0:
                time.sleep(wait)
            resp = requests.get(current, headers={"User-Agent": USER_AGENT}, timeout=timeout,allow_redirects=False)
            _last_request_at = time.time()
            if resp.status_code in (301,302,303,307,308):
                current=urljoin(current,resp.headers['Location'])
                continue
            resp.raise_for_status()
            return resp
        raise ValueError('Too many SEC redirects')

    return with_retry(call, label="EDGAR")


def load_ticker_ciks(tickers: list[str] | None = None) -> dict[str, int]:
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
    # Some ADRs are absent from company_tickers.json but remain in SEC's official
    # ticker.txt. Only fill missing entries; the primary mapping stays authoritative.
    if tickers and any(ticker.upper() not in mapping for ticker in tickers):
        try:
            legacy_file = CACHE_DIR / f"edgar_tickers_{datetime.now():%Y%m%d}.txt"
            if legacy_file.exists():
                legacy = legacy_file.read_text()
            else:
                legacy = _get("https://www.sec.gov/include/ticker.txt").text
                legacy_file.write_text(legacy)
            for line in legacy.splitlines():
                parts = line.split()
                if len(parts) == 2 and re.fullmatch(r"[A-Za-z][A-Za-z0-9.\-]{0,9}", parts[0]) and parts[1].isdigit():
                    mapping.setdefault(parts[0].upper(), int(parts[1]))
        except Exception:
            print("⚠ SEC 보조 티커 목록 조회 실패 (기존 매핑 유지)")
    return mapping


def _form4_open_market_codes(document_url: str) -> set[str]:
    """Form 4 원문에서 실제 매수(P)·매도(S) 코드만 반환한다."""
    # SEC's xslF345X.. URL renders HTML; transaction codes live in the raw XML.
    xml_url = re.sub(r"/xslF345X\d+/", "/", document_url)
    root = ElementTree.fromstring(_get(xml_url).content)
    if root.tag.rsplit("}", 1)[-1] != "ownershipDocument":
        raise ValueError("Expected Form 4 ownership XML")
    return {
        (node.text or "").strip().upper()
        for node in root.iter()
        if node.tag.rsplit("}", 1)[-1] == "transactionCode"
        and (node.text or "").strip().upper() in {"P", "S"}
    }


def fetch_filings(ticker: str, cik: int, lookback_days: int) -> list[dict]:
    """특정 티커의 최근 공시 목록 (dart.fetch_filings와 동일한 형식).

    submissions JSON의 recent 블록은 병렬 배열 구조:
    form[i], filingDate[i], accessionNumber[i], primaryDocument[i] 가 한 건.
    """
    since = (datetime.now() - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    data = _get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json").json()
    filings_data = data.get("filings")
    if not isinstance(filings_data, dict) or not isinstance(filings_data.get("recent"), dict):
        raise ValueError("Invalid SEC submissions response")
    recent = {key: list(value) for key, value in filings_data["recent"].items()}
    for archive in filings_data.get("files", []):
        if archive.get("filingTo", "") < since:
            continue
        name = archive.get("name", "")
        if not re.fullmatch(r"CIK\d+-submissions-\d+\.json", name):
            raise ValueError("Invalid SEC submissions archive")
        older = _get(f"https://data.sec.gov/submissions/{name}").json()
        for key in ("form", "filingDate", "accessionNumber", "primaryDocument", "primaryDocDescription"):
            recent.setdefault(key, []).extend(older.get(key, [""] * len(older.get("form", []))))

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
            continue  # Archive blocks need not be globally sorted.
        if form not in FORM_NAMES_KO and form not in FORM4_NAMES:
            continue

        accession = accessions[i]
        acc_nodash = accession.replace("-", "")
        document = documents[i] if i < len(documents) else ""
        description = descriptions[i] if i < len(descriptions) else ""

        doc_url = (
            f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc_nodash}/{document}"
            if document
            else ""
        )

        if form in FORM4_NAMES:
            if not doc_url:
                continue
            try:
                transaction_codes = _form4_open_market_codes(doc_url)
            except Exception:
                raise RuntimeError("Form 4 거래 코드 조회 실패") from None
            if not transaction_codes:
                continue
            action = (
                "내부자 매수·매도"
                if transaction_codes == {"P", "S"}
                else "내부자 매수"
                if "P" in transaction_codes
                else "내부자 매도"
            )
            report_nm = f"{action} (Form {form})"
        else:
            report_nm = FORM_NAMES_KO[form]
            if description and description.lower() not in {form.lower(), "form " + form.lower()}:
                report_nm += f" — {description[:60]}"

        filings.append(
            {
                "report_nm": report_nm,
                "rcept_no": accession,  # 고유 ID (RAG 중복 스킵에 사용)
                "rcept_dt": date.replace("-", ""),
                "flr_nm": ticker,
                "url": doc_url
                or f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik:010d}",
                # 원문 텍스트 추출용 (dart와 달리 문서 URL을 직접 안다)
                "_doc_url": doc_url,
                "form": form,
            }
        )
    return sorted({row["rcept_no"]: row for row in filings}.values(), key=lambda row: row["rcept_dt"], reverse=True)


def fetch_document_text(filing: dict, max_chars: int) -> str:
    """Read the filing and same-filing exhibits, prioritizing exhibits over a cover page."""
    doc_url = filing.get("_doc_url", "")
    if not doc_url:
        return ""
    parsed = urlsplit(doc_url)
    if parsed.scheme != "https" or parsed.netloc != "www.sec.gov" or not parsed.path.startswith("/Archives/edgar/data/"):
        raise ValueError("Invalid SEC document URL")
    response = _get(doc_url, timeout=60)
    raw = response.text
    main_text = extract_text(response.content)
    parser = Links()
    parser.feed(raw)
    directory = parsed.path.rsplit("/", 1)[0] + "/"
    # Exhibits need not be linked from the cover. SEC's filing index lists their document types.
    if filing.get('form','').startswith(('6-K','8-K')) and re.fullmatch(r'\d{10}-\d{2}-\d{6}',filing.get('rcept_no','')):
        index_url=urljoin(doc_url,filing['rcept_no']+'-index.html')
        index_html=_get(index_url,timeout=60).text
        for row in re.findall(r'<tr\b[^>]*>(.*?)</tr>',index_html,re.S|re.I):
            if re.search(r'>\s*EX-\d',row,re.I):
                parser.feed(row)
    attachments = []
    for link in parser.links:
        target = urlsplit(urljoin(doc_url, link))
        path = unquote(target.path)
        if (target.scheme != "https" or target.netloc != "www.sec.gov" or target.query
                or not path.startswith(directory) or path == parsed.path
                or any(part in (".", "..") for part in path.split("/"))
                or not path.lower().endswith((".htm", ".html", ".pdf", ".txt"))):
            continue
        url = target._replace(fragment="").geturl()
        if url not in attachments:
            attachments.append(url)
    parts = []
    for url in attachments:
        response = _get(url, timeout=60)
        body = extract_text(response.content)
        if not body:
            raise ValueError("Empty SEC exhibit")
        parts.append(f"[첨부 원문: {url}]\n{body}")
    # Equal allocation keeps a long first exhibit from hiding the rest of the filing.
    parts.append(f"[대표 원문: {doc_url}]\n{main_text}")
    budget = max_chars // len(parts)
    return "\n\n".join(part[:budget] for part in parts)
