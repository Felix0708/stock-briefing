import "server-only";

export type ServerConfig = {
  geminiApiKey: string;
  answerModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  supabaseUrl: string;
  supabaseSecretKey: string;
  matchCount: number;
  minimumSimilarity: number;
};

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigurationError(`필수 서버 환경변수 ${name}가 없습니다.`);
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ConfigurationError(`${name}은 숫자여야 합니다.`);
  }
  return value;
}

export function getServerConfig(): ServerConfig {
  const supabaseUrl = required("SUPABASE_URL").replace(/\/+$/, "");
  try {
    const parsedUrl = new URL(supabaseUrl);
    const isLocal = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
    if (parsedUrl.protocol !== "https:" && !isLocal) {
      throw new Error("insecure protocol");
    }
  } catch {
    throw new ConfigurationError("SUPABASE_URL은 HTTPS 주소여야 합니다.");
  }

  const embeddingDimension = numberFromEnv("EMBEDDING_DIM", 768);
  const matchCount = numberFromEnv("RAG_MATCH_COUNT", 8);
  const minimumSimilarity = numberFromEnv("RAG_MIN_SIMILARITY", 0.35);

  if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0) {
    throw new ConfigurationError("EMBEDDING_DIM은 양의 정수여야 합니다.");
  }
  if (!Number.isInteger(matchCount) || matchCount < 1 || matchCount > 20) {
    throw new ConfigurationError("RAG_MATCH_COUNT는 1~20 사이의 정수여야 합니다.");
  }
  if (minimumSimilarity < -1 || minimumSimilarity > 1) {
    throw new ConfigurationError("RAG_MIN_SIMILARITY는 -1~1 사이여야 합니다.");
  }

  return {
    geminiApiKey: required("GEMINI_API_KEY"),
    answerModel:
      process.env.GEMINI_ANSWER_MODEL?.trim() ||
      process.env.GEMINI_MODEL?.trim() ||
      "gemini-2.5-flash-lite",
    embeddingModel:
      process.env.EMBEDDING_MODEL?.trim() || "gemini-embedding-001",
    embeddingDimension,
    supabaseUrl,
    supabaseSecretKey: required("SUPABASE_SECRET_KEY"),
    matchCount,
    minimumSimilarity,
  };
}
