"use client";

import { useEffect, useRef, useState } from "react";
import { canConnect, chartValue, equityKey, equityMoney, EQUITY_METRICS, RETURN_REASONS, type EquityMetric, type EquityRecord } from "@/lib/account-equity";

const stamp = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

function TotalSummary({ latest }: { latest?: EquityRecord }) {
  const detail = latest?.breakdown;
  return <div className="pf-summary pf-equity-summary pf-equity-total">
    <div><span className="pf-muted">연결 계좌 묶음 총자산 · 현금 포함</span><strong>{latest ? equityMoney(latest.equity, "KRW") : "미수집"}</strong></div>
    <div><span className="pf-muted">국내주식 평가액 · 현금 제외</span><strong>{equityMoney(detail?.domestic_stock_value_krw ?? null, "KRW")}</strong></div>
    <div><span className="pf-muted">미국주식 평가액 · 현금 제외</span><strong>{equityMoney(detail?.us_stock_value_krw ?? null, "KRW")}</strong>
      {detail && <span className="pf-muted">{equityMoney(detail.us_stock_value_usd, "USD")}</span>}</div>
    <div><span className="pf-muted">현금 · 시장별 배분 없이 한 번만</span><strong>{equityMoney(detail?.cash_krw ?? latest?.cash ?? null, "KRW")}</strong></div>
  </div>;
}

export function AccountEquityEmpty({ message }: { message: string }) {
  return <div className="pf-equity" aria-label="선택 계좌 자산">
    <TotalSummary />
    <p role="status" className="pf-muted">{message}</p>
    <div className="pf-equity-chart"><h3>날짜별 변화</h3><p className="pf-muted">총자산·국내주식·미국주식 평가액 추이는 검증된 기록 수신 이후 표시됩니다. 미수집은 0원이 아닙니다.</p></div>
  </div>;
}

