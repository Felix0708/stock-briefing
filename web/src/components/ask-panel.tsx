"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";

import type { AskSuccessResponse, FilingSource } from "@/lib/ask-types";
import {
  CLIENT_REQUEST_TIMEOUT_MS,
  UserVisibleRequestError,
  getRequestErrorMessage,
  getRetrySeconds,
  parseRetryDeadline,
  type RequestAbortReason,
} from "@/lib/client/ask-request";

type AskResponse = Partial<AskSuccessResponse> & {
  error?: string | { code?: string; message?: string };
};

type ExecuteQuestionOptions = {
  preserveCompanyInput?: boolean;
};

const EXAMPLE_QUESTIONS = [
  "삼성전자의 최근 시설투자 내용은?",
  "현대차의 최근 배당 관련 공시를 요약해줘",
  "SK하이닉스의 자금 조달 내역이 있어?",
];

const POPULAR_COMPANIES = [
  "삼성전자",
  "SK하이닉스",
  "현대차",
  "LG에너지솔루션",
  "네이버",
  "카카오",
];

const MAX_QUESTION_LENGTH = 1_000;
const MAX_COMPANY_LENGTH = 100;
type ActiveRequest = {
  controller: AbortController;
  reason: RequestAbortReason;
  timeout: number;
};

