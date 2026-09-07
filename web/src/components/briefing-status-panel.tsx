"use client";
import { useCallback, useEffect, useState } from "react";

type Collection = { company: string; market: string; stock_code: string; status: string; filing_count: number; checked_at: string; last_success_at: string | null };
type Status = { collections: Collection[]; delivery: {status: string; checked_at: string; last_sent_at: string | null; filing_count: number} | null; run: {status: string; checked_at: string; last_success_at: string | null} | null; emailEnabled: boolean };
const labels: Record<string,string> = {success:"수집 완료",empty:"신규 공시 없음",failed:"실패",unsupported:"수집 설정 없음",partial:"일부 처리 실패",sent:"메일 서버에 전달 완료",no_filings:"보낼 신규 공시 없음",collection_failed:"수집 미완료 · 발송 대기",disabled:"메일 발송 꺼짐",limit_reached:"발송 한도 도달",running:"수집 진행 중"};
function time(value: string | null) { return value ? new Date(value).toLocaleString("ko-KR") : "아직 기록 없음"; }
export function BriefingStatusPanel({ holdings }: {holdings: {market: string; stock_code: string; stock_name: string}[]}) {
  const [data,setData] = useState<Status | null>(null);
  const [error,setError] = useState("");
  const load=useCallback(async()=>{
    try {const response=await fetch("/api/briefing-status");if(!response.ok)throw new Error();setData(await response.json());setError("");}
    catch {setError("수집·메일 상태를 조회하지 못했습니다.");}
  },[]);
  useEffect(()=>{void load();},[load]);
  const unique=[...new Map(holdings.map((holding)=>[`${holding.market}:${holding.stock_code}`,holding])).values()];
  return <section className="pf-card" aria-labelledby="briefing-status-title">
    <div className="pf-list-head"><h2 id="briefing-status-title">공시·메일 상태</h2><button type="button" className="pf-ghost" onClick={()=>void load()}>상태 새로고침</button></div>
    {error && <p className="pf-error" role="status">{error}</p>}
    {data && <>
      <p className="pf-muted">전체 수집: {data.run ? labels[data.run.status] : "아직 기록 없음"} · 최근 확인 {time(data.run?.checked_at ?? null)} · 최근 완료 {time(data.run?.last_success_at ?? null)}</p>
      <p>메일: {!data.emailEnabled ? "수신 꺼짐" : data.delivery ? labels[data.delivery.status] : "아직 발송 기록 없음"} · 마지막 전달 {time(data.delivery?.last_sent_at ?? null)}</p>
      <p className="pf-muted">메일 전달 완료는 발송 서버의 접수 기준입니다. 기록은 이 기능 적용 이후부터 표시됩니다.</p>
      <ul className="pf-history">{unique.map((holding)=>{
        const row=data.collections.find((item)=>item.market===holding.market&&(item.stock_code===holding.stock_code||item.company===holding.stock_name));
        return <li key={`${holding.market}:${holding.stock_code}`}><strong>{holding.stock_name} ({holding.stock_code})</strong>
          <span>{row ? labels[row.status] : "첫 수집 대기"}{row && row.filing_count>0 ? ` · ${row.filing_count}건` : ""}</span>
          <span className="pf-muted">최근 확인 {time(row?.checked_at ?? null)} · 최근 수집 성공 {time(row?.last_success_at ?? null)}</span>
        </li>;
      })}</ul>
    </>}
  </section>;
}
