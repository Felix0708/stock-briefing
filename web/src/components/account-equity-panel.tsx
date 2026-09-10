"use client";

import { useEffect, useRef, useState } from "react";
import { canConnect, chartValue, equityKey, equityMoney, RETURN_REASONS, type EquityRecord } from "@/lib/account-equity";

const stamp = (value: string) => new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });

export function AccountEquityPanel({ latest, refresh }: { latest: EquityRecord; refresh: number }) {
  const [metric, setMetric] = useState<"equity" | "return">("equity");
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
  const display = (point: EquityRecord) => metric === "equity" ? equityMoney(point.equity, currency)
    : chartValue(point, "return") === null ? "미확인" : `${chartValue(point, "return")!.toFixed(2)}%`;
  return <div className="pf-equity" aria-label="선택 계좌 자산">
    <p className="pf-muted">{scope === "overseas" ? "해외자산" : "계좌 전체 자산"} · {currency} 원통화 기준 · 모든 날짜는 한국시간</p>
    <div className="pf-summary pf-equity-summary">
      <div><span className="pf-muted">{scope === "overseas" ? "해외 총자산" : "계좌 총자산"} · 현금 포함</span><strong>{equityMoney(latest.equity, currency)}</strong></div>
      <div><span className="pf-muted">현금</span><strong>{equityMoney(latest.cash, currency)}</strong></div>
      <div><span className="pf-muted">보유주식 평가액</span><strong>{equityMoney(latest.stock_value, currency)}</strong></div>
    </div>
    <p className="pf-muted">마지막 수집 {stamp(latest.collected_at)}</p>
    <details><summary className="pf-muted">수집·금액 기준</summary>
      <p className="pf-muted">서버 수신 {stamp(latest.received_at)} · 계산 {stamp(latest.calculated_at)}<br />
        {latest.valued_at ? `증권사 평가 시각 ${stamp(latest.valued_at)}` : "증권사 평가 시각 미제공 · 수집 시각과 같다고 가정하지 않습니다."}</p>
      {latest.source === "KIWOOM_US_EQUITY" && currency === "USD" && scope === "overseas" && <p className="pf-muted">미국주식·USD · 결제예정 반영. 현금은 결제예정 예수금을 포함하며 출금가능금액과 다릅니다.</p>}
      {(latest.cash === null || latest.stock_value === null) && <p className="pf-muted">미확인 항목은 0원이 아닙니다. 총자산에서 역산하지 않습니다.</p>}
    </details>
    {now - Date.parse(latest.collected_at) > 48 * 3600_000 && <p className="pf-notice">48시간 이상 지난 마지막 확인값입니다. 휴장·컴퓨터 종료·수집 일정 등을 확인해 주세요.</p>}
    <div className="pf-equity-chart">
      <h3>날짜별 변화</h3>
      <div className="pf-equity-switches">
        <div role="group" aria-label="그래프 종류">{([['equity','총자산'],['return','누적 수익률']] as const).map(([value,label]) =>
          <button className="pf-ghost" type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{label}</button>)}</div>
        <div role="group" aria-label="그래프 기간">{[['1m','1개월'],['3m','3개월'],['all','전체 기간']].map(([value,label]) =>
          <button className="pf-ghost" type="button" key={value} aria-pressed={period === value} onClick={() => setPeriod(value)}>{label}</button>)}</div>
      </div>
      <p className="pf-muted">{metric === "equity" ? "현금 포함 자산 금액 · 입출금의 영향이 포함됩니다." : "입출금 영향을 조정한 일별 표본 누적 수익률 · 기간을 바꿔도 기준을 0%로 재설정하지 않습니다."}</p>
      {busy ? <p role="status" className="pf-equity-empty pf-muted">자산 이력 불러오는 중…</p> : error ?
        <p role="alert" className="pf-error">이력을 불러오지 못했습니다. <button type="button" className="pf-ghost" onClick={() => setRetry(n => n + 1)}>이력 다시 조회</button></p> : <>
          {known.length ? <EquityChart points={history} metric={metric} selected={selected} onSelect={setSelectedDate} />
            : <p role="status" className="pf-equity-empty pf-muted">{history.length === 0 ? "선택 기간에 수집된 기록이 없습니다." : metric === "return" ? RETURN_REASONS[(selected ?? latest).return_status] : "이 기간의 총자산 금액을 확인하지 못했습니다."}</p>}
          {known.length === 1 && <p className="pf-muted">확인된 값이 한 점입니다. 기록이 더 쌓이면 추이를 볼 수 있습니다.</p>}
          {history.length > 0 && <div className="pf-equity-inspect">
            <div className="pf-filters"><label>날짜별 값<select aria-label="날짜별 값" value={selected?.date} onChange={e => setSelectedDate(e.target.value)}>
              {history.map(point => <option key={point.date} value={point.date}>{point.date}</option>)}
            </select></label></div>
            {selected && <p role="status"><strong>{selected.date} · {display(selected)}</strong><br />
              <span className="pf-muted">{RETURN_REASONS[selected.return_status]}{metric === "return" && selected.return_base_at ? ` · 기준 ${stamp(selected.return_base_at)}` : ""}</span></p>}
          </div>}
        </>}
      <p className="pf-muted">하루의 마지막 수집값이며 종가·실시간 시세가 아닙니다. 미수집 날짜와 확인되지 않은 수익률 구간은 선을 연결하지 않습니다.</p>
    </div>
  </div>;
}

function EquityChart({ points, metric, selected, onSelect }: { points: EquityRecord[]; metric: "equity" | "return"; selected?: EquityRecord; onSelect: (date: string) => void }) {
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
    <svg className="pf-equity-svg" viewBox={`0 0 ${width} 240`} role="img" aria-label={`${metric === "equity" ? "총자산" : "누적 수익률"} 날짜별 추이. 아래 날짜별 값에서 정확한 수치를 확인할 수 있습니다.`}
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
