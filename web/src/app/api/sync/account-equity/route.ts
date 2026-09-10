import { NextRequest, NextResponse } from "next/server";
import { hashIntegrationToken, isIntegrationToken, serviceRest } from "@/lib/server/holdings-integration";
import { parseEquity, readEquityBody } from "@/lib/server/account-equity";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: object, status: number) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function PUT(req: NextRequest): Promise<NextResponse> {
  const token = /^Bearer ([^\s]+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!token || !isIntegrationToken(token)) return response({ error: "유효한 연동 토큰이 필요합니다." }, 401);
  try {
    const records = parseEquity(await readEquityBody(req));
    if (typeof records === "string") return response({ error: records }, 400);
    const synced = await serviceRest<number>("rpc/sync_account_equity", {
      method: "POST", body: JSON.stringify({ token_hash: hashIntegrationToken(token), records }),
    });
    return response({ ok: true, synced }, 200);
  } catch (error) {
    if (error instanceof RangeError) return response({ error: "요청은 1MiB 이하여야 합니다." }, 413);
    if (error instanceof SyntaxError) return response({ error: "JSON 요청 본문을 확인해 주세요." }, 400);
    if (error instanceof UpstreamError && error.status === 401) return response({ error: "유효한 연동 토큰이 필요합니다." }, 401);
    if (error instanceof UpstreamError && error.status === 400) return response({ error: "자산 기록의 저장 조건을 확인해 주세요." }, 400);
    if (error instanceof UpstreamError && error.status === 409) return response({ error: "같은 관측·계산 시각에 다른 값이 있습니다. 정정 계산 시각을 확인해 주세요." }, 409);
    return response({ error: "자산 기록을 저장하지 못했습니다. 같은 요청으로 재시도해 주세요." }, 502);
  }
}
