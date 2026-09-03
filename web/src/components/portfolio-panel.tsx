"use client";

import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { searchStocks, type StockSuggestion } from "@/lib/client/stock-search";
import {
  accountGroupKey,
  accountGroupLabel,
  brokerLabel,
  isRealAccount,
  isManualBroker,
  MANUAL_BROKER_OPTIONS,
  type HoldingBroker,
  type ManualBroker,
} from "@/lib/holding-brokers";

type Holding = {
  stock_code: string;
  stock_name: string;
  quantity: number;
  avg_price: number;
  market: "KR" | "US" | "JP";
  source: "manual" | "stock_trading";
  account_type: "manual" | "paper" | "live";
  broker: HoldingBroker;
};

type Quote = {
  code: string;
  name: string | null;
  price: number;
  changeRatio: number;
  currency: "KRW" | "USD" | "JPY";
};

type TradingPerformance = {
  broker: "KIWOOM" | "KIS";
  account_type: "paper" | "live";
  all_count: number;
  all_wins: number;
  all_losses: number;
  all_draws: number;
  all_win_rate: number | null;
  month_count: number;
  month_wins: number;
  month_losses: number;
  month_draws: number;
  month_win_rate: number | null;
  realized_krw_count: number;
  realized_krw_profit_loss: number;
  realized_krw_return_rate: number | null;
  realized_usd_count: number;
  realized_usd_profit_loss: number;
  realized_usd_return_rate: number | null;
  excluded_full_exits: number;
  updated_at: string;
};

function quoteKey(holding: Holding): string {
  return holding.market === "KR" ? holding.stock_code : `${holding.market}:${holding.stock_code}`;
}

function holdingKey(holding: Holding): string {
  return `${holding.source}:${holding.market}:${holding.stock_code}:${holding.account_type}:${holding.broker}`;
}

