import io
import unittest
import zipfile
from datetime import datetime,timezone,timedelta
from unittest.mock import patch,MagicMock
from pipeline import recovery,notify,emailer,edgar,edinet,documents,summarize,dart
from pipeline.config import Settings


class RecoveryTest(unittest.TestCase):
    def settings(self):
        return Settings(supabase_url="https://test.invalid",supabase_secret_key="test",smtp_host="smtp.gmail.com",smtp_user="sender",smtp_password="test")

    def test_gap_is_recovered_without_fixed_day_cap(self):
        previous=(datetime.now(timezone.utc)-timedelta(days=150)).isoformat()
        with patch.object(recovery,"rest",return_value=[{"last_success_at":previous}]):
            self.assertGreaterEqual(recovery.lookback(self.settings(),{"market":"US","name":"Test"}),152)

    def test_unknown_delivery_is_reconciled_without_resending(self):
        batch={"id":"00000000-0000-4000-8000-000000000001","state":"uncertain","attempted_at":"2020-01-01T00:00:00Z","items":[{}]}
        with patch.object(recovery,"prepare",return_value=batch),patch.object(emailer,"was_sent",return_value=True),patch.object(emailer,"send") as send,patch.object(recovery,"finish") as finish:
            self.assertEqual(notify.send_batch(self.settings(),"test@example.com",None,[]),("sent",1))
        send.assert_not_called()
        finish.assert_called_once_with(self.settings(),batch["id"],"sent")

    def test_verification_failure_never_permits_blind_resend(self):
        batch={"id":"00000000-0000-4000-8000-000000000001","state":"uncertain","attempted_at":"2020-01-01T00:00:00Z","items":[]}
        with patch.object(recovery,"prepare",return_value=batch),patch.object(emailer,"was_sent",side_effect=RuntimeError()),patch.object(emailer,"send") as send:
            with self.assertRaises(RuntimeError): notify.send_batch(self.settings(),"test@example.com",None,[])
        send.assert_not_called()

    def test_empty_batch_is_not_resent(self):
        with patch.object(recovery,"prepare",return_value=None),patch.object(emailer,"send") as send:
            self.assertEqual(notify.send_batch(self.settings(),"test@example.com",None,[]),("already_sent",0))
        send.assert_not_called()

    def test_imap_only_searches_exact_app_id_and_never_fetches_content(self):
        client=MagicMock()
        client.list.return_value=("OK",[b'(\\HasNoChildren \\Sent) "/" "Sent"'])
        client.select.return_value=("OK",[b'1'])
        client.uid.return_value=("OK",[b'17'])
        message_id="<stock-briefing.00000000-0000-4000-8000-000000000001@stock-briefing.local>"
        with patch.object(emailer.imaplib,"IMAP4_SSL") as imap:
            imap.return_value.__enter__.return_value=client
            self.assertTrue(emailer.was_sent("sender","test",message_id))
        client.fetch.assert_not_called()
        client.uid.assert_called_once_with("search",None,"HEADER","Message-ID",f'"{message_id}"')
        client.select.assert_called_once_with(b'"Sent"',readonly=True)

    def test_japanese_failure_and_error_payload_are_not_empty(self):
        with patch.object(edinet,"_get",side_effect=RuntimeError()):
            with self.assertRaises(RuntimeError):edinet.fetch_filings("7203",1,"test")
        response=MagicMock();response.json.return_value={"metadata":{"status":"401"},"results":[]}
        with patch.object(edinet,"_get",return_value=response):
            with self.assertRaises(ValueError):edinet.fetch_filings("7203",1,"test")

    def test_japanese_inline_xbrl_is_read_without_extracting_paths(self):
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,"w") as archive:
            archive.writestr("XBRL/PublicDoc/report.htm","<p>営業利益 123 億円</p>")
            archive.writestr("../../ignored.txt","not read")
        self.assertIn("営業利益 123 億円",documents.extract_text(stream.getvalue()))

    def test_missing_body_does_not_call_ai(self):
        with patch.object(summarize.genai,"Client") as client:
            result=summarize.summarize_company("test","test","Test",[{"rcept_no":"1","report_nm":"공시"}],{})
        client.assert_not_called()
        self.assertIn("요약을 보류",result)

    def test_sec_exhibits_are_included_but_external_links_are_not_fetched(self):
        base="https://www.sec.gov/Archives/edgar/data/123/456/"
        main=MagicMock();main.text='<p>Cover</p><a href="ex99.htm">Exhibit</a><a href="https://evil.invalid/a.htm">ignored</a><a href="../private.htm">ignored</a>'
        main.content=main.text.encode()
        exhibit=MagicMock();exhibit.content=b'<p>Revenue $123 million</p>'
        with patch.object(edgar,"_get",side_effect=[main,exhibit]) as get:
            result=edgar.fetch_document_text({"_doc_url":base+"main.htm"},8000)
        self.assertIn("Revenue $123 million",result)
        self.assertEqual([c.args[0] for c in get.call_args_list],[base+"main.htm",base+"ex99.htm"])

    def test_dart_follows_all_pages(self):
        response=MagicMock()
        response.json.side_effect=[{"status":"000","total_page":2,"list":[{"rcept_no":"1"}]},{"status":"000","total_page":2,"list":[{"rcept_no":"2"}]}]
        with patch.object(dart,"_get",return_value=response):self.assertEqual(len(dart.fetch_filings("test","1",180)),2)

    def test_only_one_worker_can_recover_an_old_uncertain_batch(self):
        batch={"id":"00000000-0000-4000-8000-000000000001","state":"uncertain","attempted_at":"2020-01-01T00:00:00Z","items":[]}
        with patch.object(recovery,'prepare',return_value=batch),patch.object(emailer,'was_sent',return_value=False),patch.object(recovery,'rest',return_value=False),patch.object(emailer,'send') as send:
            self.assertEqual(notify.send_batch(self.settings(),'test@example.com',None,[]),('uncertain',0))
        send.assert_not_called()

    def test_successful_send_has_stable_id_and_collection_warning(self):
        batch={"id":"00000000-0000-4000-8000-000000000001","state":"prepared","items":[{"market":"US","company":"Test","summary_html":"<p>Fact</p>","filing":{"report_nm":"Report","url":"https://www.sec.gov/"}}]}
        with patch.object(recovery,'prepare',return_value=batch),patch.object(emailer,'was_sent',return_value=False),patch.object(recovery,'start',return_value=True),patch.object(recovery,'finish'),patch.object(emailer,'send') as send:
            self.assertEqual(notify.send_batch(self.settings(),'test@example.com',None,[],extra_note='일부 수집 실패'),('sent',1))
        self.assertIn('일부 수집 실패',send.call_args.args[5])
        self.assertIn(batch['id'],send.call_args.kwargs['message_id'])

    def test_summary_output_has_no_active_attributes_or_external_links(self):
        safe=documents.SummaryHTML()
        safe.feed('<p onclick="steal()">Fact<img src="https://evil.invalid"><a href="javascript:steal()">text</a></p>')
        self.assertEqual(''.join(safe.parts),'<p>Facttext</p>')

    def test_sec_redirect_cannot_send_contact_to_another_host(self):
        response=MagicMock();response.status_code=302;response.headers={'Location':'https://evil.invalid/doc'}
        with patch.object(edgar.requests,'get',return_value=response) as get:
            with self.assertRaises(ValueError):edgar._get('https://www.sec.gov/doc')
        self.assertEqual(get.call_count,1)


if __name__=="__main__":unittest.main()
