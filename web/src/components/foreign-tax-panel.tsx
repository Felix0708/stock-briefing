"use client";

import { useEffect, useState } from "react";
import { foreignTax, recordedTax, saleScenario, taxWon, TAX_YEAR, type RecordedTaxRow } from "@/lib/foreign-tax";

function won(n: number) { return `${Math.round(n).toLocaleString("ko-KR")}원`; }

export function ForeignTaxPanel({ values, asOf, available, usdKrw, jpyKrw, liveBrokers }: {
  values: { market: "US" | "JP"; value: number | null; cost: number | null }[]; asOf: string | null; available: boolean;
  usdKrw:number|null; jpyKrw:number|null; liveBrokers:string[];
}) {
  const [rows,setRows]=useState<RecordedTaxRow[]|null>(null);
  const [error,setError]=useState(false);
  const [retry,setRetry]=useState(0);
  const [manual,setManual]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();setRows(null);setError(false);
    void (async()=>{
      try {
        const response=await fetch("/api/tax-estimate",{cache:"no-store",signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
        if(!response.ok) throw Error();
        const data=await response.json();
        if(data.year!==TAX_YEAR||!Array.isArray(data.rows)||!recordedTax(data.rows,1,1)) throw Error();
        if(!controller.signal.aborted) setRows(data.rows);
      } catch {if(!controller.signal.aborted)setError(true);}
    })();
    return ()=>controller.abort();
  },[asOf,retry]);
  const [us, setUs] = useState("");
  const [jp, setJp] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [basis, setBasis] = useState("");
  const [fees, setFees] = useState("");
  const [saleConfirmed, setSaleConfirmed] = useState(false);
  const usWon = taxWon(us), jpWon = taxWon(jp);
  const recorded=rows?recordedTax(rows,usdKrw,jpyKrw):null;
  const unlinked=liveBrokers.filter(broker=>!rows?.some(row=>row.source==="stock_trading"&&row.broker===broker&&row.market==="US"));
  const result = manual ? confirmed && usWon !== null && jpWon !== null ? foreignTax(usWon, jpWon) : null
    : available && unlinked.length===0 ? recorded?.result??null : null;
  const proceeds = available && values.length > 0 && values.every(row => row.value !== null && Number.isFinite(row.value) && row.value >= 0)
    ? values.reduce((sum,row) => sum + row.value!, 0) : null;
  const cost = manual ? taxWon(basis, false) : values.length&&values.every(row=>row.cost!==null&&Number.isFinite(row.cost)&&row.cost>=0)
    ? Math.round(values.reduce((sum,row)=>sum+row.cost!,0)) : null;
  const expense = manual ? taxWon(fees, false) : 0;
  const scenario = result && (!manual||saleConfirmed) && cost !== null && expense !== null
    ? saleScenario(result.gain, proceeds, cost, expense) : null;
  return <section className="pf-card pf-tax" aria-labelledby="foreign-tax-title">
    <h2 id="foreign-tax-title">미국·일본 주식 예상 세금 · {TAX_YEAR}년</h2>
    <p className="pf-muted">한국 세법 일반 과세 가정 · 실계좌 직접·자동 및 모든 증권사 합산. 위 계좌 필터와 무관하며 모의계좌·국내주식·배당은 제외합니다. 신고용 확정세액이 아닙니다.</p>
    <p className="pf-notice">{manual ? "직접 보정 모드 · 입력한 세금용 원화 손익 기준" : "실계좌 매매 기록 자동 계산 · 기록된 매도만 · 현재 환율 환산·비용 전 참고 추정"}<br />보유 중 평가이익은 연간 실현손익에 넣지 않습니다. 기록 밖 거래·이전 보유 원가·결제일 환율·수수료 차이 때문에 실제 신고세액과 다를 수 있습니다. 매도일 기준 연도 집계로 연말 결제일 차이도 반영하지 못합니다. 자동매매로 기록된 거래를 직접 매매 이력에 중복 입력하지 마세요.</p>
    {!manual && <>
      {error ? <p role="alert">매도 기록 조회 실패 · 0원으로 계산하지 않습니다. <button type="button" className="pf-ghost" onClick={()=>setRetry(n=>n+1)}>매도 기록 다시 조회</button></p>
        : rows===null ? <p role="status">실계좌 매도 기록을 불러오는 중…</p>
        : <p className="pf-muted">기록된 매도 {recorded?.count??0}건{recorded?.missing ? ` · 원가·체결시각 등 미확인 ${recorded.missing}건으로 계산 보류` : ""}. 기록이 없는 것은 실제 거래가 없었다는 확인이 아닙니다.
          {unlinked.length>0&&" 자동매매 실계좌의 연간 매도 집계가 아직 수신되지 않아 합산 계산을 보류합니다."}
          {rows.filter(row=>row.source==="stock_trading").map(row=><span key={`${row.broker}:${row.market}`}><br />{row.broker} {row.market} 실계좌 집계 {new Date(row.updated_at).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"})} 기준</span>)}</p>}
    </>}
    <details><summary>증권사 자료로 직접 보정하기 (선택)</summary>
    <label className="pf-check"><input type="checkbox" checked={manual} onChange={e=>setManual(e.target.checked)} />자동 추정 대신 직접 입력 사용</label>
    {manual && <>
    <p className="pf-muted">증권사의 양도소득세 자료에서 비용과 세법상 환율이 반영된 원화 실현손익을 가져오세요. 현재 평단·환율로 계산한 평가손익이나 누적 자동매매 성과를 대신 넣지 마세요. 손실은 음수, 거래가 없었다면 0을 직접 입력합니다.</p>
    <div className="pf-trade-form">
      <label>미국 연간 실현손익 (원)<input inputMode="text" placeholder="예: 10000000" value={us} onChange={e=>setUs(e.target.value)} /></label>
      <label>일본 연간 실현손익 (원)<input inputMode="text" placeholder="예: -2000000" value={jp} onChange={e=>setJp(e.target.value)} /></label>
    </div>
    <label className="pf-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />미국·일본 모든 실계좌 손익을 포함했고 아래 일반 과세 조건에 해당합니다.</label>
    </>}
    </details>
    <p className="pf-muted">연간 250만 원 공제를 두 나라·모든 증권사에 한 번만 적용합니다. 국내 과세대상 주식/다른 국가 거래, 공제·감면(RIA 등), 외국납부세액, PTP 등 특수상품이 있거나 거주자 과세 여부가 불명확하면 이 계산을 사용하지 마세요.</p>
    {result ? <div className="pf-summary" aria-label="연간 예상 세금 결과" aria-live="polite">
      <div><span className="pf-muted">{manual?"합산 실현손익":"기록된 실현손익 · 현재 환율·비용 전"}</span><strong>{won(result.gain)}</strong></div>
      <div><span className="pf-muted">{manual?"예상 양도세 · 지방소득세 포함":"기록 기준 예상 양도세 · 참고용"}</span><strong>{won(result.tax)}</strong><small>국세 {won(result.national)} + 지방세 {won(result.local)}</small></div>
      <div><span className="pf-muted">{manual?"예상 세후 실현손익":"세금 차감 추정 손익 · 비용 제외"}</span><strong>{won(result.net)}</strong></div>
    </div> : <p className="pf-muted" role="status">{manual?"두 나라의 원화 손익과 적용 조건을 확인하면 계산됩니다. 빈칸·잘못된 입력은 0원으로 간주하지 않습니다. 원 단위 정수, 항목별 ±1조 원 이내.":"매도 기록·원가·환율 확인 후 자동 계산됩니다. 미확인 자료는 0원으로 채우지 않습니다."}</p>}
    <details>
      <summary>등록된 해외주식을 지금 전량 매도한다면?</summary>
      <p className="pf-muted">모든 증권사의 등록된 실계좌 미국·일본 {values.length}개 보유 행만 대상입니다. 미등록 보유종목은 포함하지 않으며 중복 등록은 먼저 정리하세요. 시세·환율 기준 {asOf ? new Date(asOf).toLocaleString("ko-KR",{timeZone:"Asia/Seoul"}) : "미확인"} (한국시간).</p>
      <p>가정 매도대금: {proceeds !== null ? won(proceeds) : "시세·환율 또는 보유종목 미확인 · 계산 보류"}</p>
      {!manual && <p className="pf-muted">등록 평단×수량의 현재 환율 환산액 {cost===null?"미확인":won(cost)}을 사용한 가정입니다. 매수·매도 비용과 과거 환율효과는 제외하며 세금용 취득가액이 아닙니다.</p>}
      {manual && <><div className="pf-trade-form">
        <label>대상 주식 세금용 취득가액·매수비용 합계 (원)<input inputMode="numeric" value={basis} onChange={e=>setBasis(e.target.value)} /></label>
        <label>예상 매도비용 합계 (원)<input inputMode="numeric" value={fees} onChange={e=>setFees(e.target.value)} /></label>
      </div>
      <label className="pf-check"><input type="checkbox" checked={saleConfirmed} onChange={e=>setSaleConfirmed(e.target.checked)} />취득가액은 위 대상 수량 전체와 일치하며 중복 등록이 없습니다.</label>
      </>}
      {scenario ? <div className="pf-summary" aria-label="가정 매도 세후 결과" aria-live="polite">
        <div><span className="pf-muted">가정 매도손익 · {manual?"비용 반영":"현재 환율·비용 제외"}</span><strong>{won(scenario.gain)}</strong></div>
        <div><span className="pf-muted">연간 예상 세금 증감</span><strong>{won(scenario.additionalTax)}</strong><small>매도 후 연간 세금 {won(scenario.annualTax)}</small></div>
        <div><span className="pf-muted">가정 매도 세후 손익</span><strong>{won(scenario.net)}</strong></div>
      </div> : <p className="pf-muted">연간 손익, 대상 취득가액·비용, 확인 항목 및 전체 시세가 필요합니다.</p>}
      <p className="pf-muted">연간 공제를 다시 빼지 않고 기존 예상 세금과의 차이만 반영합니다. 음수 세금 증감은 예상 연간 세금 감소이며 즉시 환급이 아닙니다. 실제 결제일 환율·체결가·비용에 따라 달라집니다. 주문은 실행하지 않습니다.</p>
    </details>
    <p className="pf-muted">입력은 이 화면에서만 계산되며 저장·전송되지 않습니다. 새로고침·로그아웃하면 초기화됩니다. 국내주식도 대주주·장외·비상장 등은 과세될 수 있습니다. 본 계산은 해당 예외가 없는 일반 미국·일본 주식만 지원합니다.</p>
    <p className="pf-muted">기준 확인 2026-09-18 · <a href="https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=8800&mi=12274" target="_blank" rel="noreferrer">국세청 과세·공제 안내</a> · <a href="https://file.shinhaninvest.com/filedoc/clause/k_3.pdf" target="_blank" rel="noreferrer">일반 세율·세금용 손익 안내</a></p>
  </section>;
}
