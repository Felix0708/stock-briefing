// Explicit opt-in only: creates one temporary, non-subscribing QA account and deletes it.
// No mail, real user balances, broker orders, or sync tokens are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

assert.equal(process.env.ALLOW_TEMP_QA_USER, "1", "Set ALLOW_TEMP_QA_USER=1 to allow isolated test writes");
process.loadEnvFile(process.env.QA_ENV_FILE ?? ".env");
const site = process.argv[2];
assert.ok(site && (site.startsWith("https://") || site.startsWith("http://127.0.0.1:")), "Supply the site URL");
const database = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY;
assert.ok(database && key, "Missing server QA configuration");
const adminHeaders = { apikey: key, "Content-Type": "application/json", ...(!key.startsWith("sb_secret_") ? { Authorization: `Bearer ${key}` } : {}) };
let userId;
let cookie = "";
const password = randomUUID() + "Aa1!";
const email = `portfolio-qa-${randomUUID()}@example.com`;

async function call(path, method = "GET", body, expected = 200) {
  const response = await fetch(site + path, { method, headers: { "Content-Type": "application/json", Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  assert.equal(response.status, expected, `${method} ${path} returned unexpected status`);
  if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
  return response.json();
}
try {
  await call("/api/manual-trades", "GET", undefined, 401);
  await call("/api/briefing-status", "GET", undefined, 401);
  const created = await fetch(`${database}/auth/v1/admin/users`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { briefing_email: false } }), signal: AbortSignal.timeout(20000) });
  assert.equal(created.status, 200, "Could not create isolated QA account");
  userId = (await created.json()).id;
  assert.ok(userId, "Missing QA account ID");
  await call("/api/auth/login", "POST", { email, password });
  const position = { market: "US", stock_code: "TEST", stock_name: "격리 검증용", broker: "KIWOOM", quantity: 10, avg_price: 100 };
  await call("/api/holdings", "POST", position);
  const trade = { request_id: randomUUID(), market: position.market, stock_code: position.stock_code, stock_name: position.stock_name, broker: position.broker, side: "BUY", quantity: 5, price: 130, traded_on: new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }) };
  const bought = await call("/api/manual-trades", "POST", trade);
  assert.equal(bought.trade.quantity_after, 15);
  assert.equal(bought.trade.avg_price_after, 110);
  const duplicate = await call("/api/manual-trades", "POST", trade);
  assert.equal(duplicate.trade.id, bought.trade.id);
  const sold = await call("/api/manual-trades", "POST", { ...trade, request_id: randomUUID(), side: "SELL", quantity: 3, price: 150 });
  assert.equal(sold.trade.realized_profit_loss, 120);
  await call("/api/manual-trades", "POST", { ...trade, request_id: randomUUID(), side: "SELL", quantity: 13 }, 400);
  await call("/api/manual-trades", "POST", { ...trade, user_id: randomUUID() }, 400);
  const history = await call("/api/manual-trades");
  assert.equal(history.trades.length, 2);
  assert.equal(history.summary[0].profit_loss, 120);
  const status = await call("/api/briefing-status");
  assert.equal(status.emailEnabled, false);
  assert.equal(status.delivery, null);
  await call("/api/holdings?code=TEST&market=US&broker=KIWOOM&quantity=10&avg_price=110", "DELETE", undefined, 409);
  await call("/api/holdings?code=TEST&market=US&broker=KIWOOM&quantity=12&avg_price=110", "DELETE");
  assert.equal((await call("/api/holdings")).holdings.length, 0);
  assert.equal((await call("/api/manual-trades")).trades.length, 2);
  console.log("PASS: live auth, baseline, buy/sell, idempotency, oversell rejection, history, status and guarded deletion");
} finally {
  if (userId) {
    const removed = await fetch(`${database}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: adminHeaders, signal: AbortSignal.timeout(20000) });
    if (!removed.ok) throw new Error(`QA cleanup required for temporary user ${userId}`);
    console.log("PASS: temporary QA account and its test data removed");
  }
}
