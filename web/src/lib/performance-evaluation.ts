export const EVALUATION_REASONS = {
  MOCK_SESSION_LIMIT: "모의 거래시간 제한", SYSTEM_INCIDENT: "시스템 장애",
  POLICY_CHANGE: "정책 변경", DATA_INSUFFICIENT: "증빙 부족",
  EXECUTION_DELAY_UNATTRIBUTED: "원인 미확인 체결 지연", REVIEW_REQUIRED: "검토 필요",
} as const;
export type PerformanceEvaluation = {
  version: 1; total_count: number; eligible_count: number; excluded_count: number;
  reason_counts: Partial<Record<keyof typeof EVALUATION_REASONS, number>>;
  cohorts: {policy_hash:string; currency:"USD"|"KRW"; count:number; wins:number; losses:number; draws:number;
    win_rate:number|null; profit_loss:number; net_profit_loss:number|null; unknown_costs:number}[];
};
const record = (x:unknown): x is Record<string,unknown> => !!x && typeof x==="object" && !Array.isArray(x);
const keys = (x:Record<string,unknown>, expected:string) => Object.keys(x).sort().join(",")===expected;
const count = (x:unknown): x is number => typeof x==="number" && Number.isInteger(x) && x>=0 && x<=2147483647;
const money = (x:unknown): x is number => typeof x==="number" && Number.isFinite(x) && Math.abs(x)<=1e15;

export function validEvaluation(x:unknown): x is PerformanceEvaluation {
  if (!record(x) || !keys(x,"cohorts,eligible_count,excluded_count,reason_counts,total_count,version") || x.version!==1
    || !count(x.total_count) || !count(x.eligible_count) || !count(x.excluded_count)
    || x.total_count!==x.eligible_count+x.excluded_count || !record(x.reason_counts)
    || !Array.isArray(x.cohorts) || x.cohorts.length>100) return false;
  let reasons=0, total=0;
  for (const [key,value] of Object.entries(x.reason_counts)) {
    if (!Object.hasOwn(EVALUATION_REASONS,key) || !count(value) || value>x.excluded_count) return false;
    reasons+=value;
  }
  if (reasons<x.excluded_count) return false;
  const seen=new Set<string>();
  for(const c of x.cohorts) {
    if(!record(c) || !keys(c,"count,currency,draws,losses,net_profit_loss,policy_hash,profit_loss,unknown_costs,win_rate,wins")
      || typeof c.policy_hash!=="string" || !/^[a-f0-9]{64}$/.test(c.policy_hash)
      || !["USD","KRW"].includes(String(c.currency)) || !count(c.count) || c.count===0
      || !count(c.wins) || !count(c.losses) || !count(c.draws) || !count(c.unknown_costs)
      || c.count!==c.wins+c.losses+c.draws || c.unknown_costs>c.count || !money(c.profit_loss)
      || (c.unknown_costs>0 ? c.net_profit_loss!==null : !money(c.net_profit_loss))) return false;
    const decided=c.wins+c.losses;
    if(decided===0 ? c.win_rate!==null : typeof c.win_rate!=="number" || !Number.isFinite(c.win_rate)
      || c.win_rate<0 || c.win_rate>100 || Math.abs(c.win_rate-100*c.wins/decided)>0.011) return false;
    const key=`${c.policy_hash}:${c.currency}`;
    if(seen.has(key)) return false;
    seen.add(key); total+=c.count;
  }
  return total===x.eligible_count;
}
