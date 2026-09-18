import { type HoldingAccount, type HoldingBroker } from "./holding-brokers";

export type PortfolioHolding = HoldingAccount & {
  market: "KR" | "US" | "JP"; stock_code: string; stock_name: string; quantity: number; avg_price: number;
  automated_quantity?: number | null; collected_at?: string;
};
export type BrokerSnapshot = {
  broker: "KIWOOM" | "KIS"; account_kind: "general" | "isa"; market: "KR" | "US"; collected_at: string;
  holdings: { stock_code: string; stock_name: string; quantity: number; avg_price: number; automated_quantity: number | null }[];
};

export function snapshotBroker(s: BrokerSnapshot): HoldingBroker {
  return s.account_kind === "isa" ? `${s.broker}_ISA` : s.broker;
}

// A complete broker snapshot replaces the DISPLAY of that live scope, not the user's ledger.
// Even an empty snapshot is authoritative; failed scopes are never sent as empty.
export function effectiveHoldings(manualAndTrading: PortfolioHolding[], snapshots: BrokerSnapshot[]): PortfolioHolding[] {
  const rows = manualAndTrading.filter(h => h.account_type === "paper" || !snapshots.some(s =>
    snapshotBroker(s) === h.broker && s.market === h.market));
  for (const s of snapshots) for (const h of s.holdings) rows.push({ ...h, market:s.market, broker:snapshotBroker(s),
    source:"broker_sync", account_type:"live", collected_at:s.collected_at });
  return rows;
}

export function holdingOwnership(h: PortfolioHolding): string {
  if (h.source === "manual") return "직접";
  if (h.source === "stock_trading") return "자동";
  if (h.automated_quantity == null) return "매수 주체 확인 필요";
  if (h.automated_quantity === 0) return "직접";
  if (h.automated_quantity === h.quantity) return "자동";
  return `자동 ${h.automated_quantity.toLocaleString("ko-KR")} · 직접 ${(h.quantity-h.automated_quantity).toLocaleString("ko-KR")}`;
}

export function validBrokerSnapshots(value: unknown): value is BrokerSnapshot[] {
  if (!Array.isArray(value) || value.length>6) return false;
  const scopes = new Set<string>();
  return value.every(s => {
    if (!s || Object.keys(s).sort().join()!=="account_kind,broker,collected_at,holdings,market"
      || !["KIWOOM","KIS"].includes(s.broker) || !["general","isa"].includes(s.account_kind)
      || !["KR","US"].includes(s.market) || s.account_kind==="isa" && s.market!=="KR"
      || typeof s.collected_at!=="string" || !/^\d{4}-\d{2}-\d{2}T/.test(s.collected_at)
      || !Number.isFinite(Date.parse(s.collected_at)) || Date.parse(s.collected_at)>Date.now()+300000
      || !Array.isArray(s.holdings) || s.holdings.length>200) return false;
    const scope=`${s.broker}:${s.account_kind}:${s.market}`;
    if(scopes.has(scope)) return false;
    scopes.add(scope);
    const codes = new Set<string>();
    return s.holdings.every((h: Record<string, unknown>) => {
      if(!h || Object.keys(h).sort().join()!=="automated_quantity,avg_price,quantity,stock_code,stock_name"
        || typeof h.stock_code!=="string" || !(s.market==="KR" ? /^\d{6}$/ : /^[A-Z][A-Z0-9.-]{0,9}$/).test(h.stock_code)
        || codes.has(h.stock_code) || typeof h.stock_name!=="string" || !h.stock_name.trim() || h.stock_name.length>50
        || ![h.quantity,h.avg_price].every(n=>typeof n==="number" && Number.isFinite(n) && n>0 && n<=1e12)
        || !(h.automated_quantity===null || typeof h.automated_quantity==="number" && Number.isFinite(h.automated_quantity)
          && h.automated_quantity>=0 && h.automated_quantity<=Number(h.quantity))
        || s.account_kind==="isa" && h.automated_quantity!==0) return false;
      codes.add(h.stock_code); return true;
    });
  });
}
