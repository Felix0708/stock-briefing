import { expect, test } from "@playwright/test";

test("real proxy blocks forged requests while browser-origin validation reaches the route", async ({ page, request }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/portfolio");
  await expect(page.getByRole("button", { name: "회원가입", exact: true })).toBeVisible();
  await expect(page.getByText(/해시 앞 5글자만/)).toBeVisible();
  await expect(page.locator("[data-nextjs-dialog]")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("signup-security.png"), fullPage: true });
  for (const origin of [undefined, "null", "https://untrusted.invalid"]) {
    const response = await request.post("/api/auth/login", {
      headers: { "Content-Type": "text/plain", ...(origin ? { Origin: origin } : {}) },
      data: '{"email":"audit@example.com","password":"AuditOnly123!","padding":"="}\r\n',
    });
    expect(response.status()).toBe(403);
    expect(response.headers()["set-cookie"]).toBeUndefined();
  }
  // No credentials are sent to Auth: invalid inputs stop in the route after Proxy.
  const sameOrigin = await page.evaluate(async () => {
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { status: response.status, body: await response.json() };
  });
  expect(sameOrigin.status).toBe(400);
  expect(sameOrigin.body.error).toContain("이메일");
  const sync = await request.put("/api/sync/holdings", { data: {} });
  expect(sync.status()).toBe(401);
  const equity = await request.put("/api/sync/account-equity", { data: { version: 1, series: [] } });
  expect(equity.status()).toBe(401);
  expect(equity.headers()["set-cookie"]).toBeUndefined();
  expect((await request.get("/api/account-equity")).status()).toBe(401);
  expect(errors).toEqual([]);
  await page.goto("/");
  await expect(page.locator("body")).not.toHaveText("");
});
