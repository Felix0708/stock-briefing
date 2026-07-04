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

DATA_DIR = Path(__file__).resolve().parent.parent / "docs" / "data"


def publish(sections: list[dict]) -> Path:
    """오늘의 브리핑을 JSON으로 저장하고 날짜 인덱스를 갱신한다.

    공시가 없는 날도 저장한다 → 대시보드에서 '오늘은 공시 없음'을 보여주기 위함.
    """
    briefings_dir = DATA_DIR / "briefings"
    briefings_dir.mkdir(parents=True, exist_ok=True)

    today = datetime.now().strftime("%Y-%m-%d")
    payload = {
        "date": today,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "sections": sections,
    }
    out_file = briefings_dir / f"{today}.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # 날짜 인덱스 갱신 (최신순)
    dates = sorted((p.stem for p in briefings_dir.glob("*.json")), reverse=True)
    index_file = DATA_DIR / "index.json"
    index_file.write_text(json.dumps({"dates": dates}, ensure_ascii=False), encoding="utf-8")

    return out_file
