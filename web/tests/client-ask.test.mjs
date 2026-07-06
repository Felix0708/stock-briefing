import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  UserVisibleRequestError,
  getRequestErrorMessage,
  getRetrySeconds,
  parseRetryDeadline,
} from "../src/lib/client/ask-request.ts";

test("Retry-After 초와 HTTP-date를 절대 마감 시각으로 변환한다", () => {
  const now = Date.parse("2026-07-05T12:00:00.000Z");

  assert.equal(parseRetryDeadline("2.1", now), now + 3_000);
  assert.equal(
    parseRetryDeadline("Sun, 05 Jul 2026 12:00:09 GMT", now),
    now + 9_000,
  );
  assert.equal(parseRetryDeadline("invalid", now), now + 60_000);
});

test("백그라운드 지연 후에도 실제 경과 시간으로 남은 초를 계산한다", () => {
  const deadline = 100_000;

  assert.equal(getRetrySeconds(deadline, 95_001), 5);
  assert.equal(getRetrySeconds(deadline, 100_000), 0);
  assert.equal(getRetrySeconds(deadline, 130_000), 0);
});

test("API의 안전한 메시지만 유지하고 transport 오류는 한국어로 정규화한다", () => {
  assert.equal(
    getRequestErrorMessage(new UserVisibleRequestError("안전한 API 오류"), null),
    "안전한 API 오류",
  );
  assert.equal(
    getRequestErrorMessage(new TypeError("Failed to fetch"), null),
    "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
  );
  assert.equal(
    getRequestErrorMessage(new DOMException("aborted", "AbortError"), "timeout"),
    "요청 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
  );
  assert.equal(
    getRequestErrorMessage(new DOMException("aborted", "AbortError"), "user"),
    "요청을 취소했습니다.",
  );
});

test("AskPanel이 deadline 동기화와 요청 취소 signal을 실제 요청 흐름에 연결한다", async () => {
  const source = await readFile(
    new URL("../src/components/ask-panel.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /document\.addEventListener\("visibilitychange", syncCountdown\)/);
  assert.match(source, /isMountedRef\.current = true/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /activeRequest\.reason = "timeout"/);
  assert.match(source, /activeRequest\.reason = "user"/);
  assert.match(source, />\s*요청 취소\s*</);
});

test("라이트 모드 보조 텍스트가 실제 배경에서 AA 4.5:1 이상이다", async () => {
  const css = await readFile(
    new URL("../src/app/globals.css", import.meta.url),
    "utf8",
  );
  const muted = css.match(/--text-muted:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(muted, "--text-muted 색상 토큰이 필요합니다.");

  const channel = (hex) =>
    hex.match(/[0-9a-f]{2}/gi).map((value) => {
      const normalized = Number.parseInt(value, 16) / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
  const luminance = (hex) => {
    const [red, green, blue] = channel(hex);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const contrast = (foreground, background) => {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return (lighter + 0.05) / (darker + 0.05);
  };

  for (const background of ["#ffffff", "#f8fafc", "#f5f7fa"]) {
    assert.ok(
      contrast(muted, background) >= 4.5,
      `${muted} / ${background} 대비가 4.5:1 미만입니다.`,
    );
  }
});
