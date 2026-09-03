from datetime import datetime
import unittest
from unittest.mock import patch

from pipeline import edgar


class FakeResponse:
    def __init__(self, *, payload=None, content=b""):
        self.payload = payload
        self.content = content

    def json(self):
        return self.payload


class EdgarForm4Test(unittest.TestCase):
    def test_only_open_market_form4_transactions_are_collected(self):
        today = datetime.now().strftime("%Y-%m-%d")
        recent = {
            "form": ["4", "4", "4/A", "8-K"],
            "filingDate": [today] * 4,
            "accessionNumber": ["1-1", "1-2", "1-3", "1-4"],
            "primaryDocument": ["buy.xml", "award.xml", "sell.xml", "event.htm"],
            "primaryDocDescription": ["FORM 4", "FORM 4", "FORM 4/A", "FORM 8-K"],
        }

        documents = {
            "buy.xml": b"<ownershipDocument><transactionCode>P</transactionCode></ownershipDocument>",
            "award.xml": b"<ownershipDocument><transactionCode>A</transactionCode></ownershipDocument>",
            "sell.xml": b"<ownershipDocument><transactionCode>S</transactionCode></ownershipDocument>",
        }

        def fake_get(url, timeout=30):
            del timeout
            if "/submissions/" in url:
                return FakeResponse(payload={"filings": {"recent": recent}})
            return FakeResponse(content=documents[url.rsplit("/", 1)[-1]])

        with patch("pipeline.edgar._get", side_effect=fake_get):
            filings = edgar.fetch_filings("TEST", 123, 1)

        self.assertEqual(
            [filing["report_nm"] for filing in filings],
            ["내부자 매수 (Form 4)", "내부자 매도 (Form 4/A)", "수시보고 (8-K)"],
        )


if __name__ == "__main__":
    unittest.main()
