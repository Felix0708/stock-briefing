import json
import tempfile
import unittest
from pathlib import Path

from pipeline.holdings import dedupe_market_targets
from pipeline.publish import publish


class PublicBriefingPrivacyTest(unittest.TestCase):
    def test_opt_in_filter_is_anonymous_and_private_targets_remain_available(self):
        rows = [
            {"user_id": "opted", "stock_name": "삼성전자", "stock_code": "005930", "market": "KR"},
            {"user_id": "opted", "stock_name": "삼성전자", "stock_code": "005930", "market": "KR"},
            {"user_id": "private", "stock_name": "현대차", "stock_code": "005380", "market": "KR"},
        ]

        self.assertEqual(
            dedupe_market_targets(rows, {"opted"}),
            [{"name": "삼성전자", "market": "KR", "code": "005930"}],
        )
        self.assertEqual(len(dedupe_market_targets(rows)), 2)

    def test_public_json_allowlist_and_important_links(self):
        sections = [{
            "company": "삼성전자",
            "market": "KR",
            "summary_html": "<p>중요 요약</p>",
            "user_id": "must-not-leak",
            "quantity": 10,
            "avg_price": 50000,
            "account_type": "live",
            "filings": [{
                "report_nm": "유상증자결정",
                "rcept_no": "1",
                "rcept_dt": "20260902",
                "url": "https://dart.fss.or.kr/example",
                "user_name": "must-not-leak",
            }],
        }]

        with tempfile.TemporaryDirectory() as directory:
            path = publish(sections, {("KR", "삼성전자")}, base_dir=Path(directory))
            payload = json.loads(path.read_text(encoding="utf-8"))

        serialized = json.dumps(payload, ensure_ascii=False)
        for forbidden in ("user_id", "user_name", "quantity", "avg_price", "account_type", "must-not-leak"):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(payload["important_sections"][0]["filings"][0]["url"], "https://dart.fss.or.kr/example")
        self.assertEqual(payload["important_sections"][0]["summary_html"], "<p>중요 요약</p>")

    def test_non_opt_in_section_is_not_written(self):
        sections = [
            {"company": "공개", "market": "KR", "summary_html": "public", "filings": []},
            {"company": "비공개", "market": "KR", "summary_html": "private", "filings": []},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = publish(sections, {("KR", "공개")}, base_dir=Path(directory))
            payload = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual([row["company"] for row in payload["sections"]], ["공개"])
        self.assertNotIn("private", json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    unittest.main()
