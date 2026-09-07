"""공시 수집 → 요약 → 개인/공개 브리핑. 실패와 공시 0건을 별도로 기록한다."""
import argparse
import html
import sys
from pathlib import Path
from dataclasses import replace

from . import dart, edgar, edinet, emailer, embed, holdings, notify, publish, status, summarize, recovery
from .config import load_settings

def collect_target(settings, target, corp_codes, cik_map, index_only=False, dry_run=False):
    company, market = target["name"], target["market"]
    result = {"company": company, "market": market, "stock_code": target["code"],
              "status": "failed", "filing_count": 0, "checked_at": status.timestamp()}
    try:
        if market == "US":
            cik = cik_map.get(target["code"].upper())
            if not cik:
                print("⚠ SEC 티커 매핑 없음 (종목명 생략)")
                return None, result
            filings = edgar.fetch_filings(target["code"], cik, settings.lookback_days)
        elif market == "JP":
            if not settings.edinet_api_key:
                result["status"] = "unsupported"
                return None, result
            filings = edinet.fetch_filings(target["code"], settings.lookback_days, settings.edinet_api_key)
        else:
            corp_code = corp_codes.get(company)
            if not corp_code:
                return None, result
            filings = dart.fetch_filings(settings.dart_api_key, corp_code, settings.lookback_days)
    except Exception as error:
        http_status = getattr(getattr(error, "response", None), "status_code", None)
        print(f"⚠ 공시 목록 조회 실패: {type(error).__name__} · HTTP {http_status or '해당 없음'} (오류 본문 생략)")
        return None, result

    result["filing_count"] = len(filings)
    if not filings:
        result.update(status="empty", last_success_at=result["checked_at"])
        return None, result
    result["status"] = "success"
    summaries = []
    for filing in filings:
        durable = settings.rag_enabled and not dry_run and not index_only
        cached = recovery.cached(settings,market,filing["rcept_no"]) if durable else None
        if cached:
            summaries.append(cached["summary_html"])
            continue
        ready = True
        try:
            if market == "US":
                text = edgar.fetch_document_text(filing, settings.doc_max_chars)
            elif market == "JP":
                text = edinet.fetch_document_text(filing, settings.doc_max_chars, settings.edinet_api_key)
            else:
                text = dart.fetch_document_text(settings.dart_api_key, filing["rcept_no"], settings.doc_max_chars)
            if not text:
                ready = False
        except Exception:
            text = ""
            ready = False
        filing.pop("_doc_url", None)
        summary_html = ""
        if not index_only:
            try:
                summary_html = summarize.summarize_company(settings.gemini_api_key, settings.gemini_model, company, [filing], {filing["rcept_no"]:text})
            except Exception:
                ready = False
                summary_html = f"<ul><li>{html.escape(filing['report_nm'])}</li></ul><p>AI 요약 생성 실패 · 재처리 대기</p>"
            summaries.append(summary_html)
        if settings.rag_enabled and not dry_run and text:
            try:
                embed.index_filing(settings, company, filing, text)
            except Exception:
                ready = False
        if durable:
            recovery.save_item(settings,target,filing,text,summary_html,ready)
        if not ready:
            result["status"] = "partial"
    section = {"company":company,"market":market,"summary_html":"".join(summaries),"filings":filings} if not index_only else None
    if result["status"] == "success":
        result["last_success_at"] = result["checked_at"]
    return section, result


def run(dry_run=False, companies=None, index_only=False, lookback=None):
    settings = load_settings()
    if index_only:
        settings.send_email = False
    if lookback:
        settings.lookback_days = lookback
    settings.validate()
    record = not dry_run and not index_only
    if record:
        status.record_run(settings, "running")
    try:
        _run(settings, dry_run, companies, index_only, record)
    except Exception:
        if record:
            status.record_run(settings, "failed")
        raise


