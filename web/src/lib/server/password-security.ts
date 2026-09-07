import "server-only";

import { createHash } from "node:crypto";

export class PasswordSecurityError extends Error {
  constructor(message: string, readonly status: 400 | 503) {
    super(message);
  }
}

export async function requireSafeSignupPassword(password: string): Promise<void> {
  // SHA-1 is only the HIBP lookup protocol, never password storage.
  const digest = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  let compromised = false;
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${digest.slice(0, 5)}`, {
      headers: { "Add-Padding": "true", "User-Agent": "Stock-Briefing password screening" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Password screening unavailable");
    const lines = (await response.text()).trim().split(/\r?\n/);
    for (const line of lines) {
      const match = /^([A-F0-9]{35}):(\d+)$/i.exec(line);
      if (!match) throw new Error("Invalid password screening response");
      if (match[1].toUpperCase() === digest.slice(5) && Number(match[2]) > 0) {
        compromised = true;
      }
    }
  } catch {
    // Fail closed for new signups; existing logins do not use this check.
    throw new PasswordSecurityError("비밀번호 안전성 확인이 지연되고 있습니다. 잠시 후 다시 가입해 주세요.", 503);
  }
  if (compromised) {
    throw new PasswordSecurityError("유출 이력이 있는 비밀번호입니다. 다른 비밀번호로 가입해 주세요.", 400);
  }
}
