export const ACCOUNT_STATUS_LABELS = {
  total_verified: "총자산 수집 완료",
  other_currency_assets: "USD 외 통화 잔액·자산이 있어 전체 총자산 합산 보류",
  total_unverified: "국내·미국 자산 범위·현금·환율 검증이 완료되지 않아 합산 보류",
  collection_failed: "계좌 자산 조회 실패 · 마지막 정상 기록 유지",
} as const;

export type AccountStatus = {
  account_ref: string;
  broker: "KIWOOM" | "KIS";
  account_type: "paper" | "live";
  checked_at: string;
  code: keyof typeof ACCOUNT_STATUS_LABELS;
};
