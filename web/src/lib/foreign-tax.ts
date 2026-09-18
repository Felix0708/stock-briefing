// 2026 ordinary US/JP shares only. Inputs are broker tax-basis KRW, never display P&L.
export const TAX_YEAR = 2026;
const LIMIT = 1_000_000_000_000;

export function taxWon(input: string, signed = true): number | null {
  const value = input.trim();
  if (!(signed ? /^-?\d+$/ : /^\d+$/).test(value)) return null;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && Math.abs(amount) <= LIMIT ? amount : null;
}

export function foreignTax(us: number, jp: number) {
  if (![us, jp].every(n => Number.isSafeInteger(n) && Math.abs(n) <= LIMIT)) return null;
  const gain = us + jp;
  const taxable = Math.max(0, gain - 2_500_000);
  const national = Math.floor(taxable * 20 / 100);
  const local = Math.floor(taxable * 2 / 100);
  return { gain, taxable, national, local, tax: national + local, net: gain - national - local };
}

export function saleScenario(realized: number, proceeds: number | null, basis: number, fees: number) {
  if (proceeds === null || ![proceeds,basis,fees].every(n => Number.isFinite(n) && n >= 0 && n <= LIMIT)
    || !Number.isSafeInteger(basis) || !Number.isSafeInteger(fees)) return null;
  const gain = Math.round(proceeds) - basis - fees;
  const before = foreignTax(realized, 0), after = foreignTax(realized, gain);
  if (!before || !after) return null;
  const additionalTax = after.tax - before.tax;
  return { gain, additionalTax, net: gain - additionalTax, annualTax: after.tax };
}

export type RecordedTaxRow = {source:"manual"|"stock_trading";broker:string;market:"US"|"JP";sell_count:number;missing_count:number;profit_loss:number;updated_at:string};
export function recordedTax(rows: RecordedTaxRow[], usdKrw: number | null, jpyKrw: number | null) {
  let us=0,jp=0,count=0,missing=0;
  const seen=new Set<string>();
  for(const r of rows) {
    const key=`${r.source}:${r.broker}:${r.market}`;
    if(seen.has(key)||!["manual","stock_trading"].includes(r.source)||!["US","JP"].includes(r.market)
      ||![r.sell_count,r.missing_count].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=1000000)
      ||!Number.isFinite(r.profit_loss)||Math.abs(r.profit_loss)>1e12||(r.sell_count===0&&r.profit_loss!==0)) return null;
    seen.add(key); count+=r.sell_count; missing+=r.missing_count;
    const rate=r.market==="US"?usdKrw:jpyKrw;
    if(r.sell_count>0&&(!rate||!Number.isFinite(rate)||rate<=0)) return null;
    if(r.market==="US") us+=r.profit_loss*(rate??0); else jp+=r.profit_loss*(rate??0);
  }
  return {count,missing,us:Math.round(us),jp:Math.round(jp),result:missing?null:foreignTax(Math.round(us),Math.round(jp))};
}