def _run(settings, dry_run, companies, index_only, record):
    names = companies if companies is not None else settings.watchlist
    targets = [{"name": name, "market": "KR", "code": ""} for name in names]
    public_keys = {("KR", name) for name in names}
    incomplete = False
    if companies is None:
        try:
            known = {(target["market"], target["name"]) for target in targets}
            for row in holdings.fetch_market_targets(settings):
                key = (row["market"], row["name"])
                if key not in known:
                    known.add(key)
                    targets.append(row)
        except Exception:
            incomplete = True
            print("⚠ 보유 종목 조회 실패 · watchlist만 수집")
        try:
            public_keys.update((row["market"], row["name"]) for row in holdings.fetch_public_market_targets(settings))
        except Exception:
            incomplete = True
            print("⚠ 공개 동의 조회 실패 · watchlist만 공개")
    print(f"수집 대상 {len(targets)}개 (종목명·회원 정보 생략)")
    corp_codes = {}
    if any(target["market"] == "KR" for target in targets):
        try:
            corp_codes = dart.load_corp_codes(settings.dart_api_key)
        except Exception:
            incomplete = True
            print("⚠ DART 기업 목록 조회 실패")
    cik_map = {}
    if any(target["market"] == "US" for target in targets):
        try:
            cik_map = edgar.load_ticker_ciks([target["code"] for target in targets if target["market"] == "US"])
        except Exception:
            incomplete = True
            print("⚠ SEC 기업 목록 조회 실패")
    sections, results = [], []
    for index, target in enumerate(targets):
        try:
            target_settings = settings
            if not index_only and not dry_run:
                target_settings = replace(settings,lookback_days=recovery.lookback(settings,target))
            section, result = collect_target(target_settings, target, corp_codes, cik_map, index_only, dry_run)
        except Exception:
            section=None
            result={"company":target["name"],"market":target["market"],"stock_code":target["code"],"status":"failed","filing_count":0,"checked_at":status.timestamp()}
            print("⚠ 수집 결과 저장/복구 실패 · 다른 대상은 계속 처리")
        results.append(result)
        if section:
            sections.append(section)
        if result["status"] not in ("success", "empty"):
            incomplete = True
        print(f"대상 {index+1}/{len(targets)} · {result['status']} · 공시 {result['filing_count']}건")
        if not dry_run:
            if not status.save(settings, "collection_status", result, "market,company"):
                incomplete = True
    if index_only:
        print("인덱싱 전용 모드 완료" if not incomplete else "인덱싱 전용 모드 일부 실패 · 개인 상태 화면 확인")
        return
    out = publish.publish(sections, public_keys, base_dir=Path(".preview") if dry_run else None,
                          watchlist=settings.watchlist, collection_results=results)
    print(f"대시보드 데이터 저장: {out}")
    personalized_sent = set()
    if not dry_run and settings.rag_enabled:
        try:
            personalized_sent = notify.send_personalized(settings, sections, results)
        except Exception:
            incomplete = True
            print("⚠ 회원 알림 처리 실패 (수신자·외부 응답 생략)")
    if settings.send_email and (sections or settings.send_empty_briefing or settings.rag_enabled) and settings.mail_to.strip().lower() not in personalized_sent:
        extra = "일부 종목의 수집이 완료되지 않아 공시 유무를 확인할 수 없습니다." if incomplete else None
        message = emailer.build_html(sections, extra_note=extra)
        if dry_run:
            Path("briefing_preview.html").write_text(message, encoding="utf-8")
            print("dry-run: briefing_preview.html 저장")
        else:
            if settings.rag_enabled:
                items=recovery.ready_items(settings)
                for recipient in settings.mail_to.split(","):
                    if recipient.strip() and recipient.strip().lower() not in personalized_sent:
                        state,_=notify.send_batch(settings,recipient.strip(),None,items,extra_note=extra)
                        if state not in ('sent','already_sent'): incomplete=True
            else:
                emailer.send(settings.smtp_host, settings.smtp_port, settings.smtp_user, settings.smtp_password, settings.mail_to, message)
            print("관리자 브리핑 발송 대기열 처리 완료")
    if record:
        status.record_run(settings, "partial" if incomplete else "success")
    print("완료 · 일부 처리 실패 있음" if incomplete else "완료")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="메일 대신 HTML 저장")
    parser.add_argument("--companies", help="쉼표로 구분한 수집 대상")
    parser.add_argument("--index-only", action="store_true", help="요약·메일 없이 인덱싱만")
    parser.add_argument("--lookback", type=int, help="조회 기간(일)")
    args = parser.parse_args()
    try:
        run(dry_run=args.dry_run, companies=[c.strip() for c in args.companies.split(",") if c.strip()] if args.companies else None,
            index_only=args.index_only, lookback=args.lookback)
    except Exception as error:
        print(f"파이프라인 실패: {type(error).__name__} (민감한 오류 본문 생략)", file=sys.stderr)
        sys.exit(1)
