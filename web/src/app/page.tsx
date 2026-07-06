import { AskPanel } from "@/components/ask-panel";

export default function Home() {
  return (
    <main className="page-shell">
      <header className="site-header">
        <a className="brand" href="/" aria-label="Stock Briefing 홈">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M4 17.5 9 12l3.2 3.2L20 7.5" />
              <path d="M15.5 7.5H20V12" />
            </svg>
          </span>
          <span>Stock Briefing</span>
        </a>
        <span className="service-badge">공시 AI 검색</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <div className="eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          DART 공시 기반 답변
        </div>
        <h1 id="page-title">
          궁금한 공시를
          <br />
          질문해 보세요
        </h1>
        <p>
          어려운 공시 원문을 직접 찾지 않아도 됩니다.
          <br className="desktop-break" /> AI가 관련 내용을 찾아 근거와 함께 정리합니다.
        </p>
      </section>

      <AskPanel />

      <footer className="site-footer">
        <p>AI 답변은 오류가 있을 수 있으니 투자 판단 전 원문을 확인해 주세요.</p>
        <p>데이터 출처: 금융감독원 DART · 답변: Gemini</p>
      </footer>
    </main>
  );
}
