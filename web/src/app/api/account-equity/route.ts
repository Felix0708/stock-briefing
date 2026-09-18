import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies, fetchUser, getSession, supabaseUrl, userHeaders } from "@/lib/server/auth";
import { requestJson } from "@/lib/server/http";
import { isDate, UUID } from "@/lib/server/account-equity";
import { equitySource, type EquityInput, type EquityRecord } from "@/lib/account-equity";
import { ACCOUNT_STATUS_LABELS, type AccountStatus } from "@/lib/account-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const response = (body: object, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session || !await fetchUser(session.accessToken)) return response({ error: "로그인이 필요합니다." }, 401);
    const params = req.nextUrl.searchParams;
    const headers = userHeaders(session.accessToken);
    let result: NextResponse;
    if (params.size === 0) {
      const series = await requestJson<EquityRecord[]>("Supabase", `${supabaseUrl()}/rest/v1/rpc/account_equity_series`, { headers, method: "POST", body: "{}", cache: "no-store" }, { attempts: 1 });
      let statuses: AccountStatus[] = [];
      let statusUnavailable = false;
      try {
        const rows = await requestJson<AccountStatus[]>("Supabase", `${supabaseUrl()}/rest/v1/account_collection_status?select=account_ref,broker,account_type,checked_at,code`, {headers,cache:"no-store"}, {attempts:1});
        if (!Array.isArray(rows) || rows.some(row => !row || !Object.hasOwn(ACCOUNT_STATUS_LABELS,row.code)
          || !UUID.test(row.account_ref) || !["KIWOOM","KIS"].includes(row.broker) || !["paper","live"].includes(row.account_type)
          || !Number.isFinite(Date.parse(row.checked_at)))) throw new Error("Invalid collection status");
        statuses = rows;
      } catch { statusUnavailable = true; }
      result = response({ series, statuses, statusUnavailable });
    } else {
      const keys = ["account_ref", "broker", "account_type", "currency", "scope"];
      if ([...params.keys()].some(key => ![...keys, "from", "before"].includes(key) || params.getAll(key).length !== 1)
        || !UUID.test(params.get("account_ref") ?? "") || !["KIWOOM", "KIS"].includes(params.get("broker") ?? "")
        || !["paper", "live"].includes(params.get("account_type") ?? "") || !["KRW", "USD"].includes(params.get("currency") ?? "")
        || !equitySource(params.get("broker"), params.get("currency"), params.get("scope"))
        || ["from", "before"].some(key => params.has(key) && !isDate(params.get(key)))) return response({ error: "계좌·기간 조건을 확인해 주세요." }, 400);
      const query = new URLSearchParams({ select: "payload,received_at", order: "date.desc", limit: "501" });
      for (const key of keys) query.set(key, `eq.${params.get(key)}`);
      if (params.has("from")) query.append("date", `gte.${params.get("from")}`);
      if (params.has("before")) query.append("date", `lt.${params.get("before")}`);
      const rows = await requestJson<{ payload: EquityInput; received_at: string }[]>("Supabase", `${supabaseUrl()}/rest/v1/account_equity_points?${query}`, { headers, cache: "no-store" }, { attempts: 1 });
      result = response({ points: rows.slice(0, 500).map(row => ({ ...row.payload, received_at: row.received_at })), next: rows.length > 500 ? rows[499].payload.date : null });
    }
    if (session.renewedTokens) applySessionCookies(result, session.renewedTokens);
    return result;
  } catch {
    return response({ error: "자산 이력을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  }
}
