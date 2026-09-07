from datetime import datetime
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch

from pipeline import edgar


class FakeResponse:
    def __init__(self, *, payload=None, content=b"", text=""):
        self.payload = payload
        self.content = content
        self.text = text

    def json(self):
        return self.payload


class EdgarForm4Test(unittest.TestCase):
    def test_styled_form4_uses_raw_xml_and_rejects_non_ownership_documents(self):
        response=FakeResponse(content=b"<ownershipDocument><transactionCode>P</transactionCode></ownershipDocument>")
        with patch.object(edgar,"_get",return_value=response) as fetch:
            codes=edgar._form4_open_market_codes("https://www.sec.gov/Archives/edgar/data/123/456/xslF345X03/ownership.xml")
        self.assertEqual(codes,{"P"})
        fetch.assert_called_once_with("https://www.sec.gov/Archives/edgar/data/123/456/ownership.xml")
        with patch.object(edgar,"_get",return_value=FakeResponse(content=b"<html></html>")):
            with self.assertRaises(ValueError):
                edgar._form4_open_market_codes("https://www.sec.gov/Archives/edgar/data/123/456/ownership.xml")

    def test_missing_adr_uses_official_fallback_without_overriding_primary(self):
        def get(url, timeout=30):
            if url.endswith("company_tickers.json"):
                return FakeResponse(payload={"0":{"ticker":"DELL","cik_str":1571996}})
            return FakeResponse(text="se\t1703399\ndell\t999\nmalformed\n")
        with tempfile.TemporaryDirectory() as directory, patch.object(edgar,"CACHE_DIR",Path(directory)), patch.object(edgar,"_get",side_effect=get) as fetch:
            mapping=edgar.load_ticker_ciks(["SE","DELL"])
            self.assertEqual(mapping["SE"],1703399)
            self.assertEqual(mapping["DELL"],1571996)
            edgar.load_ticker_ciks(["SE"])
            self.assertEqual(fetch.call_count,2)

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
