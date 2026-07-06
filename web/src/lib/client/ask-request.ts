export const CLIENT_REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_RETRY_AFTER_SECONDS = 60;

export type RequestAbortReason = "timeout" | "user" | "unmount" | null;

export class UserVisibleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserVisibleRequestError";
  }
}

export function parseRetryDeadline(value: string | null, now = Date.now()) {
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return now + Math.max(1, Math.ceil(seconds)) * 1_000;
    }

    const retryAt = Date.parse(value);
    if (!Number.isNaN(retryAt)) {
      return Math.max(now + 1_000, retryAt);
    }
  }

  return now + DEFAULT_RETRY_AFTER_SECONDS * 1_000;
}

export function getRetrySeconds(deadline: number, now = Date.now()) {
  return Math.max(0, Math.ceil((deadline - now) / 1_000));
}

export function getRequestErrorMessage(
  error: unknown,
  abortReason: RequestAbortReason,
) {
  if (error instanceof UserVisibleRequestError) return error.message;
  if (abortReason === "timeout") {
    return "요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
  }
  if (abortReason === "user") return "요청을 취소했습니다.";
  return "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
}
