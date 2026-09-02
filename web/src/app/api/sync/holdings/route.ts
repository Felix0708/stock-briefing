import { NextRequest, NextResponse } from "next/server";

import { ConfigurationError } from "@/lib/server/config";
import {
  isIntegrationToken,
  parseSnapshot,
  syncSnapshot,
} from "@/lib/server/holdings-integration";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(body: object, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || !isIntegrationToken(match[1])) return response({ error: "유효한 연동 토큰이 필요합니다." }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return response({ error: "요청 본문이 올바르지 않습니다." }, 400);
  }
  const snapshot = parseSnapshot(body);
  if (typeof snapshot === "string") return response({ error: snapshot }, 400);

  try {
    const synced = await syncSnapshot(match[1], snapshot);
    return response({ ok: true, synced }, 200);
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 401) {
      return response({ error: "연동 토큰이 만료되었거나 폐기되었습니다." }, 401);
    }
    if (error instanceof ConfigurationError) return response({ error: error.message }, 500);
    if (error instanceof UpstreamError) return response({ error: "보유종목 동기화에 실패했습니다." }, 502);
    return response({ error: "요청 처리에 실패했습니다." }, 500);
  }
}
