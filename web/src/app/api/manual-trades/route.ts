import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies, fetchUser, getSession, supabaseUrl, userHeaders } from "@/lib/server/auth";
import { serviceRest } from "@/lib/server/holdings-integration";
import { requestJson, UpstreamError } from "@/lib/server/http";
import { isManualBroker } from "@/lib/holding-brokers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const keys = ["request_id","market","stock_code","stock_name","broker","side","quantity","price","traded_on"];
const patterns = { KR: /^[0-9]{6}$/, US: /^[A-Z][A-Z0-9.\-]{0,9}$/, JP: /^[0-9A-Z]{4,5}$/ };

function validTrade(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || !keys.every((key) => key in row)) return false;
  const market = row.market as keyof typeof patterns;
  return Object.hasOwn(patterns, market) && typeof row.stock_code === "string" && patterns[market].test(row.stock_code)
    && typeof row.stock_name === "string" && row.stock_name.trim().length > 0 && row.stock_name.length <= 50
    && (isManualBroker(row.broker) || row.broker === "MANUAL") && (row.side === "BUY" || row.side === "SELL")
    && typeof row.request_id === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.request_id)
    && typeof row.quantity === "number" && Number.isFinite(row.quantity) && row.quantity > 0 && row.quantity <= 1e8
    && Number(row.quantity.toFixed(4)) === row.quantity
    && typeof row.price === "number" && Number.isFinite(row.price) && row.price > 0 && row.price <= 1e12
    && Number(row.price.toFixed(8)) === row.price
    && typeof row.traded_on === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.traded_on)
    && Number.isFinite(Date.parse(row.traded_on)) && new Date(row.traded_on).toISOString().startsWith(row.traded_on);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const before = req.nextUrl.searchParams.get("before");
    const tradeId = req.nextUrl.searchParams.get("trade_id");
    if (before && !/^\d{1,16}$/.test(before)) return NextResponse.json({ error: "페이지를 확인해 주세요." }, { status: 400 });
    const headers = userHeaders(session.accessToken);
    if (tradeId) {
      if (!/^\d{1,16}$/.test(tradeId)) return NextResponse.json({ error: "거래를 확인해 주세요." }, { status: 400 });
      const rows = await requestJson<{id: number}[]>("Supabase", `${supabaseUrl()}/rest/v1/manual_trade_revisions?trade_id=eq.${tradeId}&select=id,previous,updated,reason,created_at&order=id.desc&limit=51${before ? `&id=lt.${before}` : ""}`, { headers }, { attempts: 1 });
      const response = NextResponse.json({ revisions: rows.slice(0,50), next: rows.length > 50 ? rows[49].id : null }, { headers: {"Cache-Control":"no-store"} });
      if (session.renewedTokens) applySessionCookies(response, session.renewedTokens);
      return response;
    }
    const [trades, summary] = await Promise.all([
      requestJson<{ id: number }[]>("Supabase", `${supabaseUrl()}/rest/v1/manual_trades?select=id,request_id,market,stock_code,stock_name,broker,side,quantity,price,cost_basis,realized_profit_loss,quantity_after,avg_price_after,traded_on,created_at,revision,cancelled,original_input&order=id.desc&limit=51${before ? `&id=lt.${before}` : ""}`, { headers }, { attempts: 1 }),
      requestJson("Supabase", `${supabaseUrl()}/rest/v1/rpc/manual_trade_summary`, { headers, method: "POST", body: "{}" }, { attempts: 1 }),
    ]);
    const response = NextResponse.json({ trades: trades.slice(0,50), summary, next: trades.length > 50 ? trades[49].id : null }, { headers: {"Cache-Control":"no-store"} });
    if (session.renewedTokens) applySessionCookies(response, session.renewedTokens);
    return response;
  } catch {
    return NextResponse.json({ error: "매매 이력을 불러오지 못했습니다." }, { status: 502 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return writeTrade(req, false);
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  return writeTrade(req, true);
}

async function writeTrade(req: NextRequest, correcting: boolean): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const user = await fetchUser(session.accessToken);
    if (!user) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const trade = await req.json().catch(() => null);
    const valid = correcting
      ? trade && Object.keys(trade).length === 6 && Number.isSafeInteger(trade.trade_id) && trade.trade_id > 0
        && Number.isSafeInteger(trade.expected_revision) && trade.expected_revision > 0 && typeof trade.cancelled === "boolean"
        && typeof trade.reason === "string" && trade.reason.trim().length > 0 && trade.reason.length <= 500
        && trade.trade && Object.keys(trade.trade).length === 8 && validTrade({...trade.trade, request_id:trade.request_id})
      : validTrade(trade);
    if (!valid) return NextResponse.json({ error: "거래 입력과 정정 사유를 확인해 주세요. 수량은 소수 4자리, 가격은 소수 8자리까지 가능합니다." }, { status: 400 });
    const recorded = await serviceRest(correcting ? "rpc/revise_manual_trade" : "rpc/record_manual_trade", { method: "POST", body: JSON.stringify({ target_user_id: user.id, [correcting ? "change" : "trade"]: trade }) });
    const response = NextResponse.json({ ok: true, trade: recorded });
    if (session.renewedTokens) applySessionCookies(response, session.renewedTokens);
    return response;
  } catch (error) {
    const rejected = error instanceof UpstreamError && (error.status === 400 || error.status === 409);
    return NextResponse.json({ error: rejected ? "저장하지 못했습니다. 이후 거래의 잔고가 부족해지거나 다른 화면에서 거래가 변경됐을 수 있습니다. 이력을 새로 조회한 뒤 수량·거래일을 확인해 주세요." : "처리 결과를 확인하지 못했습니다. 같은 입력으로 재시도해 주세요. 중복 거래는 기록되지 않습니다." }, { status: rejected ? 400 : 502 });
  }
}
