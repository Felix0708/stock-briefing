import assert from "node:assert/strict";
import test from "node:test";

import { NextRequest } from "next/server";

import { GET } from "../src/app/api/quotes/route.ts";

const ORIGINAL_FETCH = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

test("접미사 없는 미국 시세 코드도 조회한다", async () => {
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === "https://api.stock.naver.com/stock/SE/basic") {
      return Response.json({
        stockName: "씨 ADR",
        closePrice: "114.13",
        fluctuationsRatio: "1.17",
      });
    }
    if (value === "https://api.stock.naver.com/stock/STM/basic") {
      return Response.json({
        stockName: "ST 마이크로 일렉트로닉스 ADR",
        closePrice: "49.97",
        fluctuationsRatio: "-1.46",
      });
    }
    return new Response(null, { status: 404 });
  };

  const response = await GET(
    new NextRequest("http://localhost/api/quotes?codes=US%3ASE%2CUS%3ASTM"),
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.quotes["US:SE"].price, 114.13);
  assert.equal(payload.quotes["US:STM"].price, 49.97);
});
