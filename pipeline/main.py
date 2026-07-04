"""파이프라인 오케스트레이터.

흐름: watchlist → DART 공시 수집 → 원문 다운로드 → Gemini 요약 → 메일 발송

실행:
    python -m pipeline.main            # 실제 발송
    python -m pipeline.main --dry-run  # 메일 대신 HTML 파일로 저장 (테스트용)
"""

import argparse
import sys
from pathlib import Path

from . import dart, emailer, embed, publish, summarize
from .config import load_settings


def run(dry_run: bool = False) -> None:
    settings = load_settings()
    settings.validate()

    print(f"[1/4] 기업 코드 로드 중... (watchlist: {settings.watchlist})")
    corp_codes = dart.load_corp_codes(settings.dart_api_key)

    sections = []
    for company in settings.watchlist:
        corp_code = corp_codes.get(company)
        if not corp_code:
            print(f"  ⚠ '{company}' 를 DART 상장사 목록에서 찾지 못함 (정확한 법인명인지 확인)")
            continue

        print(f"[2/4] {company}: 최근 {settings.lookback_days}일 공시 조회...")
        filings = dart.fetch_filings(settings.dart_api_key, corp_code, settings.lookback_days)
        if not filings:
            print(f"  - 신규 공시 없음")
            continue
        print(f"  - {len(filings)}건 발견")

        doc_texts = {
            f["rcept_no"]: dart.fetch_document_text(
                settings.dart_api_key, f["rcept_no"], settings.doc_max_chars
            )
            for f in filings
        }

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

    # 웹 대시보드용 JSON 저장 (공시 없는 날도 기록)
    # dry-run은 배포 대상(docs/data)을 건드리지 않고 .preview/에 저장
    # → 로컬 테스트가 git 충돌을 만들지 않도록 분리
    if dry_run:
        out_json = publish.publish(sections, base_dir=Path(".preview"), watchlist=settings.watchlist)
    else:
        out_json = publish.publish(sections, watchlist=settings.watchlist)
    print(f"[4/4] 웹 대시보드 데이터 저장: {out_json}")

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
    args = parser.parse_args()
    try:
        run(dry_run=args.dry_run)
    except Exception as e:
        print(f"실패: {e}", file=sys.stderr)
        sys.exit(1)
