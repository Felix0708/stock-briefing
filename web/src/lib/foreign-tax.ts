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
