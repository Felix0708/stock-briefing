"use client";

import { useState } from "react";
import { foreignTax, saleScenario, taxWon, TAX_YEAR } from "@/lib/foreign-tax";

function won(n: number) { return `${Math.round(n).toLocaleString("ko-KR")}원`; }

export function ForeignTaxPanel({ values, asOf, available }: {
  values: { market: "US" | "JP"; value: number | null }[]; asOf: string | null; available: boolean;
}) {
  const [us, setUs] = useState("");
  const [jp, setJp] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [basis, setBasis] = useState("");
  const [fees, setFees] = useState("");
  const [saleConfirmed, setSaleConfirmed] = useState(false);
  const usWon = taxWon(us), jpWon = taxWon(jp);
  const result = confirmed && usWon !== null && jpWon !== null ? foreignTax(usWon, jpWon) : null;
  const proceeds = available && values.length > 0 && values.every(row => row.value !== null && Number.isFinite(row.value) && row.value >= 0)
    ? values.reduce((sum,row) => sum + row.value!, 0) : null;
  const cost = taxWon(basis, false), expense = taxWon(fees, false);
  const scenario = result && saleConfirmed && cost !== null && expense !== null
    ? saleScenario(result.gain, proceeds, cost, expense) : null;
  return <section className="pf-card" aria-labelledby="foreign-tax-title">
    <h2 id="foreign-tax-title">미국·일본 주식 예상 세금 · {TAX_YEAR}년</h2>
    <p className="pf-muted">한국 세법 일반 과세 가정 · 실계좌 직접·자동 및 모든 증권사 합산. 위 계좌 필터와 무관하며 모의계좌·국내주식·배당은 제외합니다. 신고용 확정세액이 아닙니다.</p>
    <p className="pf-muted">증권사의 양도소득세 자료에서 비용과 세법상 환율이 반영된 원화 실현손익을 가져오세요. 현재 평단·환율로 계산한 평가손익이나 누적 자동매매 성과를 대신 넣지 마세요. 손실은 음수, 거래가 없었다면 0을 직접 입력합니다.</p>
    <div className="pf-trade-form">
      <label>미국 연간 실현손익 (원)<input inputMode="text" placeholder="예: 10000000" value={us} onChange={e=>setUs(e.target.value)} /></label>
      <label>일본 연간 실현손익 (원)<input inputMode="text" placeholder="예: -2000000" value={jp} onChange={e=>setJp(e.target.value)} /></label>
    </div>
    <label className="pf-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />미국·일본 모든 실계좌 손익을 포함했고 아래 일반 과세 조건에 해당합니다.</label>
    <p className="pf-muted">연간 250만 원 공제를 두 나라·모든 증권사에 한 번만 적용합니다. 국내 과세대상 주식/다른 국가 거래, 공제·감면(RIA 등), 외국납부세액, PTP 등 특수상품이 있거나 거주자 과세 여부가 불명확하면 이 계산을 사용하지 마세요.</p>
    {result ? <div className="pf-summary" aria-label="연간 예상 세금 결과" aria-live="polite">
      <div><span className="pf-muted">합산 실현손익</span><strong>{won(result.gain)}</strong></div>
      <div><span className="pf-muted">예상 양도세 · 지방소득세 포함</span><strong>{won(result.tax)}</strong><small>국세 {won(result.national)} + 지방세 {won(result.local)}</small></div>
      <div><span className="pf-muted">예상 세후 실현손익</span><strong>{won(result.net)}</strong></div>
    </div> : <p className="pf-muted" role="status">두 나라의 원화 손익과 적용 조건을 확인하면 계산됩니다. 빈칸·잘못된 입력은 0원으로 간주하지 않습니다. 원 단위 정수, 항목별 ±1조 원 이내.</p>}
    <details>
      <summary>등록된 해외주식을 지금 전량 매도한다면?</summary>
      <p className="pf-muted">모든 증권사의 등록된 실계좌 미국·일본 {values.length}개 보유 행만 대상입니다. 미등록 보유종목은 포함하지 않으며 중복 등록은 먼저 정리하세요. 시세·환율 기준 {asOf ? new Date(asOf).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"}) : "미확인"} (한국시간).</p>
      <p>가정 매도대금: {proceeds !== null ? won(proceeds) : "시세·환율 또는 보유종목 미확인 · 계산 보류"}</p>
      <div className="pf-trade-form">
        <label>대상 주식 세금용 취득가액·매수비용 합계 (원)<input inputMode="numeric" value={basis} onChange={e=>setBasis(e.target.value)} /></label>
        <label>예상 매도비용 합계 (원)<input inputMode="numeric" value={fees} onChange={e=>setFees(e.target.value)} /></label>
      </div>
      <label className="pf-check"><input type="checkbox" checked={saleConfirmed} onChange={e=>setSaleConfirmed(e.target.checked)} />취득가액은 위 대상 수량 전체와 일치하며 중복 등록이 없습니다.</label>
      {scenario ? <div className="pf-summary" aria-label="가정 매도 세후 결과" aria-live="polite">
        <div><span className="pf-muted">가정 매도손익 · 비용 반영</span><strong>{won(scenario.gain)}</strong></div>
        <div><span className="pf-muted">연간 예상 세금 증감</span><strong>{won(scenario.additionalTax)}</strong><small>매도 후 연간 세금 {won(scenario.annualTax)}</small></div>
        <div><span className="pf-muted">가정 매도 세후 손익</span><strong>{won(scenario.net)}</strong></div>
      </div> : <p className="pf-muted">연간 손익, 대상 취득가액·비용, 확인 항목 및 전체 시세가 필요합니다.</p>}
      <p className="pf-muted">연간 공제를 다시 빼지 않고 기존 예상 세금과의 차이만 반영합니다. 음수 세금 증감은 예상 연간 세금 감소이며 즉시 환급이 아닙니다. 실제 결제일 환율·체결가·비용에 따라 달라집니다. 주문은 실행하지 않습니다.</p>
    </details>
    <p className="pf-muted">입력은 이 화면에서만 계산되며 저장·전송되지 않습니다. 새로고침·로그아웃하면 초기화됩니다. 국내주식도 대주주·장외·비상장 등은 과세될 수 있습니다. 본 계산은 해당 예외가 없는 일반 미국·일본 주식만 지원합니다.</p>
    <p className="pf-muted">기준 확인 2026-09-18 · <a href="https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274" target="_blank" rel="noreferrer">국세청 과세·공제 안내</a> · <a href="https://file.shinhaninvest.com/filedoc/clause/k_3.pdf" target="_blank" rel="noreferrer">일반 세율·세금용 손익 안내</a></p>
  </section>;
}
