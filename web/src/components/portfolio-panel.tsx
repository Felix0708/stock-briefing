"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";

type Holding = {
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
};

type Quote = {
  code: string;
  name: string | null;
  price: number;
  changeRatio: number;
};

type SessionUser = { email: string } | null;

// watchlist.yaml의 8종목 — 빠른 등록용 프리셋
const PRESETS: { code: string; name: string }[] = [
  { code: "000660", name: "SK하이닉스" },
  { code: "017670", name: "SK텔레콤" },
  { code: "096770", name: "SK이노베이션" },
  { code: "035420", name: "NAVER" },
  { code: "005930", name: "삼성전자" },
  { code: "108490", name: "로보티즈" },
  { code: "004020", name: "현대제철" },
  { code: "009830", name: "한화솔루션" },
];

const PIE_COLORS = [
  "#2563eb", "#f59e0b", "#10b981", "#ef4444",
  "#8b5cf6", "#06b6d4", "#f97316", "#84cc16",
  "#ec4899", "#64748b",
];

function formatKrw(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("ko-KR")}`;
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function plClass(value: number): string {
  if (value > 0) return "pf-gain";
  if (value < 0) return "pf-loss";
  return "";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? "요청에 실패했습니다.");
  }
  return data;
}

export function PortfolioPanel() {
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<SessionUser>(null);

  // 로그인 폼
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // 보유 종목
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesAsOf, setQuotesAsOf] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // 등록 폼
  const [selectedPreset, setSelectedPreset] = useState<string>(PRESETS[0].code);
  const [customCode, setCustomCode] = useState("");
  const [customName, setCustomName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isCustom = selectedPreset === "custom";

  const loadQuotes = useCallback(async (rows: Holding[]) => {
    if (rows.length === 0) {
      setQuotes({});
      setQuotesAsOf(null);
      return;
    }
    try {
      const codes = rows.map((row) => row.stock_code).join(",");
      const data = await api<{ quotes: Record<string, Quote>; asOf: string }>(
        `/api/quotes?codes=${codes}`,
      );
      setQuotes(data.quotes);
      setQuotesAsOf(data.asOf);
    } catch {
      // 시세 실패는 치명적이지 않다 — 표에서 "시세 없음"으로 표시
    }
  }, []);

  const loadHoldings = useCallback(async () => {
    setListBusy(true);
    setListError(null);
    try {
      const data = await api<{ holdings: Holding[] }>("/api/holdings");
      setHoldings(data.holdings);
      await loadQuotes(data.holdings);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.");
    } finally {
      setListBusy(false);
    }
  }, [loadQuotes]);

  // 세션 확인
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ user: SessionUser }>("/api/auth/me");
        if (!cancelled) setUser(data.user);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (user) void loadHoldings();
  }, [user, loadHoldings]);

  async function handleAuth(event: FormEvent, mode: "login" | "signup") {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError(null);
    setAuthMessage(null);
    try {
      if (mode === "signup") {
        const data = await api<{ needsEmailConfirm: boolean; message?: string }>(
          "/api/auth/signup",
          { method: "POST", body: JSON.stringify({ email, password }) },
        );
        if (data.needsEmailConfirm) {
          setAuthMessage(data.message ?? "확인 메일을 확인해 주세요.");
          return;
        }
      } else {
        await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email, password }),
        });
      }
      const me = await api<{ user: SessionUser }>("/api/auth/me");
      setUser(me.user);
      setPassword("");
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "요청에 실패했습니다.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    setHoldings([]);
    setQuotes({});
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setFormBusy(true);
    setFormError(null);

    const preset = PRESETS.find((row) => row.code === selectedPreset);
    const stockCode = isCustom ? customCode.trim() : preset?.code ?? "";
    const stockName = isCustom ? customName.trim() : preset?.name ?? "";

    try {
      await api("/api/holdings", {
        method: "POST",
        body: JSON.stringify({
          stock_code: stockCode,
          stock_name: stockName,
          quantity: Number(quantity),
          avg_price: Number(avgPrice),
        }),
      });
      setQuantity("");
      setAvgPrice("");
      setCustomCode("");
      setCustomName("");
      await loadHoldings();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "등록에 실패했습니다.");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(code: string) {
    try {
      await api(`/api/holdings?code=${code}`, { method: "DELETE" });
      await loadHoldings();
    } catch (error) {
      setListError(error instanceof Error ? error.message : "삭제에 실패했습니다.");
    }
  }

  // ---------- 계산 ----------
  const computed = useMemo(() => {
    const rows = holdings.map((holding) => {
      const quote = quotes[holding.stock_code] ?? null;
      const cost = holding.quantity * holding.avg_price;
      const value = quote ? holding.quantity * quote.price : null;
      const pl = value !== null ? value - cost : null;
      const plRatio = pl !== null && cost > 0 ? (pl / cost) * 100 : null;
      return { holding, quote, cost, value, pl, plRatio };
    });

    const totalCost = rows.reduce((sum, row) => sum + row.cost, 0);
    const priced = rows.filter((row) => row.value !== null);
    const totalValue = priced.reduce((sum, row) => sum + (row.value ?? 0), 0);
    const pricedCost = priced.reduce((sum, row) => sum + row.cost, 0);
    const totalPl = totalValue - pricedCost;
    const totalPlRatio = pricedCost > 0 ? (totalPl / pricedCost) * 100 : 0;

    // 비중: 시세가 있으면 평가금액, 없으면 매입금액 기준으로 섞이지 않게
    // "평가금액(없으면 매입금액)"을 사용해 항상 100%가 되도록 한다.
    const weightBase = rows.map((row) => row.value ?? row.cost);
    const weightTotal = weightBase.reduce((sum, value) => sum + value, 0);
    const weights = rows.map((_, index) =>
      weightTotal > 0 ? (weightBase[index] / weightTotal) * 100 : 0,
    );

    return { rows, totalCost, totalValue, totalPl, totalPlRatio, weights, hasQuotes: priced.length > 0 };
  }, [holdings, quotes]);

  // ---------- 렌더 ----------
  if (checking) {
    return (
      <section className="pf-card">
        <p className="pf-muted">세션 확인 중...</p>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="pf-card" aria-labelledby="pf-auth-title">
        <h2 id="pf-auth-title">로그인</h2>
        <p className="pf-muted">
          보유 종목을 등록하면 실시간 수익률과 비중을 볼 수 있습니다.
        </p>
        <form className="pf-auth-form" onSubmit={(event) => handleAuth(event, "login")}>
          <input
            type="email"
            required
            placeholder="이메일"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="비밀번호 (8자 이상)"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <div className="pf-auth-actions">
            <button type="submit" className="pf-primary" disabled={authBusy}>
              {authBusy ? "처리 중..." : "로그인"}
            </button>
            <button
              type="button"
              className="pf-ghost"
              disabled={authBusy}
              onClick={(event) => handleAuth(event, "signup")}
            >
              회원가입
            </button>
          </div>
        </form>
        {authMessage && <p className="pf-notice">{authMessage}</p>}
        {authError && <p className="pf-error">{authError}</p>}
      </section>
    );
  }

  return (
    <div className="pf-stack">
      <section className="pf-card pf-toolbar">
        <span className="pf-muted">{user.email}</span>
        <button type="button" className="pf-ghost" onClick={handleLogout}>
          로그아웃
        </button>
      </section>

      <section className="pf-card" aria-labelledby="pf-add-title">
        <h2 id="pf-add-title">종목 등록</h2>
        <form className="pf-add-form" onSubmit={handleAdd}>
          <div className="pf-field">
            <label htmlFor="pf-stock">종목</label>
            <select
              id="pf-stock"
              value={selectedPreset}
              onChange={(event) => setSelectedPreset(event.target.value)}
            >
              {PRESETS.map((preset) => (
                <option key={preset.code} value={preset.code}>
                  {preset.name} ({preset.code})
                </option>
              ))}
              <option value="custom">직접 입력...</option>
            </select>
          </div>
          {isCustom && (
            <>
              <div className="pf-field">
                <label htmlFor="pf-code">종목코드 (6자리)</label>
                <input
                  id="pf-code"
                  required
                  pattern="[0-9]{6}"
                  placeholder="예: 005380"
                  value={customCode}
                  onChange={(event) => setCustomCode(event.target.value)}
                />
              </div>
              <div className="pf-field">
                <label htmlFor="pf-name">종목명</label>
                <input
                  id="pf-name"
                  required
                  maxLength={50}
                  placeholder="예: 현대차"
                  value={customName}
                  onChange={(event) => setCustomName(event.target.value)}
                />
              </div>
            </>
          )}
          <div className="pf-field">
            <label htmlFor="pf-quantity">보유 수량</label>
            <input
              id="pf-quantity"
              required
              type="number"
              min="0.0001"
              step="any"
              placeholder="예: 10"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </div>
          <div className="pf-field">
            <label htmlFor="pf-price">평균 단가 (원)</label>
            <input
              id="pf-price"
              required
              type="number"
              min="1"
              step="any"
              placeholder="예: 58300"
              value={avgPrice}
              onChange={(event) => setAvgPrice(event.target.value)}
            />
          </div>
          <button type="submit" className="pf-primary" disabled={formBusy}>
            {formBusy ? "등록 중..." : "등록 / 갱신"}
          </button>
        </form>
        <p className="pf-muted pf-hint">같은 종목을 다시 등록하면 수량·단가가 갱신됩니다.</p>
        {formError && <p className="pf-error">{formError}</p>}
      </section>

      <section className="pf-card" aria-labelledby="pf-list-title">
        <div className="pf-list-head">
          <h2 id="pf-list-title">내 포트폴리오</h2>
          <div className="pf-list-tools">
            {quotesAsOf && (
              <span className="pf-muted pf-asof">
                시세 {new Date(quotesAsOf).toLocaleTimeString("ko-KR")} 기준
              </span>
            )}
            <button
              type="button"
              className="pf-ghost"
              onClick={() => void loadHoldings()}
              disabled={listBusy}
            >
              {listBusy ? "불러오는 중..." : "시세 새로고침"}
            </button>
          </div>
        </div>

        {listError && <p className="pf-error">{listError}</p>}

        {holdings.length === 0 && !listBusy ? (
          <p className="pf-muted">아직 등록된 종목이 없습니다. 위에서 첫 종목을 등록해 보세요.</p>
        ) : (
          <>
            <div className="pf-summary">
              <div>
                <span className="pf-muted">총 매입</span>
                <strong>{formatKrw(computed.totalCost)}원</strong>
              </div>
              <div>
                <span className="pf-muted">총 평가</span>
                <strong>
                  {computed.hasQuotes ? `${formatKrw(computed.totalValue)}원` : "시세 대기"}
                </strong>
              </div>
              <div>
                <span className="pf-muted">평가 손익</span>
                <strong className={plClass(computed.totalPl)}>
                  {computed.hasQuotes
                    ? `${formatSigned(computed.totalPl)}원 (${formatPercent(computed.totalPlRatio)})`
                    : "—"}
                </strong>
              </div>
            </div>

            <div className="pf-table-wrap">
              <table className="pf-table">
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>수량</th>
                    <th>평단가</th>
                    <th>현재가</th>
                    <th>평가금액</th>
                    <th>손익</th>
                    <th>수익률</th>
                    <th>비중</th>
                    <th aria-label="삭제" />
                  </tr>
                </thead>
                <tbody>
                  {computed.rows.map((row, index) => (
                    <tr key={row.holding.stock_code}>
                      <td>
                        <span
                          className="pf-dot"
                          style={{ background: PIE_COLORS[index % PIE_COLORS.length] }}
                          aria-hidden="true"
                        />
                        {row.holding.stock_name}
                      </td>
                      <td>{row.holding.quantity.toLocaleString("ko-KR")}</td>
                      <td>{formatKrw(row.holding.avg_price)}</td>
                      <td>
                        {row.quote ? (
                          <>
                            {formatKrw(row.quote.price)}
                            <span className={`pf-ratio ${plClass(row.quote.changeRatio)}`}>
                              {formatPercent(row.quote.changeRatio)}
                            </span>
                          </>
                        ) : (
                          <span className="pf-muted">시세 없음</span>
                        )}
                      </td>
                      <td>{row.value !== null ? formatKrw(row.value) : "—"}</td>
                      <td className={row.pl !== null ? plClass(row.pl) : ""}>
                        {row.pl !== null ? formatSigned(row.pl) : "—"}
                      </td>
                      <td className={row.plRatio !== null ? plClass(row.plRatio) : ""}>
                        {row.plRatio !== null ? formatPercent(row.plRatio) : "—"}
                      </td>
                      <td>{computed.weights[index].toFixed(1)}%</td>
                      <td>
                        <button
                          type="button"
                          className="pf-delete"
                          aria-label={`${row.holding.stock_name} 삭제`}
                          onClick={() => void handleDelete(row.holding.stock_code)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <PieChart
              slices={computed.rows.map((row, index) => ({
                label: row.holding.stock_name,
                percent: computed.weights[index],
                color: PIE_COLORS[index % PIE_COLORS.length],
              }))}
            />
          </>
        )}
      </section>
    </div>
  );
}

type PieSlice = { label: string; percent: number; color: string };

function PieChart({ slices }: { slices: PieSlice[] }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="pf-pie" role="img" aria-label="종목별 비중 원 그래프">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={radius} className="pf-pie-track" />
        {slices.map((slice) => {
          const length = (slice.percent / 100) * circumference;
          const element = (
            <circle
              key={slice.label}
              cx="60"
              cy="60"
              r={radius}
              fill="none"
              stroke={slice.color}
              strokeWidth="22"
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
            />
          );
          offset += length;
          return element;
        })}
      </svg>
      <ul className="pf-legend">
        {slices.map((slice) => (
          <li key={slice.label}>
            <span className="pf-dot" style={{ background: slice.color }} aria-hidden="true" />
            {slice.label}
            <strong>{slice.percent.toFixed(1)}%</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
