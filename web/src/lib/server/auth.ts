import "server-only";

import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { ConfigurationError } from "./config";
import { UpstreamError, requestJson } from "./http";

// Supabase Auth(GoTrue) REST를 서버에서 직접 호출한다.
// 클라이언트에는 어떤 키도 내려가지 않으며, 세션은 httpOnly 쿠키로만 유지된다.
// SUPABASE_ANON_KEY(publishable key)는 원래 공개 가능한 키지만,
// 이 프로젝트 원칙(NEXT_PUBLIC 금지)에 따라 서버 전용으로만 사용한다.

const ACCESS_COOKIE = "sb-at";
const REFRESH_COOKIE = "sb-rt";
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30; // 30일

export type AuthTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

export type AuthUser = {
  id: string;
  email: string;
};

type GoTrueSession = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string };
  // signup 응답이 세션 없이 user만 올 수도 있다 (이메일 확인이 켜진 경우)
  id?: string;
  email?: string;
  confirmation_sent_at?: string;
  msg?: string;
  error_description?: string;
};

function authEnv(): { url: string; anonKey: string } {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url) throw new ConfigurationError("필수 서버 환경변수 SUPABASE_URL가 없습니다.");
  if (!anonKey) {
    throw new ConfigurationError(
      "SUPABASE_ANON_KEY가 없습니다. Supabase 대시보드 → Settings → API Keys의 publishable(anon) key를 서버 환경변수로 등록하세요.",
    );
  }
  return { url, anonKey };
}

export function anonHeaders(): Record<string, string> {
  const { anonKey } = authEnv();
  const headers: Record<string, string> = {
    apikey: anonKey,
    "Content-Type": "application/json",
  };
  // 신형 sb_publishable_ 키는 API 키, 구형 anon JWT는 Bearer도 필요하다.
  if (!anonKey.startsWith("sb_publishable_")) {
    headers.Authorization = `Bearer ${anonKey}`;
  }
  return headers;
}

export function userHeaders(accessToken: string): Record<string, string> {
  const { anonKey } = authEnv();
  return {
    apikey: anonKey,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

export function supabaseUrl(): string {
  return authEnv().url;
}

function toTokens(session: GoTrueSession): AuthTokens | null {
  if (!session.access_token || !session.refresh_token) return null;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresIn: session.expires_in ?? 3600,
  };
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ tokens: AuthTokens | null; needsEmailConfirm: boolean }> {
  const session = await requestJson<GoTrueSession>(
    "Supabase Auth",
    `${supabaseUrl()}/auth/v1/signup`,
    { method: "POST", headers: anonHeaders(), body: JSON.stringify({ email, password }) },
    { attempts: 1 },
  );
  const tokens = toTokens(session);
  return { tokens, needsEmailConfirm: !tokens };
}

export async function signIn(email: string, password: string): Promise<AuthTokens> {
  const session = await requestJson<GoTrueSession>(
    "Supabase Auth",
    `${supabaseUrl()}/auth/v1/token?grant_type=password`,
    { method: "POST", headers: anonHeaders(), body: JSON.stringify({ email, password }) },
    { attempts: 1 },
  );
  const tokens = toTokens(session);
  if (!tokens) throw new UpstreamError("Supabase Auth", 401, "로그인에 실패했습니다.");
  return tokens;
}

async function refreshSession(refreshToken: string): Promise<AuthTokens | null> {
  try {
    const session = await requestJson<GoTrueSession>(
      "Supabase Auth",
      `${supabaseUrl()}/auth/v1/token?grant_type=refresh_token`,
      {
        method: "POST",
        headers: anonHeaders(),
        body: JSON.stringify({ refresh_token: refreshToken }),
      },
      { attempts: 1 },
    );
    return toTokens(session);
  } catch {
    return null;
  }
}

export async function fetchUser(accessToken: string): Promise<AuthUser | null> {
  try {
    const user = await requestJson<{ id?: string; email?: string }>(
      "Supabase Auth",
      `${supabaseUrl()}/auth/v1/user`,
      { method: "GET", headers: userHeaders(accessToken) },
      { attempts: 1 },
    );
    if (!user.id || !user.email) return null;
    return { id: user.id, email: user.email };
  } catch {
    return null;
  }
}

export async function signOut(accessToken: string): Promise<void> {
  try {
    await fetch(`${supabaseUrl()}/auth/v1/logout`, {
      method: "POST",
      headers: userHeaders(accessToken),
    });
  } catch {
    // 로그아웃 실패는 무시 (쿠키 삭제가 본질)
  }
}

// ---------- 쿠키 세션 ----------

export function applySessionCookies(res: NextResponse, tokens: AuthTokens): void {
  const secure = process.env.NODE_ENV === "production";
  res.cookies.set(ACCESS_COOKIE, tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(tokens.expiresIn - 60, 60),
  });
  res.cookies.set(REFRESH_COOKIE, tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearSessionCookies(res: NextResponse): void {
  res.cookies.set(ACCESS_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { path: "/", maxAge: 0 });
}

export type Session = {
  accessToken: string;
  // access token이 만료돼 refresh로 재발급된 경우, 응답에 새 쿠키를 실어야 한다.
  renewedTokens: AuthTokens | null;
};

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  if (accessToken) return { accessToken, renewedTokens: null };

  const refreshToken = jar.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return null;

  const renewed = await refreshSession(refreshToken);
  if (!renewed) return null;
  return { accessToken: renewed.accessToken, renewedTokens: renewed };
}
