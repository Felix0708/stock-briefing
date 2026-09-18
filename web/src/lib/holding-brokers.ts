export const MANUAL_BROKER_OPTIONS = [
  { value: "KIWOOM", label: "키움증권" },
  { value: "KIS", label: "한국투자증권" },
  { value: "MIRAE", label: "미래에셋증권" },
  { value: "NH", label: "NH투자증권" },
  { value: "SAMSUNG", label: "삼성증권" },
  { value: "KB", label: "KB증권" },
  { value: "SHINHAN", label: "신한투자증권" },
  { value: "TOSS", label: "토스증권" },
  { value: "KAKAOPAY", label: "카카오페이증권" },
  { value: "DAISHIN", label: "대신증권" },
  { value: "OTHER", label: "기타 증권사" },
  { value: "KIWOOM_ISA", label: "키움증권 ISA" },
  { value: "KIS_ISA", label: "한국투자증권 ISA" },
] as const;

// ISA is a separate account namespace in the existing broker-keyed ledger.
// Keeping the key distinct also isolates manual trade history and backup replay.
export type ManualBroker = (typeof MANUAL_BROKER_OPTIONS)[number]["value"] | "KIS_ISA" | "KIWOOM_ISA";
export type HoldingBroker = ManualBroker | "MANUAL" | "LEGACY";
export type HoldingAccount = {
  source: "manual" | "stock_trading" | "broker_sync";
  account_type: "manual" | "paper" | "live";
  broker: HoldingBroker;
};

export function isManualBroker(value: unknown): value is ManualBroker {
  return value === "KIS_ISA" || value === "KIWOOM_ISA" || MANUAL_BROKER_OPTIONS.some((option) => option.value === value);
}

export function baseBroker(broker: HoldingBroker): HoldingBroker {
  return broker === "KIS_ISA" ? "KIS" : broker === "KIWOOM_ISA" ? "KIWOOM" : broker;
}
export function isIsaBroker(broker: HoldingBroker): boolean { return broker.endsWith("_ISA"); }

export function brokerLabel(broker: HoldingBroker): string {
  if (isIsaBroker(broker)) return `${brokerLabel(baseBroker(broker))} ISA`;
  if (broker === "MANUAL") return "증권사 미지정";
  if (broker === "LEGACY") return "이전 연동";
  return MANUAL_BROKER_OPTIONS.find((option) => option.value === broker)?.label ?? broker;
}

export function isRealAccount(holding: HoldingAccount): boolean {
  return holding.source === "manual" || holding.account_type === "live";
}

export function accountGroupKey(holding: HoldingAccount): string {
  return `${holding.broker}:${isRealAccount(holding) ? "live" : "paper"}`;
}

export function accountGroupLabel(holding: HoldingAccount): string {
  if (holding.broker === "MANUAL") return "증권사 미지정";
  return `${brokerLabel(holding.broker)} ${isRealAccount(holding) ? "실계좌" : "모의계좌"}`;
}
