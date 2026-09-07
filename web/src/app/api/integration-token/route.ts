import { NextResponse } from "next/server";

import {
  applySessionCookies,
  clearSessionCookies,
  fetchUser,
  getSession,
  type Session,
} from "@/lib/server/auth";
import { ConfigurationError } from "@/lib/server/config";
import { getTokenStatus, issueToken, revokeToken, serviceRest } from "@/lib/server/holdings-integration";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function respond(body: object, status = 200, session?: Session): NextResponse {
  const response = NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (session?.renewedTokens) applySessionCookies(response, session.renewedTokens);
  return response;
}

async function authenticate(): Promise<{ session: Session; userId: string } | NextResponse> {
  const session = await getSession();
  if (!session) return respond({ error: "로그인이 필요합니다." }, 401);
  const user = await fetchUser(session.accessToken);
  if (!user) {
    const response = respond({ error: "로그인이 필요합니다." }, 401);
    clearSessionCookies(response);
    return response;
  }
  return { session, userId: user.id };
}

function knownError(error: unknown): NextResponse {
  if (error instanceof ConfigurationError) return respond({ error: error.message }, 500);
  if (error instanceof UpstreamError) return respond({ error: "연동 설정을 처리하지 못했습니다." }, 502);
  return respond({ error: "요청 처리에 실패했습니다." }, 500);
}

export async function GET(): Promise<NextResponse> {
  try {
    const auth = await authenticate();
    if (auth instanceof NextResponse) return auth;
    const [status, sync] = await Promise.all([
      getTokenStatus(auth.userId),
      serviceRest<{received_at:string}[]>(`integration_sync_status?user_id=eq.${encodeURIComponent(auth.userId)}&select=received_at,holdings_count,accounts&limit=1`,{method:"GET"}),
    ]);
    return respond({ active: !!status, ...status, sync: sync[0] ?? null, syncStale:!!sync[0] && Date.now()-Date.parse(sync[0].received_at)>48*60*60*1000 }, 200, auth.session);
  } catch (error) {
    return knownError(error);
  }
}

export async function POST(): Promise<NextResponse> {
  try {
    const auth = await authenticate();
    if (auth instanceof NextResponse) return auth;
    const token = await issueToken(auth.userId);
    return respond(
      { token, tokenHint: token.slice(-6), message: "이 토큰은 다시 표시되지 않습니다." },
      201,
      auth.session,
    );
  } catch (error) {
    return knownError(error);
  }
}

export async function DELETE(): Promise<NextResponse> {
  try {
    const auth = await authenticate();
    if (auth instanceof NextResponse) return auth;
    await revokeToken(auth.userId);
    return respond({ ok: true }, 200, auth.session);
  } catch (error) {
    return knownError(error);
  }
}
