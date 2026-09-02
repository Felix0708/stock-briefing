"""브리핑 결과를 웹 대시보드용 JSON으로 저장.

GitHub Pages는 정적 파일만 서빙할 수 있으므로,
파이프라인이 매일 결과를 docs/data/ 아래 JSON으로 남기고
docs/index.html(대시보드)이 이를 fetch해서 렌더링한다.

docs/data/index.json          : 날짜 목록 (대시보드의 날짜 선택용)
docs/data/briefings/YYYY-MM-DD.json : 그날의 브리핑 데이터
"""

import json
from datetime import datetime
from pathlib import Path

from .notify import IMPORTANT_KEYWORDS

DATA_DIR = Path(__file__).resolve().parent.parent / "docs" / "data"


def _public_sections(sections: list[dict]) -> list[dict]:
    """공개 JSON 필드를 allowlist로 재구성해 회원·계좌 데이터 혼입을 막는다."""
    result = []
    for section in sections:
        filings = [
            {
                key: filing[key]
                for key in ("report_nm", "rcept_no", "rcept_dt", "flr_nm", "url")
                if key in filing
            }
            for filing in section.get("filings", [])
        ]
        result.append(
            {
                "company": section.get("company", ""),
                "market": section.get("market", "KR"),
                "summary_html": section.get("summary_html", ""),
                "filings": filings,
            }
        )
    return result


def _important_sections(sections: list[dict]) -> list[dict]:
    result = []
    for section in sections:
        filings = [
            filing
            for filing in section["filings"]
            if any(keyword in str(filing.get("report_nm", "")) for keyword in IMPORTANT_KEYWORDS)
        ]
        if filings:
            result.append({**section, "filings": filings})
    return result


def publish(
    sections: list[dict],
    public_target_keys: set[tuple[str, str]],
    base_dir: Path | None = None,
    watchlist: list[str] | None = None,
) -> Path:
    """오늘의 브리핑을 JSON으로 저장하고 날짜 인덱스를 갱신한다.

    공시가 없는 날도 저장한다 → 대시보드에서 '오늘은 공시 없음'을 보여주기 위함.
    base_dir을 주면 docs/data 대신 그곳에 저장한다 (dry-run용 → git 충돌 방지).
    """
    data_dir = base_dir if base_dir is not None else DATA_DIR
    briefings_dir = data_dir / "briefings"
    briefings_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now().strftime("%Y-%m-%d")
    safe_sections = _public_sections(
        [
            section
            for section in sections
            if (section.get("market", "KR"), section.get("company", ""))
            in public_target_keys
        ]
    )
    payload = {
        "date": today,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sections": safe_sections,
        # Stock-Trading 08:30 브리핑이 참고용으로 읽는 안정적인 중요 공시 목록.
        # 자동 주문 조건으로 사용하지 않으며 원문 링크와 회사 단위 요약을 함께 제공한다.
        "important_sections": _important_sections(safe_sections),
    }
    out_file = briefings_dir / f"{today}.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 날짜 인덱스 갱신 (최신순) + 워치리스트 동봉
    # → 대시보드가 공시 0건인 종목도 목록에 표시할 수 있게 함
    dates = sorted((p.stem for p in briefings_dir.glob("*.json")), reverse=True)
    index_file = data_dir / "index.json"
    index_file.write_text(
        json.dumps({"dates": dates, "watchlist": watchlist or []}, ensure_ascii=False),
        encoding="utf-8",
    )

    return out_file
