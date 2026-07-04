"""DART OpenAPI 클라이언트.

사용하는 엔드포인트 3개:
1. corpCode.xml : 전체 기업 고유번호 목록 (zip). 기업명 → corp_code 변환용. 하루 1회 캐시.
2. list.json    : 공시 검색. 기업별 최근 공시 목록.
3. document.xml : 공시 원문 (zip 안에 XML/HTML). 요약의 재료.

API 문서: https://opendart.fss.or.kr/guide/main.do
"""

import io
import re
import zipfile
from datetime import datetime, timedelta
from pathlib import Path
from xml.etree import ElementTree

import requests

BASE = "https://opendart.fss.or.kr/api"
CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

# DART 공시 뷰어 링크 (메일에서 원문 바로가기용)
VIEWER_URL = "https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"


class DartError(RuntimeError):
    pass


def _get(url: str, params: dict, timeout: int = 30) -> requests.Response:
    resp = requests.get(url, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp


def load_corp_codes(api_key: str) -> dict[str, str]:
    """기업명 → corp_code 매핑을 반환. 결과는 로컬에 캐시.

    corpCode.xml은 약 10만 개 기업이 담긴 zip이라 매번 받으면 낭비.
    같은 날짜의 캐시가 있으면 재사용한다.
    """
    CACHE_DIR.mkdir(exist_ok=True)
    cache_file = CACHE_DIR / f"corp_codes_{datetime.now():%Y%m%d}.xml"

    if cache_file.exists():
        xml_bytes = cache_file.read_bytes()
    else:
        resp = _get(f"{BASE}/corpCode.xml", {"crtfc_key": api_key}, timeout=60)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            xml_bytes = zf.read(zf.namelist()[0])
        cache_file.write_bytes(xml_bytes)

    root = ElementTree.fromstring(xml_bytes)
    mapping: dict[str, str] = {}
    for item in root.iter("list"):
        name = (item.findtext("corp_name") or "").strip()
        code = (item.findtext("corp_code") or "").strip()
        stock_code = (item.findtext("stock_code") or "").strip()
        # 상장사만 대상 (stock_code가 있는 기업). 비상장사 중복 이름 문제 회피.
        if name and code and stock_code:
            mapping[name] = code
    return mapping


def fetch_filings(api_key: str, corp_code: str, lookback_days: int) -> list[dict]:
    """특정 기업의 최근 공시 목록을 반환.

    반환 예: [{"report_nm": "주요사항보고서(유상증자결정)", "rcept_no": "...",
              "rcept_dt": "20260703", "flr_nm": "삼성전자", "url": "..."}]
    """
    end = datetime.now()
    begin = end - timedelta(days=lookback_days)
    params = {
        "crtfc_key": api_key,
        "corp_code": corp_code,
        "bgn_de": begin.strftime("%Y%m%d"),
        "end_de": end.strftime("%Y%m%d"),
        "page_count": 100,
    }
    data = _get(f"{BASE}/list.json", params).json()

    status = data.get("status")
    if status == "013":  # 조회 결과 없음 (정상 케이스)
        return []
    if status != "000":
        raise DartError(f"DART list.json 오류 status={status}: {data.get('message')}")

    filings = []
    for item in data.get("list", []):
        filings.append(
            {
                "report_nm": item.get("report_nm", "").strip(),
                "rcept_no": item.get("rcept_no", ""),
                "rcept_dt": item.get("rcept_dt", ""),
                "flr_nm": item.get("flr_nm", ""),
                "url": VIEWER_URL.format(rcept_no=item.get("rcept_no", "")),
            }
        )
    return filings


_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def fetch_document_text(api_key: str, rcept_no: str, max_chars: int) -> str:
    """공시 원문을 받아 태그를 제거한 순수 텍스트로 반환 (max_chars로 절단).

    document.xml은 zip으로 오고, 안에 공시 본문 XML이 1개 이상 들어있다.
    실패해도 파이프라인 전체를 죽이지 않도록 빈 문자열을 반환한다
    (제목만으로도 요약은 가능하므로).
    """
    try:
        resp = _get(f"{BASE}/document.xml", {"crtfc_key": api_key, "rcept_no": rcept_no}, timeout=60)
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            # 가장 큰 파일이 본문일 확률이 높다
            name = max(zf.namelist(), key=lambda n: zf.getinfo(n).file_size)
            raw = zf.read(name).decode("utf-8", errors="ignore")
    except Exception:
        return ""

    text = _TAG_RE.sub(" ", raw)
    text = _WS_RE.sub(" ", text).strip()
    return text[:max_chars]
