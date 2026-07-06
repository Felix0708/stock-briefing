import type {
  AskErrorResponse,
  AskRequest,
  AskSuccessResponse,
} from "../../../lib/ask-types";
import { answerQuestion } from "../../../lib/server/ask";
import { ConfigurationError } from "../../../lib/server/config";
import { UpstreamError } from "../../../lib/server/http";
import {
  enforceAskRateLimit,
  rateLimitHeaders,
  RateLimitExceededError,
  RateLimitServiceError,
  type AskRateLimitResult,
} from "../../../lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUESTION_LENGTH = 1_000;
const MAX_COMPANY_LENGTH = 100;

function json(
  body: AskSuccessResponse | AskErrorResponse,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

function validateBody(value: unknown): AskRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (typeof body.question !== "string") return null;
  if (body.company !== undefined && typeof body.company !== "string") return null;

  const question = body.question.trim();
  const company = typeof body.company === "string" ? body.company.trim() : undefined;
  if (!question || question.length > MAX_QUESTION_LENGTH) return null;
  if (company && company.length > MAX_COMPANY_LENGTH) return null;

  return { question, ...(company ? { company } : {}) };
}

export async function POST(request: Request): Promise<Response> {
  let rateLimit: AskRateLimitResult;
  try {
    rateLimit = await enforceAskRateLimit(request);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      console.error("[ask] rate limit configuration error", error.message);
      return json(
        {
          error: {
            code: "RATE_LIMIT_UNAVAILABLE",
            message: "요청 보호 서비스 설정이 완료되지 않았습니다.",
          },
        },
        503,
      );
    }

    if (error instanceof RateLimitServiceError) {
      console.error("[ask] rate limit service error", error.message);
      return json(
        {
          error: {
            code: "RATE_LIMIT_UNAVAILABLE",
            message: "요청 보호 서비스에 일시적인 오류가 발생했습니다.",
          },
        },
        503,
      );
    }

    console.error("[ask] unexpected rate limit error", error);
    return json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "답변 처리 중 오류가 발생했습니다.",
        },
      },
      500,
    );
  }

  const limitHeaders = rateLimitHeaders(rateLimit, !rateLimit.allowed);
  if (!rateLimit.allowed) {
    return json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "요청이 많아 잠시 후 다시 시도해 주세요.",
        },
      },
      429,
      limitHeaders,
    );
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: "요청 본문은 올바른 JSON이어야 합니다.",
        },
      },
      400,
      limitHeaders,
    );
  }

  const body = validateBody(rawBody);
  if (!body) {
    return json(
      {
        error: {
          code: "INVALID_REQUEST",
          message: `question은 1~${MAX_QUESTION_LENGTH}자 문자열이어야 하며 company는 선택 항목입니다.`,
        },
      },
      400,
      limitHeaders,
    );
  }

  try {
    return json(await answerQuestion(body.question, body.company), 200, limitHeaders);
  } catch (error) {
    if (error instanceof RateLimitExceededError) {
      return json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "요청이 많아 잠시 후 다시 시도해 주세요.",
          },
        },
        429,
        rateLimitHeaders(error.result, true),
      );
    }

    if (error instanceof RateLimitServiceError) {
      console.error("[ask] rate limit service error", error.message);
      return json(
        {
          error: {
            code: "RATE_LIMIT_UNAVAILABLE",
            message: "요청 보호 서비스에 일시적인 오류가 발생했습니다.",
          },
        },
        503,
        limitHeaders,
      );
    }

    if (error instanceof ConfigurationError) {
      console.error("[ask] server configuration error", error.message);
      return json(
        {
          error: {
            code: "CONFIGURATION_ERROR",
            message: "서버 설정이 완료되지 않았습니다.",
          },
        },
        500,
        limitHeaders,
      );
    }

    if (error instanceof UpstreamError) {
      console.error(`[ask] ${error.service} error`, error.message);
      return json(
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: "공시 검색 또는 답변 생성 중 외부 서비스 오류가 발생했습니다.",
          },
        },
        502,
        limitHeaders,
      );
    }

    console.error("[ask] unexpected error", error);
    return json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "답변 처리 중 오류가 발생했습니다.",
        },
      },
      500,
      limitHeaders,
    );
  }
}
