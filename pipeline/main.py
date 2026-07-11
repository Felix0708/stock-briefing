"""파이프라인 오케스트레이터.

흐름: watchlist → DART 공시 수집 → 원문 다운로드 → Gemini 요약 → 메일 발송

실행:
    python -m pipeline.main            # 실제 발송
    python -m pipeline.main --dry-run  # 메일 대신 HTML 파일로 저장 (테스트용)
"""

import argparse
import sys
from pathlib import Path

from . import dart, edgar, emailer, embed, holdings, notify, publish, summarize
from .config import load_settings

# 온디맨드(--index-only) 수집 시 종목당 인덱싱할 최대 공시 수 (임베딩 예산 보호)
INDEX_ONLY_MAX_FILINGS = 15


def run(
    dry_run: bool = False,
    companies: list[str] | None = None,
    index_only: bool = False,
    lookback: int | None = None,
) -> None:
    settings = load_settings()
    if index_only:
        settings.send_email = False  # 인덱싱 전용 모드는 메일·SMTP 설정 불필요
    if lookback:
        settings.lookback_days = lookback
    settings.validate()

    # 수집 대상 결정:
    # --companies 지정 시 그 목록만 (온디맨드 수집용)
    # 아니면 watchlist + 사용자 보유 종목(Phase 3 개인화) 병합
    # 수집 대상: {"name", "market", "code"} — 시장별로 공시 소스가 다르다 (KR→DART, US→EDGAR)
    if companies:
        targets = [{"name": c, "market": "KR", "code": ""} for c in companies]
    else:
        targets = [{"name": c, "market": "KR", "code": ""} for c in settings.watchlist]
        try:
            known = {t["name"] for t in targets}
            extras = []
            for row in holdings.fetch_market_targets(settings):
                if row["market"] == "JP":
                    continue  # 일본 공시(EDINET)는 아직 미지원 — 시세만 제공
                if row["name"] not in known:
                    known.add(row["name"])
                    targets.append(row)
                    extras.append(f"{row['name']}({row['market']})")
            if extras:
                print(f"보유 종목 추가 수집 대상: {extras}")
        except Exception as e:
            print(f"⚠ 보유 종목 조회 실패 (watchlist만 사용): {e}")

    if not targets:
        print("수집 대상이 없습니다 (watchlist 비어 있음 + 등록된 보유 종목 없음). 정상 종료.")
        return

    print(f"[1/4] 기업 코드 로드 중... (대상: {[t['name'] for t in targets]})")
    corp_codes = (
        dart.load_corp_codes(settings.dart_api_key)
        if any(t["market"] == "KR" for t in targets)
        else {}
    )
    cik_map: dict[str, int] = {}
    if any(t["market"] == "US" for t in targets):
        try:
            cik_map = edgar.load_ticker_ciks()
        except Exception as e:
            # EDGAR 실패가 국내 수집까지 죽이면 안 된다 — 미국 종목만 건너뛴다
            print(f"⚠ SEC 티커 목록 로드 실패 (미국 종목 건너뜀): {e}")

    sections = []
    for target in targets:
        company = target["name"]
        market = target["market"]

        if market == "US":
            ticker = target["code"].upper()
            cik = cik_map.get(ticker)
            if not cik:
                print(f"  ⚠ '{company}'({ticker}) 를 SEC 티커 목록에서 찾지 못함")
                continue
            print(f"[2/4] {company}: 최근 {settings.lookback_days}일 SEC 공시 조회...")
            try:
                filings = edgar.fetch_filings(ticker, cik, settings.lookback_days)
            except Exception as e:
                print(f"  ⚠ {company} SEC 조회 실패 (건너뜀): {e}")
                continue
        else:
            corp_code = corp_codes.get(company)
            if not corp_code:
                print(f"  ⚠ '{company}' 를 DART 상장사 목록에서 찾지 못함 (정확한 법인명인지 확인)")
                continue
            print(f"[2/4] {company}: 최근 {settings.lookback_days}일 공시 조회...")
            try:
                filings = dart.fetch_filings(settings.dart_api_key, corp_code, settings.lookback_days)
            except Exception as e:
                print(f"  ⚠ {company} DART 조회 실패 (건너뜀): {e}")
                continue

        if not filings:
            print(f"  - 신규 공시 없음")
            continue
        print(f"  - {len(filings)}건 발견")
        if index_only and len(filings) > INDEX_ONLY_MAX_FILINGS:
            filings = filings[:INDEX_ONLY_MAX_FILINGS]
            print(f"  - 인덱싱 전용 모드: 최근 {INDEX_ONLY_MAX_FILINGS}건으로 제한")

        if market == "US":
            doc_texts = {
                f["rcept_no"]: edgar.fetch_document_text(f, settings.doc_max_chars)
                for f in filings
            }
            for f in filings:
                f.pop("_doc_url", None)  # 내부용 키는 저장 데이터에서 제외
        else:
            doc_texts = {
                f["rcept_no"]: dart.fetch_document_text(
                    settings.dart_api_key, f["rcept_no"], settings.doc_max_chars
                )
                for f in filings
            }

        if index_only:
            # 온디맨드 수집: 요약·브리핑 없이 RAG 인덱싱만 수행
            for f in filings:
                try:
                    n = embed.index_filing(settings, company, f, doc_texts.get(f["rcept_no"], ""))
                    if n:
                        print(f"  - RAG 인덱싱: {f['report_nm']} ({n} 청크)")
                except Exception as e:
                    print(f"  ⚠ RAG 인덱싱 실패 ({f['report_nm']}): {e}")
            continue

        print(f"[3/4] {company}: Gemini 요약 생성...")
        # 종목 단위 격리: 한 종목의 요약 실패가 전체 브리핑을 죽이지 않게 한다.
        # 실패한 종목은 요약 대신 공시 목록만 표시 (링크는 살아있으므로 정보 가치 유지)
        try:
            summary_html = summarize.summarize_company(
                settings.gemini_api_key, settings.gemini_model, company, filings, doc_texts
            )
        except Exception as e:
            print(f"  ⚠ {company} 요약 실패 (공시 목록만 표시): {e}")
            summary_html = (
                "<ul>"
                + "".join(f"<li>{f['report_nm']} ({f['rcept_dt']})</li>" for f in filings)
                + "</ul><p><i>AI 요약 생성에 실패해 목록만 표시합니다.</i></p>"
            )
        sections.append({"company": company, "summary_html": summary_html, "filings": filings})

        # Phase 2: RAG용 임베딩 저장 (Supabase 설정이 있을 때만, dry-run 제외)
        # 실패해도 브리핑 자체는 계속되도록 개별 공시 단위로 예외 처리
        if settings.rag_enabled and not dry_run:
            for f in filings:
                try:
                    n = embed.index_filing(settings, company, f, doc_texts.get(f["rcept_no"], ""))
                    if n:
                        print(f"  - RAG 인덱싱: {f['report_nm']} ({n} 청크)")
                except Exception as e:
                    print(f"  ⚠ RAG 인덱싱 실패 ({f['report_nm']}): {e}")

    if index_only:
        print("인덱싱 전용 모드 완료 ✅ (브리핑·메일·대시보드 생략)")
        return

    # 웹 대시보드용 JSON 저장 (공시 없는 날도 기록)
    # dry-run은 배포 대상(docs/data)을 건드리지 않고 .preview/에 저장
    # → 로컬 테스트가 git 충돌을 만들지 않도록 분리
    if dry_run:
        out_json = publish.publish(sections, base_dir=Path(".preview"), watchlist=settings.watchlist)
    else:
        out_json = publish.publish(sections, watchlist=settings.watchlist)
    print(f"[4/4] 웹 대시보드 데이터 저장: {out_json}")

    # Phase 3 알림: 수신 동의 회원에게 보유 종목 공시만 맞춤 발송
    # (관리자 메일과 독립적으로 동작. 실패해도 브리핑은 계속)
    if not dry_run and sections and settings.rag_enabled and settings.smtp_user and settings.smtp_password:
        try:
            notify.send_personalized(settings, sections)
        except Exception as e:
            print(f"⚠ 회원 알림 발송 실패: {e}")

    if not settings.send_email:
        print("SEND_EMAIL=false → 메일 발송 생략 (웹 대시보드로 확인)")
        return
    if not sections and not settings.send_empty_briefing:
        print("신규 공시 없음 → 메일 발송 생략 (SEND_EMPTY_BRIEFING=true로 바꾸면 발송)")
        return

    html = emailer.build_html(sections)

    if dry_run:
        out = Path("briefing_preview.html")
        out.write_text(html, encoding="utf-8")
        print(f"dry-run: {out} 에 저장 완료. 브라우저로 열어서 확인하세요.")
        return

    print(f"메일 발송 → {settings.mail_to}")
    emailer.send(
        settings.smtp_host,
        settings.smtp_port,
        settings.smtp_user,
        settings.smtp_password,
        settings.mail_to,
        html,
    )
    print("완료 ✅")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="메일 대신 HTML 파일로 저장")
    parser.add_argument("--companies", help="쉼표로 구분한 수집 대상 (watchlist 대신 사용)")
    parser.add_argument("--index-only", action="store_true", help="요약·메일 없이 RAG 인덱싱만")
    parser.add_argument("--lookback", type=int, help="조회 기간(일) 재정의")
    args = parser.parse_args()
    company_list = [c.strip() for c in args.companies.split(",") if c.strip()] if args.companies else None
    try:
        run(
            dry_run=args.dry_run,
            companies=company_list,
            index_only=args.index_only,
            lookback=args.lookback,
        )
    except Exception as e:
        print(f"실패: {e}", file=sys.stderr)
        sys.exit(1)
