import { NextRequest, NextResponse } from "next/server";

import {
  applySessionCookies,
  clearSessionCookies,
  fetchUser,
  getSession,
  signIn,
  signOut,
  signUp,
  updateNickname,
} from "@/lib/server/auth";
import { ConfigurationError } from "@/lib/server/config";
import { UpstreamError } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

type Params = { params: Promise<{ action: string }> };

function badRequest(message: string): NextResponse {
  return NextResponse.json({ error: message }, { status: 400 });
}

function handleKnownError(error: unknown): NextResponse {
  if (error instanceof ConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (error instanceof UpstreamError) {
    const status = error.status ?? 502;
    const message =
      status === 400 || status === 401 || status === 422
        ? "이메일 또는 비밀번호를 확인해 주세요."
        : "인증 서버 요청에 실패했습니다. 잠시 후 다시 시도해 주세요.";
    return NextResponse.json({ error: message }, { status: status >= 500 ? 502 : 401 });
  }
  return NextResponse.json({ error: "요청 처리에 실패했습니다." }, { status: 500 });
}

async function readCredentials(
  req: NextRequest,
): Promise<{ email: string; password: string } | NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("요청 본문이 올바르지 않습니다.");
  }
  const { email, password } = (body ?? {}) as { email?: unknown; password?: unknown };
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return badRequest("올바른 이메일을 입력해 주세요.");
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  return { email: email.trim(), password };
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { action } = await params;

  try {
    if (action === "signup") {
      const credentials = await readCredentials(req);
      if (credentials instanceof NextResponse) return credentials;

      const { tokens, needsEmailConfirm } = await signUp(
        credentials.email,
        credentials.password,
      );
      if (needsEmailConfirm || !tokens) {
        return NextResponse.json({
          ok: true,
          needsEmailConfirm: true,
          message: "확인 메일을 보냈습니다. 메일함에서 인증 후 로그인해 주세요.",
        });
      }
      const res = NextResponse.json({ ok: true, needsEmailConfirm: false });
      applySessionCookies(res, tokens);
      return res;
    }

    if (action === "login") {
      const credentials = await readCredentials(req);
      if (credentials instanceof NextResponse) return credentials;

      const tokens = await signIn(credentials.email, credentials.password);
      const res = NextResponse.json({ ok: true });
      applySessionCookies(res, tokens);
      return res;
    }

    if (action === "nickname") {
      const session = await getSession();
      if (!session) {
        return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
      }
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return badRequest("요청 본문이 올바르지 않습니다.");
      }
      const nickname = String((body as { nickname?: unknown })?.nickname ?? "").trim();
      if (!nickname || nickname.length > 20) {
        return badRequest("닉네임은 1~20자로 입력해 주세요.");
      }
      await updateNickname(session.accessToken, nickname);
      const res = NextResponse.json({ ok: true });
      if (session.renewedTokens) applySessionCookies(res, session.renewedTokens);
      return res;
    }

    if (action === "logout") {
      const session = await getSession();
      if (session) await signOut(session.accessToken);
      const res = NextResponse.json({ ok: true });
      clearSessionCookies(res);
      return res;
    }

    return badRequest("지원하지 않는 동작입니다.");
  } catch (error) {
    return handleKnownError(error);
  }
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { action } = await params;
  if (action !== "me") return badRequest("지원하지 않는 동작입니다.");

  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ user: null });

    const user = await fetchUser(session.accessToken);
    const res = NextResponse.json({ user: user ? { email: user.email, nickname: user.nickname } : null });
    if (session.renewedTokens) applySessionCookies(res, session.renewedTokens);
    if (!user) clearSessionCookies(res);
    return res;
  } catch (error) {
    return handleKnownError(error);
  }
}
