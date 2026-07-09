import type { Metadata } from "next";
import Link from "next/link";

import { PortfolioPanel } from "@/components/portfolio-panel";

export const metadata: Metadata = {
  title: "내 포트폴리오 | Stock Briefing",
  description: "보유 종목을 등록하고 실시간 수익률과 비중을 확인하세요.",
};

export default function PortfolioPage() {
  return (
    <main className="page-shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="Stock Briefing 홈">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M4 17.5 9 12l3.2 3.2L20 7.5" />
              <path d="M15.5 7.5H20V12" />
            </svg>
          </span>
          <span>Stock Briefing</span>
        </Link>
        <nav className="pf-nav">
          <Link href="/">공시 검색</Link>
          <span className="service-badge">내 포트폴리오</span>
        </nav>
      </header>

      <section className="hero" aria-labelledby="pf-page-title">
        <div className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          실시간 시세 기반
        </div>
        <h1 id="pf-page-title">내 포트폴리오</h1>
        <p>
          보유 종목과 평균 단가를 등록하면
          <br className="desktop-break" /> 현재가 기준 수익률과 종목별 비중을 보여드립니다.
        </p>
      </section>

      <PortfolioPanel />

      <footer className="site-footer">
        <p>시세는 네이버 증권 기준이며 지연될 수 있습니다. 투자 판단의 참고용입니다.</p>
        <p>데이터 출처: 금융감독원 DART · 네이버 증권</p>
      </footer>
    </main>
  );
}
