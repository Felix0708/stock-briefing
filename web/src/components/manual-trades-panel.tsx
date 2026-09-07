"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { brokerLabel, MANUAL_BROKER_OPTIONS, type HoldingBroker } from "@/lib/holding-brokers";

type Position = { stock_code: string; stock_name: string; market: "KR" | "US" | "JP"; broker: HoldingBroker; quantity: number };
type Trade = Position & { id: number; request_id: string; side: "BUY" | "SELL"; price: number; realized_profit_loss: number | null; traded_on: string; quantity_after: number; revision: number; cancelled: boolean; original_input: Omit<Trade,"original_input"> };
type Revision = {id: number; previous: Trade; updated: {result: Trade}; reason: string; created_at: string};
type Summary = { broker: HoldingBroker; market: Position["market"]; sell_count: number; profit_loss: number; cost_basis: number };
function currency(market: Position["market"]) { return market === "US" ? "USD" : market === "JP" ? "JPY" : "KRW"; }
function money(amount: number, market: Position["market"]) {
  return new Intl.NumberFormat("ko-KR", { style: "currency", currency: currency(market), maximumFractionDigits: market === "US" ? 2 : 0 }).format(amount);
}

export function ManualTradesPanel({ holdings, onChanged, disabled = false }: { holdings: Position[]; onChanged: () => Promise<void>; disabled?: boolean }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [summary, setSummary] = useState<Summary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [preset, setPreset] = useState("");
  const [market, setMarket] = useState<Position["market"]>("KR");
  const [broker, setBroker] = useState<HoldingBroker>("KIWOOM");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [side, setSide] = useState("BUY");
  const [quantity, setQuantity] = useState("");
  const [price, setPrice] = useState("");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [readError, setReadError] = useState("");
  const [editing, setEditing] = useState<Trade | null>(null);
  const [reason, setReason] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [audit, setAudit] = useState<{id:number; rows:Revision[]; next:number|null} | null>(null);
  const formDetails = useRef<HTMLDetailsElement>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const load = useCallback(async (before?: number) => {
    try {
      const response = await fetch(`/api/manual-trades${before ? `?before=${before}` : ""}`);
      if (!response.ok) throw new Error();
      const data = await response.json();
      setTrades((current) => before ? [...current, ...data.trades] : data.trades);
      setSummary(data.summary);
      setNext(data.next);
      setReadError("");
    } catch { setReadError("매매 이력을 불러오지 못했습니다. 다시 조회해 주세요."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const choose = (value: string) => {
    setPreset(value);
    const holding = holdings.find((item) => `${item.broker}:${item.market}:${item.stock_code}` === value);
    if (holding) { setMarket(holding.market); setBroker(holding.broker); setCode(holding.stock_code); setName(holding.stock_name); }
    else { setCode(""); setName(""); }
  };
  function edit(trade: Trade) {
    setEditing(trade); setReason(""); setCancelled(trade.cancelled); setPreset("");
    setMarket(trade.market); setBroker(trade.broker); setCode(trade.stock_code); setName(trade.stock_name);
    setSide(trade.side); setQuantity(String(trade.quantity)); setPrice(String(trade.price)); setDate(trade.traded_on);
    setError(""); setMessage(""); pending.current=null;
    if (formDetails.current) { formDetails.current.open=true; formDetails.current.scrollIntoView({block:"nearest"}); }
  }
  async function history(tradeId:number, before?:number) {
    try {
      const response=await fetch(`/api/manual-trades?trade_id=${tradeId}${before ? `&before=${before}` : ""}`);
      if (!response.ok) throw new Error();
      const data=await response.json();
      setAudit(current=>({id:tradeId,rows:before && current?.id===tradeId ? [...current.rows,...data.revisions] : data.revisions,next:data.next}));
    } catch { setError("정정 이력을 불러오지 못했습니다."); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    const payload = { market, broker, stock_code: code.trim().toUpperCase(), stock_name: name.trim(), side, quantity: Number(quantity), price: Number(price), traded_on: date };
    const change = editing ? {trade_id:editing.id,expected_revision:editing.revision,trade:payload,cancelled,reason:reason.trim()} : payload;
    const key = JSON.stringify(change);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError(""); setMessage("");
    try {
      const response = await fetch("/api/manual-trades", { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...change, request_id: pending.current.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "거래를 기록하지 못했습니다.");
      pending.current = null;
      setMessage(editing ? "정정 완료 · 이후 매매와 현재 잔고를 다시 계산했습니다. 원래 입력과 정정 사유는 보존됩니다." : `${side === "BUY" ? "매수" : "매도"} 기록 완료 · 거래 직후 수량 ${data.trade.quantity_after}${data.trade.realized_profit_loss !== null ? ` · 실현손익 ${money(data.trade.realized_profit_loss, market)}` : ""}`);
      setQuantity(""); setPrice(""); setPreset("");
      setEditing(null); setReason(""); setCancelled(false); setAudit(null);
      await Promise.all([load(), onChanged()]);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "처리 결과를 확인하지 못했습니다. 같은 입력으로 재시도해 주세요."); }
    finally { setBusy(false); }
  }
  return <section className="pf-card" aria-labelledby="manual-trades-title">
    <h2 id="manual-trades-title">직접 투자 · 매매 이력</h2>
    <p className="pf-muted">실제 체결한 매수·매도를 기록하면 직접 등록 잔고와 평단이 함께 갱신됩니다. 증권사에 주문을 보내는 기능은 아닙니다.</p>
    <details ref={formDetails}>
      <summary>{editing ? "기존 거래 정정하기" : "매수·매도 기록하기"}</summary>
      <form className="pf-trade-form" onSubmit={(event) => void submit(event)}>
        <label>기존 보유 종목<select aria-label="기존 보유 종목" value={preset} onChange={(event) => choose(event.target.value)}><option value="">새 종목 / 직접 입력</option>
          {holdings.map((item) => <option key={`${item.broker}:${item.market}:${item.stock_code}`} value={`${item.broker}:${item.market}:${item.stock_code}`}>{brokerLabel(item.broker)} · {item.stock_name} ({item.stock_code})</option>)}
        </select></label>
        <label>거래 구분<select aria-label="거래 구분" value={side} onChange={(event) => setSide(event.target.value)}><option value="BUY">매수</option><option value="SELL">매도</option></select></label>
        <label>거래 증권사<select aria-label="거래 증권사" value={broker} onChange={(event) => setBroker(event.target.value as HoldingBroker)}><option value="MANUAL">증권사 미지정</option>{MANUAL_BROKER_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label>거래 시장<select aria-label="거래 시장" value={market} onChange={(event) => setMarket(event.target.value as Position["market"])}><option value="KR">국내</option><option value="US">미국</option><option value="JP">일본</option></select></label>
        <label>거래 종목코드<input required maxLength={10} value={code} onChange={(event) => setCode(event.target.value)} /></label>
        <label>거래 종목명<input required maxLength={50} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label>체결 수량<input required type="number" min="0.0001" step="0.0001" value={quantity} onChange={(event) => setQuantity(event.target.value)} /></label>
        <label>체결 단가 ({currency(market)})<input required type="number" min="0.00000001" step="any" value={price} onChange={(event) => setPrice(event.target.value)} /></label>
        <label>거래일<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} max={new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" })} /></label>
        {editing && <>
          <label>정정 사유<input required maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} /></label>
          <label className="pf-check"><input type="checkbox" checked={cancelled} onChange={event=>setCancelled(event.target.checked)} />이 거래 취소 (삭제하지 않고 이력 보존)</label>
        </>}
        <button type="submit" className="pf-primary" disabled={busy || disabled}>{busy ? "기록 중…" : editing ? "정정 저장" : "거래 기록"}</button>
        {editing && <button type="button" className="pf-ghost" disabled={busy} onClick={()=>{setEditing(null);setReason("");setCancelled(false);setQuantity("");setPrice("");}}>정정 그만두기</button>}
      </form>
      <p className="pf-muted">기능 적용 당시 잔고를 시작점으로 거래일 순서(같은 날은 입력 순서)로 계산합니다. 정정하면 이후 거래도 다시 계산하며, 별도로 직접 보정한 잔고는 그 시점의 기준으로 유지됩니다. 시작점에 이미 포함된 과거 매수는 중복 입력하지 마세요. 수수료·세금·환율효과는 제외됩니다.</p>
    </details>
    {error && <p className="pf-error" role="alert">{error}</p>}
    {message && <p className="pf-notice" role="status">{message}</p>}
    {readError && <p className="pf-error" role="status">{readError} <button type="button" className="pf-ghost" onClick={() => void load()}>이력 다시 조회</button></p>}
    <div className="pf-performance-grid">{summary.map((item) => <article className="pf-performance-card" key={`${item.broker}:${item.market}`}>
      <h3>{brokerLabel(item.broker)} · {currency(item.market)} 실현손익</h3>
      <p className={item.profit_loss > 0 ? "pf-gain" : item.profit_loss < 0 ? "pf-loss" : ""}>{money(item.profit_loss, item.market)}</p>
      <p className="pf-muted">매도 {item.sell_count}건 · {item.cost_basis > 0 ? `수익률 ${(item.profit_loss / item.cost_basis * 100).toFixed(2)}%` : "수익률 —"}</p>
    </article>)}</div>
    {!trades.length && !readError && <p className="pf-muted">아직 기록한 거래가 없습니다. 기존 보유 종목의 과거 거래는 소급 생성하지 않습니다.</p>}
    <ol className="pf-history">{trades.map((trade) => <li key={trade.id}>
      <strong>{trade.cancelled ? "취소됨 · " : ""}{trade.side === "BUY" ? "매수" : "매도"} · {trade.stock_name} ({trade.stock_code})</strong>
      <span>{trade.traded_on} · {brokerLabel(trade.broker)}</span>
      <span>{trade.quantity}주 × {money(trade.price, trade.market)}{!trade.cancelled ? ` · 거래 직후 잔고 ${trade.quantity_after}주` : " · 잔고·성과 계산에서 제외"}</span>
      {!trade.cancelled && trade.realized_profit_loss !== null && <span>실현손익 {money(trade.realized_profit_loss, trade.market)}</span>}
      <div><button type="button" className="pf-ghost" disabled={busy || disabled} onClick={()=>edit(trade)}>정정 / 취소</button>{trade.revision>1 && <button type="button" className="pf-ghost" onClick={()=>void history(trade.id)}>정정 이력 ({trade.revision-1})</button>}</div>
      {audit?.id===trade.id && <div>
        {trade.original_input && <p>최초 입력: {trade.original_input.traded_on} · {brokerLabel(trade.original_input.broker)} · {trade.original_input.stock_code} · {trade.original_input.side === "BUY" ? "매수" : "매도"} {trade.original_input.quantity}주 × {money(trade.original_input.price,trade.original_input.market)}</p>}
        <ol>{audit.rows.map(row=><li key={row.id}><strong>{new Date(row.created_at).toLocaleString("ko-KR")} · {row.reason}</strong><span>{row.updated.result.cancelled ? "거래 취소" : "거래 정정"} · {row.updated.result.traded_on} · {brokerLabel(row.updated.result.broker)} · {row.updated.result.stock_code} · {row.updated.result.side === "BUY" ? "매수" : "매도"} {row.updated.result.quantity}주 × {money(row.updated.result.price,row.updated.result.market)}</span></li>)}</ol>
        {audit.next && <button type="button" className="pf-ghost" onClick={()=>void history(trade.id,audit.next!)}>정정 이력 더 보기</button>}
      </div>}
    </li>)}</ol>
    {next && <button type="button" className="pf-ghost" onClick={() => void load(next)}>이전 거래 더 보기</button>}
  </section>;
}
