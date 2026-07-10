import { NextRequest, NextResponse } from "next/server";

import { getSession } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 온디맨드 종목 수집: GitHub Actions(collect-company.yml)를 원격 실행한다.
// - 로그인 필수 (남용 방지)
// - 같은 종목은 10분에 한 번만 실행 (인스턴스 메모리 기준 — 완벽하진 않지만 충분)

const COOLDOWN_MS = 10 * 60 * 1000;
const recentRequests = new Map<string, number>();

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json(
      { error: "수집 요청은 로그인 후 가능합니다. 내 포트폴리오에서 로그인해 주세요." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 올바르지 않습니다." }, { status: 400 });
  }
  const company = String((body as { company?: unknown })?.company ?? "").trim();
  if (!company || company.length > 50) {
    return NextResponse.json({ error: "종목명을 확인해 주세요." }, { status: 400 });
  }

  const token = process.env.GITHUB_DISPATCH_TOKEN?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  if (!token || !repo) {
    return NextResponse.json(
      { error: "서버에 GITHUB_DISPATCH_TOKEN / GITHUB_REPO 설정이 필요합니다." },
      { status: 500 },
    );
  }

  const last = recentRequests.get(company);
  if (last && Date.now() - last < COOLDOWN_MS) {
    return NextResponse.json(
      { ok: true, message: "이미 수집이 진행 중입니다. 잠시 후 자동으로 반영됩니다." },
    );
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/collect-company.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ ref: "main", inputs: { company } }),
      },
    );

    if (response.status !== 204) {
      const detail = await response.text().catch(() => "");
      console.error(`[collect] GitHub dispatch ${response.status}: ${detail.slice(0, 300)}`);
      return NextResponse.json(
        { error: `수집 실행에 실패했습니다. (GitHub ${response.status})` },
        { status: 502 },
      );
    }

    recentRequests.set(company, Date.now());
    return NextResponse.json({
      ok: true,
      message: `'${company}' 공시 수집을 시작했습니다. 보통 2~5분 걸립니다.`,
    });
  } catch {
    return NextResponse.json({ error: "수집 실행 요청에 실패했습니다." }, { status: 502 });
  }
}
