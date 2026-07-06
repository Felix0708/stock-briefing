import "server-only";

import type { AskSuccessResponse, FilingSource } from "../ask-types";
import { getServerConfig } from "./config";
import {
  embedQuestion,
  generateGroundedAnswer,
  type GroundingChunk,
} from "./gemini";
import { matchFilings, type FilingMatch } from "./supabase";

function formatReceiptDate(value: string | null): string {
  if (!value) return "날짜 미상";
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

function normalizeDartUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const allowedHosts = new Set(["dart.fss.or.kr", "opendart.fss.or.kr"]);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function buildGroundingChunks(
  rows: Array<FilingMatch & { safeUrl: string }>,
): GroundingChunk[] {
  const sourceByKey = new Map<string, FilingSource>();

  return rows.map((row) => {
    const key = row.safeUrl;
    let source = sourceByKey.get(key);
    if (!source) {
      source = {
        id: `S${sourceByKey.size + 1}`,
        company: row.company,
        reportName: row.report_nm || "공시명 미상",
        receiptDate: formatReceiptDate(row.rcept_dt),
        url: row.safeUrl,
        similarity: row.similarity,
      };
      sourceByKey.set(key, source);
    } else if (row.similarity > source.similarity) {
      source.similarity = row.similarity;
    }

    return { source, content: row.content };
  });
}

export async function answerQuestion(
  question: string,
  company?: string,
): Promise<AskSuccessResponse> {
  const config = getServerConfig();
  const embedding = await embedQuestion(question, config);
  const matches = (await matchFilings(embedding, company, config)).flatMap((row) => {
    const safeUrl = normalizeDartUrl(row.url);
    return row.similarity >= config.minimumSimilarity && safeUrl
      ? [{ ...row, safeUrl }]
      : [];
  });

  if (matches.length === 0) {
    return {
      answer:
        "질문과 충분히 관련된 공시 근거를 찾지 못했습니다. 기업명이나 공시 내용을 더 구체적으로 질문해 주세요.",
      sources: [],
      meta: { retrievedChunks: 0, answerModel: config.answerModel },
    };
  }

  const chunks = buildGroundingChunks(matches);
  const sources = [...new Map(chunks.map((chunk) => [chunk.source.id, chunk.source])).values()];
  const answer = await generateGroundedAnswer(question, chunks, config);

  return {
    answer,
    sources,
    meta: {
      retrievedChunks: matches.length,
      answerModel: config.answerModel,
    },
  };
}
