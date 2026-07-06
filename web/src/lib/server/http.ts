import "server-only";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export class UpstreamError extends Error {
  constructor(
    public readonly service: string,
    public readonly status?: number,
    message?: string,
  ) {
    super(message ?? `${service} 요청에 실패했습니다.`);
    this.name = "UpstreamError";
  }
}

type RequestJsonOptions = {
  attempts?: number;
  timeoutMs?: number;
  beforeAttempt?: () => Promise<void>;
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestJson<T>(
  service: string,
  url: string,
  init: RequestInit,
  options: RequestJsonOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // 예산 차감 등 실제 전송 직전 훅은 재시도마다 한 번씩 실행하며,
    // 훅 자체의 거부/장애는 외부 요청 재시도 오류로 변환하지 않는다.
    await options.beforeAttempt?.();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) {
        return (await response.json()) as T;
      }

      const error = new UpstreamError(
        service,
        response.status,
        `${service} 응답 오류 (${response.status})`,
      );
      if (!RETRYABLE_STATUS.has(response.status) || attempt === attempts) {
        throw error;
      }
      lastError = error;
    } catch (error) {
      if (error instanceof UpstreamError && !RETRYABLE_STATUS.has(error.status ?? 0)) {
        throw error;
      }
      lastError = error;
      if (attempt === attempts) break;
    } finally {
      clearTimeout(timeout);
    }

    await wait(250 * 2 ** (attempt - 1));
  }

  if (lastError instanceof UpstreamError) throw lastError;
  throw new UpstreamError(
    service,
    undefined,
    lastError instanceof Error ? lastError.message : undefined,
  );
}
