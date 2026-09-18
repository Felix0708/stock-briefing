import type { EquityRecord } from "./account-equity";

export const ACCOUNT_STATUS_LABELS = {
  total_verified: "송신측 총자산 검증 완료",
  other_currency_assets: "USD 외 통화 잔액·자산이 있어 전체 총자산 합산 보류",
  total_unverified: "국내·미국 자산 범위·현금·환율 검증이 완료되지 않아 합산 보류",
  collection_failed: "계좌 자산 조회 실패 · 기존 정상 기록이 있으면 유지",
} as const;

export type AccountStatus = {
  account_ref: string;
  broker: "KIWOOM" | "KIS";
  account_type: "paper" | "live";
  checked_at: string;
  code: keyof typeof ACCOUNT_STATUS_LABELS;
};

export function accountStatusMessage(status: AccountStatus, series: EquityRecord[]): string {
  const received = series.filter(row => row.scope === "account-total-assets" && row.broker === status.broker
    && row.account_type === status.account_type && (row.account_ref === status.account_ref || row.account_group_ref === status.account_ref))
    .reduce((latest,row) => Math.max(latest,Date.parse(row.collected_at)),0);
  const checked = Date.parse(status.checked_at);
  if (status.code === "total_verified") return received >= checked
    ? "총자산 수신 완료" : "송신측 검증 완료 · 해당 시각의 웹 자산 수신 확인 필요";
  if (received > checked) return "이전 진단 이후 새 총자산 수신 · 아래 최신 기록 확인";
  return ACCOUNT_STATUS_LABELS[status.code];
}