export function AccountEquityPanel({ latest, refresh }: { latest: EquityRecord; refresh: number }) {
  const [metric, setMetric] = useState<EquityMetric>("equity");
  const [period, setPeriod] = useState("1m");
  const [history, setHistory] = useState<EquityRecord[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedDate, setSelectedDate] = useState(latest.date);
  const [now] = useState(Date.now);
  const cutoff = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(now)) + "T00:00:00Z");
  const day = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - (period === "1m" ? 1 : 3));
  cutoff.setUTCDate(Math.min(day, new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate()));
  const from = period === "all" ? "" : cutoff.toISOString().slice(0, 10);
  const { account_ref, broker, account_type, currency, scope } = latest;
  const isTotal = scope === "account-total-assets";
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError(false); setHistory([]);
    void (async () => {
      try {
        const query = new URLSearchParams({ account_ref, broker, account_type, currency, scope });
        if (from) query.set("from", from);
        const points: EquityRecord[] = [];
        let before: string | null = null;
        do {
          if (before) query.set("before", before);
          const response = await fetch(`/api/account-equity?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]), cache: "no-store" });
          if (!response.ok) throw new Error("history unavailable");
          const data = await response.json() as { points: EquityRecord[]; next: string | null };
          if (!Array.isArray(data.points) || (data.next && before && data.next >= before)) throw new Error("invalid page");
          points.push(...data.points);
          before = data.next;
        } while (before);
        if (!controller.signal.aborted) setHistory(points.sort((a, b) => a.date.localeCompare(b.date)));
      } catch { if (!controller.signal.aborted) setError(true); }
      finally { if (!controller.signal.aborted) setBusy(false); }
    })();
    return () => controller.abort();
  }, [account_ref, broker, account_type, currency, scope, from, retry, refresh]);

  const selected = history.find(p => p.date === selectedDate) ?? history.at(-1);
  const known = history.filter(p => chartValue(p, metric) !== null);
  const display = (point: EquityRecord) => metric === "return"
    ? chartValue(point, "return") === null ? "미확인" : `${chartValue(point, "return")!.toFixed(2)}%`
    : equityMoney(metric === "domestic" ? point.breakdown?.domestic_stock_value_krw ?? null : metric === "us" ? point.breakdown?.us_stock_value_krw ?? null : point.equity, currency);
  return <div className="pf-equity" aria-label="선택 계좌 자산">
    <p className="pf-muted">{isTotal ? "연결 계좌 묶음 · 원화 총자산과 국내·미국 주식 상세" : scope === "domestic" ? "기존 기록 · 국내자산" : "기존 기록 · 해외자산 (미국)"} · {currency} 기준 · 모든 날짜는 한국시간</p>
    {isTotal ? <TotalSummary latest={latest} /> : <div className="pf-summary pf-equity-summary">
      <div><span className="pf-muted">{scope === "domestic" ? "국내 총자산" : scope === "overseas" ? "해외 총자산" : "계좌 총자산"} · 현금 포함</span><strong>{equityMoney(latest.equity, currency)}</strong></div>
      <div><span className="pf-muted">{broker === "KIWOOM" ? "현금 (결제예정 반영)" : "현금"}</span><strong>{equityMoney(latest.cash, currency)}</strong></div>
      <div><span className="pf-muted">보유주식 평가액</span><strong>{equityMoney(latest.stock_value, currency)}</strong></div>
    </div>}
    {isTotal && !latest.breakdown && <p role="status" className="pf-muted">상세 미확인 · 검증된 국내·미국 분해값이 없습니다. 총자산에서 역산하거나 0으로 채우지 않습니다.</p>}
    <p className="pf-muted">마지막 수집 {stamp(latest.collected_at)}</p>
    <details><summary className="pf-muted">수집·금액 기준</summary>
      <p className="pf-muted">서버 수신 {stamp(latest.received_at)} · 계산 {stamp(latest.calculated_at)}<br />
        {latest.valued_at ? `증권사 평가 시각 ${stamp(latest.valued_at)}` : "증권사 평가 시각 미제공 · 수집 시각과 같다고 가정하지 않습니다."}</p>
      {latest.source === "KIWOOM_US_EQUITY" && currency === "USD" && scope === "overseas" && <p className="pf-muted">미국주식·USD · 결제예정 반영. 현금은 결제예정 예수금을 포함하며 출금가능금액과 다릅니다.</p>}
      {latest.source === "KIWOOM_KR_EQUITY" && <p className="pf-muted">국내주식·KRW 추정예탁자산입니다. 현금은 D+2 추정예수금으로, 주식 평가액과의 합계가 보고 총자산에 맞는 경우만 표시합니다. 즉시 출금가능금액이 아닙니다. 해외 USD 자산과 합산하거나 해외 이력에 연결하지 않습니다.</p>}
      {latest.source === "KIS_ACCOUNT_EQUITY" && <p className="pf-muted">국내·해외를 포함한 증권사 계좌 전체 평가값입니다. 국내 자산을 별도로 더하지 않습니다.</p>}
      {latest.source === "KIWOOM_ACCOUNT_EQUITY" && <p className="pf-muted">실행기에 명시 연결된 국내·미국 계좌 묶음입니다. 같은 물리계좌라는 뜻이 아닙니다. 송신 측에서 현금 중복·적용 환율·합계를 검증한 원화 총액만 수신하며 기존 국내·해외 이력과 이어 붙이지 않습니다.</p>}
      {latest.breakdown && <p className="pf-muted">상세 관측 {stamp(latest.breakdown.observed_at)} · 적용 환율 {equityMoney(latest.breakdown.usd_krw_rate, "KRW")}/USD ({latest.breakdown.fx_source === "KIWOOM_USD_SELL" ? "키움 USD 매도 기준" : "한투 USD 최초 기준"})<br />
        현금 범위: {latest.breakdown.cash_scope === "separate-accounts" ? "별도 연결 계좌의 현금 합계" : latest.breakdown.cash_scope === "same-account" ? "동일 계좌의 중복 현금 제외" : "계좌 공통 현금"}. 시장별 현금을 임의로 나누지 않으며 즉시 출금가능금액과 다를 수 있습니다. 과거 값은 당시 적용 환율을 유지합니다.</p>}
      {(latest.cash === null || latest.stock_value === null) && <p className="pf-muted">미확인 항목은 0원이 아닙니다. 총자산에서 역산하지 않습니다.</p>}
    </details>
    {now - Date.parse(latest.collected_at) > 48 * 3600_000 && <p className="pf-notice">48시간 이상 지난 마지막 확인값입니다. 휴장·컴퓨터 종료·수집 일정 등을 확인해 주세요.</p>}
    <p className="pf-muted">마지막 수신값 기준입니다. 수집·전송 실패 여부는 Stock-Trading에서 확인해 주세요. 이 화면의 새로고침은 증권사 수집을 실행하지 않습니다.</p>
    <div className="pf-equity-chart">
      <h3>날짜별 변화</h3>
      <div className="pf-equity-switches">
        <div role="group" aria-label="그래프 종류">{(["equity", ...(isTotal ? ["domestic", "us"] : []), "return"] as EquityMetric[]).map(value =>
          <button className="pf-ghost" type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{EQUITY_METRICS[value]}</button>)}</div>
        <div role="group" aria-label="그래프 기간">{[['1m','1개월'],['3m','3개월'],['all','전체 기간']].map(([value,label]) =>
          <button className="pf-ghost" type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
      </div>
      <p className="pf-muted">{metric === "equity" ? "현금 포함 자산 금액 · 입출금의 영향이 포함됩니다." : metric === "return" ? "입출금 영향을 조정한 일별 표본 누적 수익률 · 기간을 바꿔도 기준을 0%로 재설정하지 않습니다." : "주식 평가액 추이 · 현금 제외 · 수익률이 아닙니다. 매매·시세·미국주식의 환율 변동이 반영됩니다."}</p>
      {busy ? <p role="status" className="pf-equity-empty pf-muted">자산 이력 불러오는 중…</p> : error ?
        <p role="alert" className="pf-error">이력을 불러오지 못했습니다. <button type="button" className="pf-ghost" onClick={() => setRetry(n => n + 1)}>이력 다시 조회</button></p> : <>
          {known.length ? <EquityChart points={history} metric={metric} selected={selected} onSelect={setSelectedDate} />
            : <p role="status" className="pf-equity-empty pf-muted">{history.length === 0 ? "선택 기간에 수집된 기록이 없습니다." : metric === "return" ? RETURN_REASONS[(selected ?? latest).return_status] : metric === "equity" ? "이 기간의 총자산 금액을 확인하지 못했습니다." : "상세 미확인 · 이 기간의 검증된 주식 평가액이 없습니다."}</p>}
          {known.length === 1 && <p className="pf-muted">확인된 값이 한 점입니다. 기록이 더 쌓이면 추이를 볼 수 있습니다.</p>}
          {history.length > 0 && <div className="pf-equity-inspect">
            <div className="pf-filters"><label>날짜별 값<select aria-label="날짜별 값" value={selected?.date} onChange={e => setSelectedDate(e.target.value)}>
              {history.map(point => <option key={point.date} value={point.date}>{point.date}</option>)}
            </select></label></div>
            {selected && <p role="status"><strong>{selected.date} · {display(selected)}</strong><br />
              <span className="pf-muted">{metric === "domestic" || metric === "us" ? "현금 제외 주식 평가액 · 수익률 아님" : RETURN_REASONS[selected.return_status]}{metric === "return" && selected.return_base_at ? ` · 기준 ${stamp(selected.return_base_at)}` : ""}</span></p>}
          </div>}
        </>}
      <p className="pf-muted">하루의 마지막 수집값이며 종가·실시간 시세가 아닙니다. 미수집 날짜와 확인되지 않은 수익률 구간은 선을 연결하지 않습니다.</p>
    </div>
  </div>;
}

function EquityChart({ points, metric, selected, onSelect }: { points: EquityRecord[]; metric: EquityMetric; selected?: EquityRecord; onSelect: (date: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(220, entries[0].contentRect.width)));
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const values = points.map(p => chartValue(p, metric)).filter((v): v is number => v !== null);
  const min = Math.min(...values), max = Math.max(...values), pad = (max - min) * .12 || Math.max(Math.abs(max) * .02, 1);
  const low = min - pad, high = max + pad, left = 62, right = width - 20;
  const start = Date.parse(points[0].date), end = Date.parse(points.at(-1)!.date);
  const x = (p: EquityRecord) => start === end ? (left + right) / 2 : left + (Date.parse(p.date) - start) / (end - start) * (right - left);
  const y = (v: number) => 24 + (high - v) / (high - low) * 170;
  const compact = (v: number) => new Intl.NumberFormat("ko-KR", { notation: "compact", maximumFractionDigits: 2 }).format(v) + (metric === "return" ? "%" : "");
  const segments = points.map((point, i) => {
    const value = chartValue(point, metric);
    return value === null ? "" : `${i > 0 && canConnect(points[i - 1], point, metric) ? "L" : "M"}${x(point)},${y(value)}`;
  }).join(" ");
  return <div ref={host}>
    <svg className="pf-equity-svg" viewBox={`0 0 ${width} 240`} role="img" aria-label={`${EQUITY_METRICS[metric]} 날짜별 추이. 아래 날짜별 값에서 정확한 수치를 확인할 수 있습니다.`}
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        const target = (event.clientX - rect.left) / rect.width * width;
        const closest = points.reduce((a, b) => Math.abs(x(a) - target) < Math.abs(x(b) - target) ? a : b);
        onSelect(closest.date);
      }}>
      <text x={left} y={14}>{metric === "return" ? "수익률 (%)" : points[0].currency}</text>
      {[low, (low + high) / 2, high].map(v => <g key={v}><line x1={left} y1={y(v)} x2={right} y2={y(v)} /><text x={left - 8} y={y(v) + 4} textAnchor="end">{compact(v)}</text></g>)}
      <path d={segments} />
      {points.map(p => chartValue(p, metric) === null ? null : <circle key={`${equityKey(p)}:${p.date}`} cx={x(p)} cy={y(chartValue(p, metric)!)} r={p.date === selected?.date ? 5 : 3} />)}
      {selected && chartValue(selected, metric) !== null && <line className="pf-equity-marker" x1={x(selected)} y1={24} x2={x(selected)} y2={194} />}
      <text x={left} y={225}>{points[0].date}</text>
      {points.length > 1 && <text x={right} y={225} textAnchor="end">{points.at(-1)!.date}</text>}
    </svg>
  </div>;
}