function stockLabel(holding: Holding, quote: Quote | null): string {
  const name = quote?.name?.trim() || holding.stock_name.trim();
  const suffix = ` (${holding.stock_code})`;
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

function currencyOf(market: "KR" | "US" | "JP"): "KRW" | "USD" | "JPY" {
  return market === "US" ? "USD" : market === "JP" ? "JPY" : "KRW";
}

function formatMoney(value: number, currency: "KRW" | "USD" | "JPY"): string {
  if (currency === "USD") {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (currency === "JPY") {
    return `¥${Math.round(value).toLocaleString("ja-JP")}`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}`;
}

type SessionUser = {
  email: string;
  nickname?: string | null;
  briefingEmail?: boolean;
  publicBriefingOptIn?: boolean;
} | null;

const PIE_COLORS = [
  "#2563eb", "#f59e0b", "#10b981", "#ef4444",
  "#8b5cf6", "#06b6d4", "#f97316", "#84cc16",
  "#ec4899", "#64748b",
];
const ACCOUNT_ORDER = [
  ...MANUAL_BROKER_OPTIONS.map((option) => `${option.value}:live`),
  "MANUAL:live",
  "LEGACY:live",
  "KIWOOM:paper",
  "KIS:paper",
  "LEGACY:paper",
];

function accountRank(key: string): number {
  const index = ACCOUNT_ORDER.indexOf(key);
  return index < 0 ? ACCOUNT_ORDER.length : index;
}

function formatKrw(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function formatUnitPrice(
  value: number,
  currency: "KRW" | "USD" | "JPY",
  showKrw: boolean,
  usdKrw: number | null,
  jpyKrw: number | null,
): string {
  const rate = currency === "USD" ? usdKrw : currency === "JPY" ? jpyKrw : 1;
  return showKrw && rate ? `${formatKrw(value * rate)}원` : formatMoney(value, currency);
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("ko-KR")}`;
}

function formatPercent(value: number): string {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function formatSignedMoney(value: number, currency: "KRW" | "USD" | "JPY"): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const amount = Math.abs(value);
  if (currency === "USD") return `${sign}$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (currency === "JPY") return `${sign}¥${Math.round(amount).toLocaleString("ja-JP")}`;
  return `${sign}${Math.round(amount).toLocaleString("ko-KR")}원`;
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
  const [performance, setPerformance] = useState<TradingPerformance[]>([]);
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [quotesAsOf, setQuotesAsOf] = useState<string | null>(null);
  const [usdKrw, setUsdKrw] = useState<number | null>(null);
  const [jpyKrw, setJpyKrw] = useState<number | null>(null);
  const [showPricesInKrw, setShowPricesInKrw] = useState(false);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Stock-Trading 자동 연동 토큰. 원문은 발급 직후 메모리에만 둔다.
  const [tokenStatus, setTokenStatus] = useState<{
    active: boolean;
    tokenHint?: string;
    issuedAt?: string;
  }>({ active: false });
  const [plainToken, setPlainToken] = useState<string | null>(null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);

  // 등록 폼 ("직접 입력" 또는 내가 이미 등록한 종목의 수량·단가 갱신)
  const [selectedPreset, setSelectedPreset] = useState<string>("custom");
  const [customCode, setCustomCode] = useState("");
  const [customName, setCustomName] = useState("");
  const [manualBroker, setManualBroker] = useState<ManualBroker | "">("");
  const [quantity, setQuantity] = useState("");
  const [avgPrice, setAvgPrice] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const isCustom = selectedPreset === "custom";

  const handlePresetChange = (value: string) => {
    setSelectedPreset(value);
    const selected = holdings.find(
      (holding) => holding.source === "manual" && holdingKey(holding) === value,
    );
    setManualBroker(selected && isManualBroker(selected.broker) ? selected.broker : "");
  };

  // 종목 자동완성 (직접 입력 시 시장 선택)
  const [customMarket, setCustomMarket] = useState<"KR" | "US" | "JP">("KR");
  const [stockQuery, setStockQuery] = useState("");
  const [stockSuggests, setStockSuggests] = useState<StockSuggestion[]>([]);
  const suggestTimerRef = useRef<number | null>(null);

  const handleStockQuery = (value: string) => {
    setStockQuery(value);
    if (suggestTimerRef.current) window.clearTimeout(suggestTimerRef.current);
    if (!value.trim()) {
      setStockSuggests([]);
      return;
    }
    suggestTimerRef.current = window.setTimeout(() => {
      void searchStocks(value, customMarket).then(setStockSuggests);
    }, 250);
  };

  // 닉네임
  const [editingNick, setEditingNick] = useState(false);
  const [nickInput, setNickInput] = useState("");
  const [nickBusy, setNickBusy] = useState(false);

  const loadQuotes = useCallback(async (rows: Holding[]) => {
    if (rows.length === 0) {
      setQuotes({});
      setQuotesAsOf(null);
      return;
    }
    try {
      const codes = rows.map((row) => quoteKey(row)).join(",");
      const data = await api<{
        quotes: Record<string, Quote>;
        usdKrw: number | null;
        jpyKrw: number | null;
        asOf: string;
      }>(`/api/quotes?codes=${codes}`);
      setQuotes(data.quotes);
      setUsdKrw(data.usdKrw ?? null);
      setJpyKrw(data.jpyKrw ?? null);
      setQuotesAsOf(data.asOf);
    } catch {
      // 시세 실패는 치명적이지 않다 — 표에서 "시세 없음"으로 표시
    }
  }, []);

  const loadHoldings = useCallback(async () => {
    setListBusy(true);
    setListError(null);
    try {
      const data = await api<{ holdings: Holding[]; performance: TradingPerformance[] }>("/api/holdings");
      setHoldings(data.holdings);
      setPerformance(data.performance);
      await loadQuotes(data.holdings);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "목록을 불러오지 못했습니다.");
    } finally {
      setListBusy(false);
    }
  }, [loadQuotes]);

  const loadTokenStatus = useCallback(async () => {
    try {
      setTokenStatus(await api("/api/integration-token"));
    } catch (error) {
      setListError(error instanceof Error ? error.message : "연동 상태를 불러오지 못했습니다.");
    }
  }, []);

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
    if (user) {
      void loadHoldings();
      void loadTokenStatus();
    }
  }, [user, loadHoldings, loadTokenStatus]);

  useEffect(() => {
    if (
      selectedPreset !== "custom" &&
      !holdings.some((holding) => holding.source === "manual" && holdingKey(holding) === selectedPreset)
    ) {
      setSelectedPreset("custom");
    }
  }, [holdings, selectedPreset]);

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

  async function handleNickname(event: FormEvent) {
    event.preventDefault();
    const nickname = nickInput.trim();
    if (!nickname) return;
    setNickBusy(true);
    try {
      await api("/api/auth/nickname", { method: "POST", body: JSON.stringify({ nickname }) });
      const me = await api<{ user: SessionUser }>("/api/auth/me");
      setUser(me.user);
      setEditingNick(false);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "닉네임 저장에 실패했습니다.");
    } finally {
      setNickBusy(false);
    }
  }

  async function handleBriefingToggle(next: boolean) {
    setUser((current) => (current ? { ...current, briefingEmail: next } : current));
    try {
      await api("/api/auth/prefs", {
        method: "POST",
        body: JSON.stringify({ briefing_email: next }),
      });
    } catch (error) {
      setUser((current) => (current ? { ...current, briefingEmail: !next } : current));
      setListError(error instanceof Error ? error.message : "설정 저장에 실패했습니다.");
    }
  }

  async function handlePublicToggle(next: boolean) {
    setUser((current) => (current ? { ...current, publicBriefingOptIn: next } : current));
    try {
      await api("/api/auth/prefs", {
        method: "POST",
        body: JSON.stringify({ public_briefing_opt_in: next }),
      });
    } catch (error) {
      setUser((current) => (current ? { ...current, publicBriefingOptIn: !next } : current));
      setListError(error instanceof Error ? error.message : "공개 설정 저장에 실패했습니다.");
    }
  }

  async function handleIssueToken() {
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      const result = await api<{ token: string; tokenHint: string }>("/api/integration-token", {
        method: "POST",
      });
      setPlainToken(result.token);
      setTokenMessage("지금 복사해 안전하게 보관하세요. 화면을 벗어나면 다시 볼 수 없습니다.");
      await loadTokenStatus();
    } catch (error) {
      setListError(error instanceof Error ? error.message : "토큰 발급에 실패했습니다.");
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleRevokeToken() {
    setTokenBusy(true);
    try {
      await api("/api/integration-token", { method: "DELETE" });
      setPlainToken(null);
      setTokenStatus({ active: false });
      setTokenMessage("연동 토큰을 폐기했습니다.");
    } catch (error) {
      setListError(error instanceof Error ? error.message : "토큰 폐기에 실패했습니다.");
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleLogout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setUser(null);
    setHoldings([]);
    setPerformance([]);
    setQuotes({});
    setPlainToken(null);
    setTokenStatus({ active: false });
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setFormBusy(true);
    setFormError(null);

    const owned = holdings.find(
      (row) => row.source === "manual" && holdingKey(row) === selectedPreset,
    );
    const stockCode = isCustom ? customCode.trim() : owned?.stock_code ?? "";
    const stockName = isCustom ? customName.trim() : owned?.stock_name ?? "";
    const market = isCustom ? customMarket : owned?.market ?? "KR";

    try {
      await api("/api/holdings", {
        method: "POST",
        body: JSON.stringify({
          stock_code: stockCode,
          stock_name: stockName,
          quantity: Number(quantity),
          avg_price: Number(avgPrice),
          market,
          broker: manualBroker,
          previous_broker: owned?.broker,
        }),
      });
      setQuantity("");
      setAvgPrice("");
      setCustomCode("");
      setCustomName("");
      setStockQuery("");
      await loadHoldings();

      // 아직 공시가 수집 안 된 종목이면 백그라운드로 수집 요청 (국내 종목만 — 미국 공시는 미지원)
      if (market === "KR") void (async () => {
        try {
          const cov = await api<{ covered: boolean }>(
            `/api/coverage?company=${encodeURIComponent(stockName)}`,
          );
          if (!cov.covered) {
            await api("/api/collect", {
              method: "POST",
              body: JSON.stringify({ company: stockName }),
            });
          }
        } catch {
          // 수집 요청 실패는 치명적이지 않음
        }
      })();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "등록에 실패했습니다.");
    } finally {
      setFormBusy(false);
    }
  }

  async function handleDelete(holding: Holding) {
    if (holding.source !== "manual") return;
    try {
      await api(
        `/api/holdings?code=${encodeURIComponent(holding.stock_code)}&market=${holding.market}&broker=${encodeURIComponent(holding.broker)}`,
        { method: "DELETE" },
      );
      await loadHoldings();
    } catch (error) {
      setListError(error instanceof Error ? error.message : "삭제에 실패했습니다.");
    }
  }

  // ---------- 계산 ----------
  const computed = useMemo(() => {
    // 모든 합산은 원화(KRW) 기준. 해외 종목은 해당 환율로 환산한다.
    const toKrw = (amount: number, currency: "KRW" | "USD" | "JPY"): number | null => {
      if (currency === "USD") return usdKrw ? amount * usdKrw : null;
      if (currency === "JPY") return jpyKrw ? amount * jpyKrw : null;
      return amount;
    };

    const rows = holdings.map((holding) => {
      const currency = currencyOf(holding.market);
      const quote = quotes[quoteKey(holding)] ?? null;
      const costNative = holding.quantity * holding.avg_price;
      const costKrw = toKrw(costNative, currency);
      const valueNative = quote ? holding.quantity * quote.price : null;
      const valueKrw = valueNative !== null ? toKrw(valueNative, currency) : null;
      const plNative = valueNative !== null ? valueNative - costNative : null;
      const pl = valueKrw !== null && costKrw !== null ? valueKrw - costKrw : null;
      // 수익률은 환율과 무관하게 통화 그대로 계산
      const plRatio =
        quote && holding.avg_price > 0
          ? ((quote.price - holding.avg_price) / holding.avg_price) * 100
          : null;
      return { holding, quote, currency, costKrw, valueNative, valueKrw, plNative, pl, plRatio };
    });

    const realRows = rows.filter((row) => isRealAccount(row.holding));
    const costed = realRows.filter((row) => row.costKrw !== null);
    const totalCost = costed.reduce((sum, row) => sum + (row.costKrw ?? 0), 0);
    const priced = realRows.filter((row) => row.valueKrw !== null && row.costKrw !== null);
    const totalValue = priced.reduce((sum, row) => sum + (row.valueKrw ?? 0), 0);
    const pricedCost = priced.reduce((sum, row) => sum + (row.costKrw ?? 0), 0);
    const totalPl = totalValue - pricedCost;
    const totalPlRatio = pricedCost > 0 ? (totalPl / pricedCost) * 100 : 0;

    // 비중: 같은 증권사의 직접 등록+자동 실계좌는 합치고, 모의계좌는 별도로 100% 분배
    const weightBase = rows.map((row) => row.valueKrw ?? row.costKrw ?? 0);
    const accountTotals = new Map<string, number>();
    rows.forEach((row, index) => {
      const key = accountGroupKey(row.holding);
      accountTotals.set(key, (accountTotals.get(key) ?? 0) + weightBase[index]);
    });
    const weights = rows.map((row, index) => {
      const total = accountTotals.get(accountGroupKey(row.holding)) ?? 0;
      return total > 0 ? (weightBase[index] / total) * 100 : 0;
    });

    const accountRows = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = accountGroupKey(row.holding);
      const group = accountRows.get(key) ?? [];
      group.push(row);
      accountRows.set(key, group);
    }
    const charts = [...accountRows.entries()]
      .sort(([left], [right]) => accountRank(left) - accountRank(right))
      .map(([key, group]) => {
        const bases = group.map((row) => row.valueKrw ?? row.costKrw ?? 0);
        const total = bases.reduce((sum, value) => sum + value, 0);
        const equalWeight = group.length > 0 ? 100 / group.length : 0;
        return {
          key,
          title: accountGroupLabel(group[0].holding),
          slices: group.map((row, index) => ({
            key: holdingKey(row.holding),
            label: stockLabel(row.holding, row.quote),
            percent: total > 0 ? (bases[index] / total) * 100 : equalWeight,
            color: PIE_COLORS[index % PIE_COLORS.length],
          })),
        };
      });

    return { rows, totalCost, totalValue, totalPl, totalPlRatio, weights, charts, hasQuotes: priced.length > 0 };
  }, [holdings, quotes, usdKrw, jpyKrw]);

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
        <div className="pf-who">
          <strong>{user.nickname || user.email}</strong>
          {user.nickname && <span className="pf-muted">{user.email}</span>}
        </div>
        <div className="pf-toolbar-actions">
          <label className="pf-mail-toggle" title="매일 아침, 내 보유 종목의 신규 공시만 골라 메일로 보내드립니다">
            <input
              type="checkbox"
              checked={!!user.briefingEmail}
              onChange={(event) => void handleBriefingToggle(event.target.checked)}
            />
            아침 브리핑 메일
          </label>
          <label
            className="pf-mail-toggle"
            title="동의한 회원의 종목명만 중복 제거해 익명 공용 브리핑 수집 대상에 포함합니다"
          >
            <input
              type="checkbox"
              checked={!!user.publicBriefingOptIn}
              onChange={(event) => void handlePublicToggle(event.target.checked)}
            />
            내 보유종목 익명 공용 브리핑 포함
          </label>
          {editingNick ? (
            <form className="pf-nick-form" onSubmit={handleNickname}>
              <input
                maxLength={20}
                placeholder="닉네임"
                value={nickInput}
                onChange={(event) => setNickInput(event.target.value)}
              />
              <button type="submit" className="pf-primary" disabled={nickBusy}>
                {nickBusy ? "저장 중" : "저장"}
              </button>
              <button type="button" className="pf-ghost" onClick={() => setEditingNick(false)}>
                취소
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="pf-ghost"
              onClick={() => {
                setNickInput(user.nickname ?? "");
                setEditingNick(true);
              }}
            >
              {user.nickname ? "닉네임 변경" : "닉네임 설정"}
            </button>
          )}
          <button type="button" className="pf-ghost" onClick={handleLogout}>
            로그아웃
          </button>
        </div>
      </section>

      <section className="pf-card" aria-labelledby="pf-integration-title">
        <h2 id="pf-integration-title">Stock-Trading 자동 연동</h2>
        <p className="pf-muted">
          로컬 Stock-Trading이 이 계정의 보유종목 전체 스냅샷만 동기화합니다.
          증권사 API 키·비밀번호는 보내지 마세요.
        </p>
        <div className="pf-token-actions">
          <button type="button" className="pf-primary" disabled={tokenBusy} onClick={() => void handleIssueToken()}>
            {tokenBusy ? "처리 중..." : tokenStatus.active ? "토큰 재발급" : "토큰 발급"}
          </button>
          {tokenStatus.active && (
            <button type="button" className="pf-ghost" disabled={tokenBusy} onClick={() => void handleRevokeToken()}>
              토큰 폐기
            </button>
          )}
          {tokenStatus.active && (
            <span className="pf-muted">
              활성 토큰 · 끝 6자리 {tokenStatus.tokenHint}
              {tokenStatus.issuedAt ? ` · ${new Date(tokenStatus.issuedAt).toLocaleString("ko-KR")}` : ""}
            </span>
          )}
        </div>
        {plainToken && (
          <div className="pf-token-once" role="status">
            <code>{plainToken}</code>
            <button
              type="button"
              className="pf-ghost"
              onClick={() => {
                void navigator.clipboard.writeText(plainToken);
                setTokenMessage("토큰을 클립보드에 복사했습니다.");
              }}
            >
              복사
            </button>
          </div>
        )}
        {tokenMessage && <p className="pf-notice">{tokenMessage}</p>}
      </section>

      <section className="pf-card" aria-labelledby="pf-add-title">
        <h2 id="pf-add-title">종목 등록</h2>
        <form className="pf-add-form" onSubmit={handleAdd}>
          <div className="pf-field">
            <label htmlFor="pf-stock">종목</label>
            <select
              id="pf-stock"
              value={selectedPreset}
              onChange={(event) => handlePresetChange(event.target.value)}
            >
              <option value="custom">직접 입력 (새 종목)</option>
              {holdings.filter((row) => row.source === "manual").map((row) => (
                <option key={holdingKey(row)} value={holdingKey(row)}>
                  {brokerLabel(row.broker)} · {stockLabel(row, quotes[quoteKey(row)] ?? null)} — 갱신
                </option>
              ))}
            </select>
          </div>
          <div className="pf-field">
            <label htmlFor="pf-broker">증권사</label>
            <select
              id="pf-broker"
              required
              value={manualBroker}
              onChange={(event) => setManualBroker(event.target.value as ManualBroker)}
            >
              <option value="" disabled>증권사 선택</option>
              {MANUAL_BROKER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </div>
          {isCustom && (
            <>
              <div className="pf-field">
                <label htmlFor="pf-market">시장</label>
                <select
                  id="pf-market"
                  value={customMarket}
                  onChange={(event) => {
                    setCustomMarket(event.target.value as "KR" | "US" | "JP");
                    setStockQuery("");
                    setStockSuggests([]);
                    setCustomCode("");
                    setCustomName("");
                  }}
                >
                  <option value="KR">🇰🇷 국내</option>
                  <option value="US">🇺🇸 미국</option>
                  <option value="JP">🇯🇵 일본</option>
                </select>
              </div>
              <div className="pf-field pf-suggest-wrap">
                <label htmlFor="pf-search">종목 검색</label>
                <input
                  id="pf-search"
                  placeholder={
                    customMarket === "US"
                      ? "예: apple, TSLA"
                      : customMarket === "JP"
                        ? "예: 도요타, 7203"
                        : "예: skt, 삼전, 현대차"
                  }
                  value={stockQuery}
                  autoComplete="off"
                  onChange={(event) => handleStockQuery(event.target.value)}
                  onBlur={() => window.setTimeout(() => setStockSuggests([]), 150)}
                />
                {stockSuggests.length > 0 && (
                  <ul className="stock-suggest" role="listbox" aria-label="종목 추천">
                    {stockSuggests.map((item) => (
                      <li key={item.code}>
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setCustomCode(item.code);
                            setCustomName(item.name);
                            setStockQuery(`${item.name} (${item.code})`);
                            setStockSuggests([]);
                          }}
                        >
                          {item.name}
                          <span>
                            {item.code}
                            {item.market ? ` · ${item.market}` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="pf-field">
                <label htmlFor="pf-code">
                  {customMarket === "US"
                    ? "티커"
                    : customMarket === "JP"
                      ? "종목코드 (4자리)"
                      : "종목코드 (6자리)"}
                </label>
                <input
                  id="pf-code"
                  required
                  pattern={
                    customMarket === "US"
                      ? "[A-Za-z][A-Za-z0-9.\-]{0,9}"
                      : customMarket === "JP"
                        ? "[0-9A-Za-z]{4,5}"
                        : "[0-9]{6}"
                  }
                  placeholder={
                    customMarket === "US"
                      ? "예: AAPL"
                      : customMarket === "JP"
                        ? "예: 7203"
                        : "예: 005380"
                  }
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
            <label htmlFor="pf-price">
              평균 단가 (
              {isCustom && customMarket === "US"
                ? "USD"
                : isCustom && customMarket === "JP"
                  ? "JPY"
                  : "원"}
              )
            </label>
            <input
              id="pf-price"
              required
              type="number"
              min="1"
              step="any"
              placeholder={
                isCustom && customMarket === "US"
                  ? "예: 225.50"
                  : isCustom && customMarket === "JP"
                    ? "예: 2850"
                    : "예: 58300"
              }
              value={avgPrice}
              onChange={(event) => setAvgPrice(event.target.value)}
            />
          </div>
          <button type="submit" className="pf-primary" disabled={formBusy}>
            {formBusy ? "등록 중..." : "등록 / 갱신"}
          </button>
        </form>
        <p className="pf-muted pf-hint">
          직접 등록은 실계좌로 보며, 자동매매 실계좌와 별도로 표시됩니다.
        </p>
        {formError && <p className="pf-error">{formError}</p>}
      </section>

      <section className="pf-card" aria-labelledby="pf-list-title">
        <div className="pf-list-head">
          <h2 id="pf-list-title">내 포트폴리오</h2>
          <div className="pf-list-tools">
            <label className="pf-mail-toggle">
              <input
                type="checkbox"
                checked={showPricesInKrw}
                onChange={(event) => setShowPricesInKrw(event.target.checked)}
              />
              표 금액 원화로 보기
            </label>
            {quotesAsOf && (
              <span className="pf-muted pf-asof">
                시세 {new Date(quotesAsOf).toLocaleTimeString("ko-KR")} 기준
                {usdKrw ? ` · ${formatKrw(usdKrw)}원/$` : ""}
                {jpyKrw ? ` · ${jpyKrw.toFixed(1)}원/¥` : ""}
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
                <span className="pf-muted">실계좌 총 매입</span>
                <strong>{formatKrw(computed.totalCost)}원</strong>
              </div>
              <div>
                <span className="pf-muted">실계좌 총 평가</span>
                <strong>
                  {computed.hasQuotes ? `${formatKrw(computed.totalValue)}원` : "시세 대기"}
                </strong>
              </div>
              <div>
                <span className="pf-muted">실계좌 평가 손익</span>
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
                    <th>계좌 내 비중</th>
                    <th aria-label="삭제" />
                  </tr>
                </thead>
                <tbody>
                  {computed.rows.map((row, index) => (
                    <tr key={holdingKey(row.holding)}>
                      <td data-label="종목">
                        <span
                          className="pf-dot"
                          style={{ background: PIE_COLORS[index % PIE_COLORS.length] }}
                          aria-hidden="true"
                        />
                        {stockLabel(row.holding, row.quote)}
                        <span className="pf-source-badge">
                          {row.holding.source === "manual"
                            ? `직접 · ${brokerLabel(row.holding.broker)}`
                            : `자동 · ${brokerLabel(row.holding.broker)} · ${row.holding.account_type === "paper" ? "모의" : "실계좌"}`}
                        </span>
                      </td>
                      <td data-label="수량">{row.holding.quantity.toLocaleString("ko-KR")}</td>
                      <td data-label="평단가">
                        {formatUnitPrice(row.holding.avg_price, row.currency, showPricesInKrw, usdKrw, jpyKrw)}
                      </td>
                      <td data-label="현재가">
                        {row.quote ? (
                          <>
                            {formatUnitPrice(row.quote.price, row.quote.currency, showPricesInKrw, usdKrw, jpyKrw)}
                            <span className={`pf-ratio ${plClass(row.quote.changeRatio)}`}>
                              {formatPercent(row.quote.changeRatio)}
                            </span>
                          </>
                        ) : (
                          <span className="pf-muted">시세 없음</span>
                        )}
                      </td>
                      <td data-label="평가금액">
                        {row.valueNative !== null
                          ? showPricesInKrw && row.valueKrw !== null
                            ? `${formatKrw(row.valueKrw)}원`
                            : formatMoney(row.valueNative, row.currency)
                          : "—"}
                      </td>
                      <td data-label="손익" className={row.pl !== null ? plClass(row.pl) : ""}>
                        {showPricesInKrw && row.pl !== null
                          ? formatSignedMoney(row.pl, "KRW")
                          : row.plNative !== null
                            ? formatSignedMoney(row.plNative, row.currency)
                            : "—"}
                      </td>
                      <td data-label="수익률" className={row.plRatio !== null ? plClass(row.plRatio) : ""}>
                        {row.plRatio !== null ? formatPercent(row.plRatio) : "—"}
                      </td>
                      <td data-label="계좌 내 비중">{computed.weights[index].toFixed(1)}%</td>
                      <td className="pf-table-action">
                        {row.holding.source === "manual" && (
                          <button
                            type="button"
                            className="pf-delete"
                            aria-label={`${stockLabel(row.holding, row.quote)} 삭제`}
                            onClick={() => void handleDelete(row.holding)}
                          >
                            ✕
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="pf-pie-grid">
              {computed.charts.map((chart) => (
                <PieChart key={chart.key} title={chart.title} slices={chart.slices} />
              ))}
            </div>
          </>
        )}

        <div className="pf-performance" aria-labelledby="pf-performance-title">
          <h3 id="pf-performance-title">자동매매 누적 성과</h3>
          <p className="pf-muted pf-hint">최종청산 완료 기준 · 수수료·세금 제외</p>
          {performance.length === 0 ? (
            <p className="pf-muted">아직 동기화된 자동매매 성과가 없습니다.</p>
          ) : (
            <div className="pf-performance-grid">
              {[...performance]
                .sort((left, right) =>
                  accountRank(`${left.broker}:${left.account_type}`)
                  - accountRank(`${right.broker}:${right.account_type}`))
                .map((item) => (
                <article className="pf-performance-card" key={`${item.broker}:${item.account_type}`}>
                  <h4>{accountGroupLabel({ ...item, source: "stock_trading" })}</h4>
                  <dl>
                    <div>
                      <dt>역대</dt>
                      <dd>
                        {item.all_count.toLocaleString("ko-KR")}건 · {item.all_wins}승 {item.all_losses}패 {item.all_draws}무
                        <strong>승률 {formatRate(item.all_win_rate)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>이번 달</dt>
                      <dd>
                        {item.month_count.toLocaleString("ko-KR")}건 · {item.month_wins}승 {item.month_losses}패 {item.month_draws}무
                        <strong>승률 {formatRate(item.month_win_rate)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>KRW 실현손익</dt>
                      <dd>
                        {item.realized_krw_count.toLocaleString("ko-KR")}건 · <span className={plClass(item.realized_krw_profit_loss)}>{formatSignedMoney(item.realized_krw_profit_loss, "KRW")}</span>
                        <strong>수익률 {formatRate(item.realized_krw_return_rate)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>USD 실현손익</dt>
                      <dd>
                        {item.realized_usd_count.toLocaleString("ko-KR")}건 · <span className={plClass(item.realized_usd_profit_loss)}>{formatSignedMoney(item.realized_usd_profit_loss, "USD")}</span>
                        <strong>수익률 {formatRate(item.realized_usd_return_rate)}</strong>
                      </dd>
                    </div>
                    <div>
                      <dt>제외된 최종청산</dt>
                      <dd>{item.excluded_full_exits.toLocaleString("ko-KR")}건</dd>
                    </div>
                  </dl>
                  <p className="pf-muted pf-performance-time">
                    {new Date(item.updated_at).toLocaleString("ko-KR")} 기준
                  </p>
                </article>
                ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

type PieSlice = { key: string; label: string; percent: number; color: string };

function PieChart({ title, slices }: { title: string; slices: PieSlice[] }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <article className="pf-pie-card">
      <h3>{title}</h3>
      <div className="pf-pie" role="img" aria-label={`${title} 종목별 비중 원 그래프`}>
        <svg viewBox="0 0 120 120">
          <circle cx="60" cy="60" r={radius} className="pf-pie-track" />
          {slices.map((slice) => {
            const length = (slice.percent / 100) * circumference;
            const element = (
              <circle
                key={slice.key}
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
            <li key={slice.key}>
              <span className="pf-dot" style={{ background: slice.color }} aria-hidden="true" />
              {slice.label}
              <strong>{slice.percent.toFixed(1)}%</strong>
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
