import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest): NextResponse {
  const { method, nextUrl, headers } = request;
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return NextResponse.next();

  // These APIs do not use browser cookies: public Q&A and bearer-token sync.
  if (
    (method === "POST" && nextUrl.pathname === "/api/ask") ||
    (method === "PUT" && nextUrl.pathname === "/api/sync/holdings")
  ) return NextResponse.next();

  const site = headers.get("sec-fetch-site");
  // NextURL normalizes loopback IPs to localhost; compare the actual Host instead.
  // Never take the expected origin from user-supplied forwarded-host headers.
  const origin = `${nextUrl.protocol}//${headers.get("host") ?? nextUrl.host}`;
  if (
    headers.get("origin") !== origin ||
    (site !== null && site !== "same-origin" && site !== "none")
  ) {
    return NextResponse.json(
      { error: "허용되지 않은 요청입니다. 사이트에서 다시 시도해 주세요." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
