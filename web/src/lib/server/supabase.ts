import "server-only";

import type { ServerConfig } from "./config";
import { UpstreamError, requestJson } from "./http";

export type FilingMatch = {
  company: string;
  report_nm: string | null;
  rcept_dt: string | null;
  url: string | null;
  content: string;
  similarity: number;
};

function isFilingMatch(value: unknown): value is FilingMatch {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.company === "string" &&
    (typeof row.report_nm === "string" || row.report_nm === null) &&
    (typeof row.rcept_dt === "string" || row.rcept_dt === null) &&
    (typeof row.url === "string" || row.url === null) &&
    typeof row.content === "string" &&
    typeof row.similarity === "number" &&
    Number.isFinite(row.similarity)
  );
}

export async function matchFilings(
  queryEmbedding: number[],
  company: string | undefined,
  config: ServerConfig,
): Promise<FilingMatch[]> {
  const headers: Record<string, string> = {
    apikey: config.supabaseSecretKey,
    "Content-Type": "application/json",
  };

  // Opaque sb_secret_ keys are API keys, not JWTs. Legacy service_role JWTs
  // still need the bearer header for PostgREST role authentication.
  if (!config.supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${config.supabaseSecretKey}`;
  }

  const response = await requestJson<unknown>(
    "Supabase",
    `${config.supabaseUrl}/rest/v1/rpc/match_filings`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query_embedding: queryEmbedding,
        match_count: config.matchCount,
        filter_company: company || null,
        match_threshold: config.minimumSimilarity,
      }),
    },
  );

  if (!Array.isArray(response) || !response.every(isFilingMatch)) {
    throw new UpstreamError("Supabase", undefined, "검색 결과 형식이 올바르지 않습니다.");
  }
  return response;
}
