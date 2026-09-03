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
] as const;

export type ManualBroker = (typeof MANUAL_BROKER_OPTIONS)[number]["value"];
export type HoldingBroker = ManualBroker | "MANUAL" | "LEGACY";

export function isManualBroker(value: unknown): value is ManualBroker {
  return MANUAL_BROKER_OPTIONS.some((option) => option.value === value);
}

export function brokerLabel(broker: HoldingBroker): string {
  if (broker === "MANUAL") return "증권사 미지정";
  if (broker === "LEGACY") return "이전 연동";
  return MANUAL_BROKER_OPTIONS.find((option) => option.value === broker)?.label ?? broker;
}
