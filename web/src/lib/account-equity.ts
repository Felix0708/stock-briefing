import { brokerLabel } from "./holding-brokers";

export const RETURN_METHOD = "daily-sampled-linked-modified-dietz";
export type EquityIdentity = {
  account_ref: string;
  broker: "KIWOOM" | "KIS";
  account_type: "paper" | "live";
  currency: "KRW" | "USD";
  scope: "overseas" | "account-total-assets";
};
export type EquityBasis = {
  date_timezone: "Asia/Seoul";
  return_method: typeof RETURN_METHOD | null;
  return_base_at: string | null;
};
export type EquityPoint = {
  date: string;
  valued_at: string | null;
  collected_at: string;
  calculated_at: string;
  equity: string | null;
  cash: string | null;
  stock_value: string | null;
  return_index: string | null;
  return_status: "verified" | "insufficient_samples" | "cash_flows_unverified" | "scope_unverified" | "invalid_data";
  source: "KIWOOM_US_EQUITY" | "KIS_ACCOUNT_EQUITY";
};
export type EquityRecord = EquityIdentity & EquityBasis & EquityPoint & { received_at: string };
export type EquityInput = Omit<EquityRecord, "received_at">;
export type EquitySeries = EquityIdentity & EquityBasis & { points: EquityPoint[] };

export function equityKey(value: EquityIdentity): string {
  return [value.account_ref, value.broker, value.account_type, value.currency, value.scope].join(":");
}
export function equityLabel(value: EquityIdentity): string {
  return `${brokerLabel(value.broker)} ${value.account_type === "paper" ? "모의" : "실계좌"} · ${value.scope === "overseas" ? "해외자산" : "계좌 전체"} ${value.currency}`;
}
export function equityMoney(value: string | null, currency: "KRW" | "USD"): string {
  if (value === null) return "미확인";
  const [integer, fraction] = value.split(".");
  const digits = BigInt(integer).toLocaleString("ko-KR");
  const decimals = fraction?.replace(/0+$/, "");
  const amount = `${integer.startsWith("-") && BigInt(integer) === BigInt(0) ? "-" : ""}${digits}${decimals ? `.${decimals}` : ""}`;
  return currency === "USD" ? `$${amount}` : `${amount}원`;
}
export const RETURN_REASONS = {
  verified: "입출금 증빙 확인 · 일별 표본 수익률",
  insufficient_samples: "추이 계산을 위한 추가 기록 대기",
  cash_flows_unverified: "해당 기간 입출금 전체 내역 확인 필요",
  scope_unverified: "평가 범위 확인 필요",
  invalid_data: "수익률 계산 자료 확인 필요",
};

export function chartValue(point: EquityRecord, metric: "equity" | "return"): number | null {
  if (metric === "equity") return point.equity === null ? null : Number(point.equity);
  return point.return_status === "verified" && point.return_method === RETURN_METHOD && point.return_base_at && point.return_index !== null
    ? (Number(point.return_index) - 1) * 100 : null;
}
export function canConnect(left: EquityRecord, right: EquityRecord, metric: "equity" | "return"): boolean {
  return Date.parse(right.date) - Date.parse(left.date) === 86_400_000
    && equityKey(left) === equityKey(right)
    && chartValue(left, metric) !== null && chartValue(right, metric) !== null
    && (metric === "equity" || (left.return_base_at === right.return_base_at && left.return_method === right.return_method));
}