function formatDate(value?: string) {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 8) return value;
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`;
}

function isSafeUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "dart.fss.or.kr" || url.hostname === "opendart.fss.or.kr")
    );
  } catch {
    return false;
  }
}

function SourceIcon() {
  return (
    <span className="source-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <path d="M7 3.5h7l4 4v13H7z" />
        <path d="M14 3.5v4h4M10 12h5M10 15.5h5" />
      </svg>
    </span>
  );
}

export function AskPanel() {
  const [question, setQuestion] = useState("");
  const [company, setCompany] = useState("");
  const [submittedQuestion, setSubmittedQuestion] = useState("");
  const [submittedCompany, setSubmittedCompany] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<FilingSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const [retryDeadline, setRetryDeadline] = useState<number | null>(null);
  const [collectState, setCollectState] = useState<"idle" | "requesting" | "collecting" | "failed">("idle");
  const [collectMessage, setCollectMessage] = useState<string | null>(null);
  const collectTimerRef = useRef<number | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const companyInputRef = useRef<HTMLInputElement>(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const isMountedRef = useRef(true);

  const selectedCompany = company.trim();
  const isRetryBlocked = retryAfterSeconds > 0;

  const toggleCompany = (name: string) => {
    if (isLoading) return;
    setCompany((current) => (current.trim() === name ? "" : name));
  };

  const clearCompany = () => {
    setCompany("");
    companyInputRef.current?.focus();
  };

  useEffect(() => {
    if (!isLoading && (answer || error)) {
      outcomeRef.current?.focus();
    }
  }, [answer, error, isLoading]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (collectTimerRef.current) window.clearInterval(collectTimerRef.current);
      const activeRequest = activeRequestRef.current;
      if (activeRequest) {
        activeRequest.reason = "unmount";
        window.clearTimeout(activeRequest.timeout);
        activeRequest.controller.abort();
        activeRequestRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (retryDeadline === null) return;

    const syncCountdown = () => {
      const remaining = getRetrySeconds(retryDeadline);
      setRetryAfterSeconds(remaining);
      if (remaining === 0) setRetryDeadline(null);
    };

    syncCountdown();
    const timer = window.setInterval(syncCountdown, 1_000);
    document.addEventListener("visibilitychange", syncCountdown);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncCountdown);
    };
  }, [retryDeadline]);

  const cancelRequest = () => {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;
    activeRequest.reason = "user";
    window.clearTimeout(activeRequest.timeout);
    activeRequest.controller.abort();
  };

  const executeQuestion = async (
    candidate: string,
    companyCandidate = company,
    options: ExecuteQuestionOptions = {},
  ) => {
    const trimmedQuestion = candidate.trim();
    const trimmedCompany = companyCandidate.trim();
    if (!trimmedQuestion || isLoading || isRetryBlocked) return;

    setQuestion(candidate);
    if (!options.preserveCompanyInput) {
      setCompany(companyCandidate);
    }
    setIsLoading(true);
    setIsRateLimited(false);
    setRetryAfterSeconds(0);
    setRetryDeadline(null);
    setSubmittedQuestion(trimmedQuestion);
    setSubmittedCompany(trimmedCompany);
    setError(null);
    setAnswer(null);
    setSources([]);
    setCollectState("idle");
    setCollectMessage(null);
    if (collectTimerRef.current) {
      window.clearInterval(collectTimerRef.current);
      collectTimerRef.current = null;
    }

    const controller = new AbortController();
    const activeRequest: ActiveRequest = {
      controller,
      reason: null,
      timeout: 0,
    };
    activeRequest.timeout = window.setTimeout(() => {
      if (!controller.signal.aborted) {
        activeRequest.reason = "timeout";
        controller.abort();
      }
    }, CLIENT_REQUEST_TIMEOUT_MS);
    activeRequestRef.current = activeRequest;

    try {
      const response = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          question: trimmedQuestion,
          ...(trimmedCompany ? { company: trimmedCompany } : {}),
        }),
      });
      const data = (await response.json().catch(() => ({}))) as AskResponse;

      if (!response.ok) {
        const apiMessage = typeof data.error === "string" ? data.error : data.error?.message;
        const apiCode = typeof data.error === "string" ? undefined : data.error?.code;
        if (response.status === 429 || apiCode === "RATE_LIMITED") {
          setIsRateLimited(true);
          const deadline = parseRetryDeadline(response.headers.get("Retry-After"));
          setRetryDeadline(deadline);
          setRetryAfterSeconds(getRetrySeconds(deadline));
        }
        throw new UserVisibleRequestError(
          apiMessage || "답변을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
        );
      }
      if (!data.answer) {
        throw new UserVisibleRequestError(
          "답변 내용이 비어 있습니다. 질문을 바꿔 다시 시도해 주세요.",
        );
      }

      setAnswer(data.answer);
      setSources(Array.isArray(data.sources) ? data.sources : []);
    } catch (requestError) {
      if (isMountedRef.current) {
        setError(getRequestErrorMessage(requestError, activeRequest.reason));
      }
    } finally {
      window.clearTimeout(activeRequest.timeout);
      if (activeRequestRef.current === activeRequest) activeRequestRef.current = null;
      if (isMountedRef.current) setIsLoading(false);
    }
  };

  // 온디맨드 수집: 미커버 종목의 공시를 그 자리에서 수집 요청하고,
  // 인덱싱이 끝나면(폴링으로 감지) 같은 질문을 자동으로 다시 실행한다.
  const requestCollect = async () => {
    const target = submittedCompany;
    if (!target || collectState === "requesting" || collectState === "collecting") return;
    setCollectState("requesting");
    setCollectMessage(null);
    try {
      const response = await fetch("/api/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: target }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        setCollectState("failed");
        setCollectMessage(data.error ?? "수집 요청에 실패했습니다.");
        return;
      }
      setCollectState("collecting");
      setCollectMessage(data.message ?? "수집을 시작했습니다.");

      let attempts = 0;
      collectTimerRef.current = window.setInterval(() => {
        void (async () => {
          attempts += 1;
          try {
            const res = await fetch(`/api/coverage?company=${encodeURIComponent(target)}`);
            const cov = (await res.json().catch(() => ({}))) as { covered?: boolean };
            if (cov.covered) {
              if (collectTimerRef.current) window.clearInterval(collectTimerRef.current);
              collectTimerRef.current = null;
              if (!isMountedRef.current) return;
              setCollectState("idle");
              setCollectMessage(null);
              void executeQuestion(submittedQuestion || question, target);
              return;
            }
          } catch {
            // 일시 오류는 다음 폴링에서 재시도
          }
          if (attempts >= 18) {
            if (collectTimerRef.current) window.clearInterval(collectTimerRef.current);
            collectTimerRef.current = null;
            if (!isMountedRef.current) return;
            setCollectState("failed");
            setCollectMessage("수집이 오래 걸리고 있습니다. 몇 분 뒤 같은 질문을 다시 시도해 보세요.");
          }
        })();
      }, 20_000);
    } catch {
      setCollectState("failed");
      setCollectMessage("수집 요청에 실패했습니다.");
    }
  };

  const submitQuestion = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void executeQuestion(question);
  };

  return (
    <section className="ask-section" aria-label="공시 질문과 답변">
      <form className="question-card" onSubmit={submitQuestion} aria-busy={isLoading}>
        <div className="company-filter">
          <label htmlFor="company">
            검색 종목 <span>선택</span>
          </label>
          <div className="company-input-wrap">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="6" />
              <path d="m16 16 4 4" />
            </svg>
            <input
              id="company"
              name="company"
              type="text"
              ref={companyInputRef}
              value={company}
              onChange={(event) => setCompany(event.target.value)}
              placeholder="예: 삼성전자"
              maxLength={MAX_COMPANY_LENGTH}
              disabled={isLoading}
              aria-describedby="company-help"
              autoComplete="off"
            />
            {company && !isLoading && (
              <button
                type="button"
                className="company-clear"
                onClick={clearCompany}
                aria-label="검색 종목 지우기"
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </div>
          <div
            className="company-quick"
            role="group"
            aria-label="자주 찾는 종목 빠른 선택"
          >
            {POPULAR_COMPANIES.map((name) => {
              const active = selectedCompany === name;
              return (
                <button
                  type="button"
                  key={name}
                  className={active ? "company-chip is-active" : "company-chip"}
                  aria-pressed={active}
                  disabled={isLoading}
                  onClick={() => toggleCompany(name)}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <p id="company-help">
            종목을 선택하거나 직접 입력할 수 있어요. 비워 두면 전체 종목의 공시에서
            검색합니다.
          </p>
        </div>

        <label htmlFor="question">공시에 대해 무엇이 궁금한가요?</label>
        <div className="question-input-wrap">
          <textarea
            id="question"
            name="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="예: 삼성전자의 최근 시설투자 규모와 목적은?"
            rows={3}
            maxLength={MAX_QUESTION_LENGTH}
            disabled={isLoading}
            aria-describedby="question-help question-count"
          />
          <span id="question-count" className="character-count">
            {question.length}/{MAX_QUESTION_LENGTH}
          </span>
        </div>
        <div className="form-actions">
          <p id="question-help">Enter로 질문 · Shift + Enter로 줄바꿈</p>
          <button type="submit" disabled={!question.trim() || isLoading || isRetryBlocked}>
            {isLoading ? (
              <>
                <span className="spinner" aria-hidden="true" />
                공시 찾는 중
              </>
            ) : (
              <>
                질문하기
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 18 6-6-6-6" />
                </svg>
              </>
            )}
          </button>
        </div>
      </form>

      {!answer && !error && !isLoading && (
        <div className="examples" aria-label="질문 예시">
          <p>이렇게 물어보세요</p>
          <div className="example-list">
            {EXAMPLE_QUESTIONS.map((example) => (
              <button
                key={example}
                type="button"
                disabled={isRetryBlocked}
                onClick={() =>
                  void executeQuestion(example, "", { preserveCompanyInput: true })
                }
              >
                <span aria-hidden="true">↗</span>
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {isLoading && (
        <div className="status-card loading-card" role="status" aria-live="polite">
          <span className="loading-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <div>
            <strong>관련 공시를 찾고 있습니다</strong>
            <p>
              {submittedCompany ? `${submittedCompany}의 ` : "전체 종목의 "}
              공시 원문을 확인하고 답변을 정리합니다.
            </p>
          </div>
          <button type="button" className="cancel-request" onClick={cancelRequest}>
            요청 취소
          </button>
        </div>
      )}

      {error && (
        <div className="status-card error-card" role="alert" ref={outcomeRef} tabIndex={-1}>
          <span className="error-icon" aria-hidden="true">!</span>
          <div>
            <strong>{isRateLimited ? "요청이 잠시 제한되었습니다" : "답변을 가져오지 못했습니다"}</strong>
            <p>{error}</p>
            {isRateLimited && (
              <p className="retry-countdown" aria-live="off">
                {isRetryBlocked
                  ? `${retryAfterSeconds}초 후 다시 시도할 수 있습니다.`
                  : "이제 다시 시도할 수 있습니다."}
              </p>
            )}
          </div>
          <button
            type="button"
            disabled={isRetryBlocked}
            onClick={() =>
              void executeQuestion(submittedQuestion || question, submittedCompany)
            }
          >
            다시 시도
          </button>
        </div>
      )}

      {answer && sources.length === 0 && (
        <div
          className="status-card empty-card"
          role="status"
          aria-live="polite"
          ref={outcomeRef}
          tabIndex={-1}
        >
          <span className="empty-icon" aria-hidden="true">?</span>
          <div>
            <strong>관련 공시를 찾지 못했습니다</strong>
            <p>{answer}</p>
            {submittedCompany && (
              <p className="empty-filter-hint">
                &apos;{submittedCompany}&apos;으로 좁혀 검색했습니다. 종목명을 확인하거나
                필터를 지우고 전체 공시에서 다시 검색해 보세요.
              </p>
            )}
          </div>
          {submittedCompany && (
            <button
              type="button"
              className="empty-retry"
              aria-label="필터를 지우고 전체 공시에서 다시 검색"
              onClick={() =>
                void executeQuestion(submittedQuestion || question, "")
              }
            >
              필터 지우고 다시 검색
            </button>
          )}
          {submittedCompany && (
            <div className="collect-box">
              {collectState === "collecting" ? (
                <p className="collect-status">
                  <span className="spinner" aria-hidden="true" /> {collectMessage} 완료되면
                  자동으로 다시 검색합니다.
                </p>
              ) : (
                <button
                  type="button"
                  className="empty-retry collect-btn"
                  disabled={collectState === "requesting"}
                  onClick={() => void requestCollect()}
                >
                  {collectState === "requesting"
                    ? "요청 중..."
                    : `'${submittedCompany}' 공시 지금 수집하기 (2~5분)`}
                </button>
              )}
              {collectState === "failed" && collectMessage && (
                <p className="collect-error">{collectMessage}</p>
              )}
            </div>
          )}
        </div>
      )}

      {answer && sources.length > 0 && (
        <div className="result" aria-live="polite" ref={outcomeRef} tabIndex={-1}>
          <article className="answer-card">
            <div className="answer-heading">
              <span className="answer-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M12 3 13.7 8.3 19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
                  <path d="m18.5 16 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7z" />
                </svg>
              </span>
              <div>
                <span>AI 답변 · {submittedCompany || "전체 종목"}</span>
                <h2>{submittedQuestion}</h2>
              </div>
            </div>
            <div className="answer-body">{answer}</div>
          </article>

          <section className="sources" aria-labelledby="sources-title">
            <div className="sources-heading">
              <h2 id="sources-title">답변에 참고한 공시</h2>
              <span>{sources.length}건</span>
            </div>
            {sources.length > 0 ? (
              <div className="source-list">
                {sources.map((source, index) => {
                  const title = source.reportName || "공시 원문";
                  const date = formatDate(source.receiptDate);
                  const sourceUrl = isSafeUrl(source.url) ? source.url : null;
                  const content = (
                    <>
                      <SourceIcon />
                      <span className="source-copy">
                        <strong>{title}</strong>
                        <span>
                          {[source.company, date].filter(Boolean).join(" · ") || "DART 공시"}
                        </span>
                      </span>
                      {sourceUrl && (
                        <svg className="external-icon" viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M14 5h5v5M19 5l-8 8M18 13v6H5V6h6" />
                        </svg>
                      )}
                    </>
                  );

                  return sourceUrl ? (
                    <a
                      className="source-item"
                      href={sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${title} DART 원문 보기 (새 창)`}
                      key={`${source.id || sourceUrl}-${index}`}
                    >
                      {content}
                    </a>
                  ) : (
                    <div className="source-item" key={`${source.id || title}-${index}`}>
                      {content}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="no-sources">표시할 수 있는 출처 정보가 없습니다.</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
