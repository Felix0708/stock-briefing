"use client";
import { useState } from "react";

export function PortfolioBackupPanel({onChanged}:{onChanged:()=>Promise<void>}) {
  const [file,setFile]=useState<File|null>(null);
  const [preview,setPreview]=useState<{archive_text:string;fingerprint:string;holdings:number;trades:number;revisions:number}|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [confirmed,setConfirmed]=useState(false);
  async function restore(apply:boolean) {
    if (!file || busy || apply && (!preview || !confirmed)) return;
    setBusy(true);setMessage("");
    try {
      // ponytail: keep JSON escaping below Vercel's 4.5 MB request ceiling; use direct storage uploads if larger archives become necessary.
      if (file.size>2_000_000) throw new Error("웹 복원은 2 MB 이하의 백업 파일을 사용해 주세요. 더 큰 파일도 자동 암호화 백업에는 보관됩니다.");
      let archive_text=preview?.archive_text ?? "", fingerprint=preview?.fingerprint ?? "";
      if (!apply) {
        archive_text=await file.text();
        const current=await fetch("/api/portfolio-backup");
        if (!current.ok) throw new Error("현재 잔고를 확인하지 못했습니다.");
        fingerprint=(await current.json()).fingerprint;
      }
      const response=await fetch("/api/portfolio-backup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({archive_text,expected_fingerprint:fingerprint,apply})});
      const data=await response.json();
      if (!response.ok) throw new Error(data.error);
      if (apply) {setPreview(null);setConfirmed(false);setMessage("복원 완료. 복원 직전 상태도 서버에 별도로 보관했습니다.");await onChanged();}
      else {setPreview({...data,archive_text});setConfirmed(false);}
    } catch (error) {setMessage(error instanceof Error ? error.message : "복원 결과를 확인하지 못했습니다.");}
    finally {setBusy(false);}
  }
  return <section className="pf-card" aria-labelledby="backup-title">
    <h2 id="backup-title">내 데이터 백업·복원</h2>
    <p className="pf-muted">백업에는 잔고, 수동 매매·정정 이력, 자동매매 성과 스냅샷이 담깁니다. 비밀번호·연동 토큰은 포함하지 않습니다. 개인 파일이니 공개 저장소에 올리지 마세요.</p>
    <div className="pf-token-actions"><a className="pf-ghost" href="/api/portfolio-backup">전체 포트폴리오 백업</a><a className="pf-ghost" href="/api/portfolio-backup?format=holdings">잔고 CSV</a><a className="pf-ghost" href="/api/portfolio-backup?format=trades">매매 CSV</a></div>
    <details><summary>백업 파일 복원</summary>
      <p className="pf-muted">같은 계정의 JSON 백업만 복원합니다. 현재 잔고·매매 이력을 파일 내용으로 교체합니다. 자동매매는 이후 Stock-Trading 동기화로 다시 최신화됩니다. 로그인·메일 수신 설정은 바뀌지 않습니다.</p>
      <label>백업 JSON 파일<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{setFile(event.target.files?.[0]??null);setPreview(null);setConfirmed(false);}} /></label>
      <button type="button" className="pf-ghost" disabled={busy || !file} onClick={()=>void restore(false)}>복원 미리보기</button>
      {preview && <div><p>잔고 {preview.holdings}건 · 매매 {preview.trades}건 · 정정 이력 {preview.revisions}건</p>
        <label className="pf-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event=>setConfirmed(event.target.checked)} />현재 데이터를 이 백업으로 교체하는 것을 확인했습니다.</label>
        <button type="button" className="pf-primary" disabled={busy || !confirmed} onClick={()=>void restore(true)}>확인한 백업으로 복원</button></div>}
      <p><a href="/api/portfolio-backup?previous=true">가장 최근 복원 직전 백업 내려받기</a></p>
    </details>
    {message && <p role="status" className="pf-notice">{message}</p>}
  </section>;
}
