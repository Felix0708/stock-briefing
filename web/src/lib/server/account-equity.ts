import "server-only";
import { equitySource, RETURN_METHOD, type EquityInput, type EquitySeries } from "../account-equity";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^-?(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/;
const SERIES_KEYS = ["account_ref", "broker", "account_type", "currency", "scope", "date_timezone", "return_method", "return_base_at", "points"];
const POINT_KEYS = ["date", "valued_at", "collected_at", "calculated_at", "equity", "cash", "stock_value", "return_index", "return_status", "source"];
const STATUSES = ["verified", "insufficient_samples", "cash_flows_unverified", "scope_unverified", "invalid_data"];
export const MAX_EQUITY_BYTES = 1_048_576;

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function oneOf(value: unknown, choices: string[]): boolean {
  return typeof value === "string" && choices.includes(value);
}
export function isIso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && isDate(value.slice(0, 10));
}
export function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function decimal(value: unknown, signed = false): boolean {
  return value === null || (typeof value === "string" && DECIMAL.test(value) && (signed || !value.startsWith("-")));
}

export function parseEquity(body: unknown, now = Date.now()): EquityInput[] | string {
  if (!exact(body, ["version", "series"]) || body.version !== 1 || !Array.isArray(body.series) || body.series.length > 20) {
    return "version=1과 최대 20개 series 배열이 필요합니다.";
  }
  const records: EquityInput[] = [];
  const seen = new Set<string>();
  for (const series of body.series) {
    if (!exact(series, SERIES_KEYS) || typeof series.account_ref !== "string" || !UUID.test(series.account_ref)
      || !oneOf(series.broker, ["KIWOOM", "KIS"]) || !oneOf(series.account_type, ["paper", "live"])
      || !equitySource(series.broker, series.currency, series.scope)
      || series.date_timezone !== "Asia/Seoul" || !Array.isArray(series.points)
      || !((series.return_method === null && series.return_base_at === null)
        || (series.return_method === RETURN_METHOD && isIso(series.return_base_at)))) return "자산 시리즈 형식·통화·범위를 확인해 주세요.";
    const { points, ...meta } = series as unknown as EquitySeries;
    for (const point of points) {
      if (!exact(point, POINT_KEYS) || !isDate(point.date) || !isIso(point.collected_at) || !isIso(point.calculated_at)
        || (point.valued_at !== null && !isIso(point.valued_at))
        || !decimal(point.equity) || !decimal(point.cash, true) || !decimal(point.stock_value) || !decimal(point.return_index)
        || !oneOf(point.return_status, STATUSES)
        || point.source !== equitySource(meta.broker, meta.currency, meta.scope)) return "자산 관측값의 형식·출처를 확인해 주세요.";
      const collected = Date.parse(point.collected_at);
      const calculated = Date.parse(point.calculated_at);
      if (collected > now + 300_000 || calculated > now + 300_000 || calculated < collected
        || point.date !== new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(collected))
        || (point.valued_at !== null && Date.parse(point.valued_at) > collected)
        || (meta.return_base_at !== null && Date.parse(meta.return_base_at) > collected)) return "관측 날짜·수집·계산 시각이 일치하지 않습니다.";
      if (point.return_status === "verified"
        ? point.return_index === null || point.equity === null || meta.return_method === null || meta.return_base_at === null
        : point.return_index !== null) return "검증된 수익률에만 기준일과 지수를 지정할 수 있습니다.";
      const record = { ...meta, ...point, account_ref: meta.account_ref.toLowerCase(),
        collected_at: new Date(collected).toISOString(), calculated_at: new Date(calculated).toISOString(),
        valued_at: point.valued_at === null ? null : new Date(point.valued_at).toISOString(),
        return_base_at: meta.return_base_at === null ? null : new Date(meta.return_base_at).toISOString() };
      const key = [record.account_ref, record.broker, record.account_type, record.currency, record.scope, record.date].join(":");
      if (seen.has(key)) return "같은 시리즈의 날짜가 중복되었습니다.";
      seen.add(key);
      records.push(record);
      if (records.length > 500) return "한 요청에 최대 500개 관측값을 전송할 수 있습니다.";
    }
  }
  return records;
}

export async function readEquityBody(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length")) > MAX_EQUITY_BYTES) throw new RangeError("body too large");
  const reader = req.body?.getReader();
  if (!reader) throw new SyntaxError("empty body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EQUITY_BYTES) { await reader.cancel(); throw new RangeError("body too large"); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}
