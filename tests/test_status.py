import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from pipeline import main, notify, publish, status
from pipeline.config import Settings


class BriefingStatusTest(unittest.TestCase):
    def test_failed_lookup_is_not_empty_and_does_not_log_private_values(self):
        settings = Settings(send_email=False)
        output = io.StringIO()
        with patch.object(main.edgar, "fetch_filings", side_effect=RuntimeError("private@example.com SECRET")), contextlib.redirect_stdout(output):
            section, result = main.collect_target(settings, {"name":"비공개종목", "market":"US", "code":"PRIVATE"}, {}, {"PRIVATE":1})
        self.assertIsNone(section)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("last_success_at", result)
        self.assertNotIn("PRIVATE", output.getvalue())
        self.assertNotIn("private@example.com", output.getvalue())
        with patch.object(main.edgar, "fetch_filings", return_value=[]):
            _, empty = main.collect_target(settings, {"name":"비공개종목", "market":"US", "code":"PRIVATE"}, {}, {"PRIVATE":1})
        self.assertEqual(empty["status"], "empty")
        self.assertIn("last_success_at", empty)

    def test_personal_mail_separates_failed_and_empty_and_logs_no_email(self):
        settings = Settings(smtp_user="sender", smtp_password="password", send_email=True)
        sections = [{"company":"정상", "summary_html":"summary", "filings":[{"url":"https://example.com", "report_nm":"공시"}]}]
        subscribers = [{"id":"owner", "email":"private@example.com"}]
        output = io.StringIO()
        with patch.object(notify.holdings, "fetch_subscribers", return_value=subscribers), \
             patch.object(notify.holdings, "fetch_holdings_by_user", return_value={"owner":["정상","정상","없음","실패"]}), \
             patch.object(notify.emailer, "build_html", return_value="HTML") as html, \
             patch.object(notify.emailer, "send"), patch.object(status, "delivery") as record, contextlib.redirect_stdout(output):
            notify.send_personalized(settings, sections, [{"company":"없음","status":"empty"},{"company":"실패","status":"failed"}])
        self.assertEqual(len(html.call_args.args[0]),1)
        note = html.call_args.kwargs["extra_note"]
        self.assertIn("조회 완료 · 신규 공시 없음: 없음",note)
        self.assertIn("수집 미완료 · 공시 유무 확인 불가: 실패",note)
        self.assertNotIn("private@example.com",output.getvalue())
        record.assert_called_once_with(settings,"owner","sent",1)

    def test_no_content_failure_does_not_become_no_filings(self):
        settings=Settings(send_email=True)
        with patch.object(notify.holdings,"fetch_subscribers",return_value=[{"id":"owner","email":"private@example.com"}]), \
             patch.object(notify.holdings,"fetch_holdings_by_user",return_value={"owner":["실패"]}), \
             patch.object(status,"delivery") as record, patch.object(notify.emailer,"send") as send:
            notify.send_personalized(settings,[],[{"company":"실패","status":"failed"}])
        record.assert_called_once_with(settings,"owner","collection_failed")
        send.assert_not_called()

    def test_public_status_excludes_private_targets(self):
        rows=[{"company":name,"market":"US","status":"failed","filing_count":0,"checked_at":"2026-09-07T00:00:00Z","stock_code":"PRIVATE"} for name in ["공개","비공개"]]
        with tempfile.TemporaryDirectory() as directory:
            path=publish.publish([],{("US","공개")},base_dir=Path(directory),collection_results=rows)
            value=json.loads(path.read_text())
        self.assertEqual([row["company"] for row in value["collection_status"]],["공개"])
        self.assertNotIn("PRIVATE",json.dumps(value))

    def test_failed_status_does_not_erase_previous_success_timestamp(self):
        with patch.object(status,"save") as save:
            status.record_run(Settings(),"failed")
        self.assertNotIn("last_success_at",save.call_args.args[2])


if __name__=="__main__":
    unittest.main()
