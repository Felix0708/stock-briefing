export type AskRequest = {
  question: string;
  company?: string;
};

export type FilingSource = {
  id: string;
  company: string;
  reportName: string;
  receiptDate: string;
  url: string | null;
  similarity: number;
};

export type AskSuccessResponse = {
  answer: string;
  sources: FilingSource[];
  meta: {
    retrievedChunks: number;
    answerModel: string;
  };
};

export type AskErrorCode =
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "RATE_LIMIT_UNAVAILABLE"
  | "CONFIGURATION_ERROR"
  | "UPSTREAM_ERROR"
  | "INTERNAL_ERROR";

export type AskErrorResponse = {
  error: {
    code: AskErrorCode;
    message: string;
  };
};
