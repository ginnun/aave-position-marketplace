/** Amounts arrive as integer strings in the smallest unit of their asset. */
export function toNumber(amount: string | bigint | null | undefined, decimals: number): number {
  if (amount === null || amount === undefined) return 0;
  return Number(BigInt(amount)) / 10 ** decimals;
}

export function amount(value: string | bigint | null | undefined, decimals: number, max = 4): string {
  const n = toNumber(value, decimals);
  if (n === 0) return '0';
  const digits = n < 1 ? Math.min(6, max + 2) : n < 1000 ? max : 2;
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

/** The Aave oracle base currency is US dollars with 8 decimals. */
export function usd(base: string | bigint | null | undefined, digits = 2): string {
  if (base === null || base === undefined) return '—';
  const n = toNumber(base, 8);
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function money(value: string | bigint | null | undefined, decimals: number, symbol: string): string {
  if (value === null || value === undefined) return '—';
  return `${amount(value, decimals, 2)} ${symbol}`;
}

/** Health factors use 18 decimals. Aave returns the maximum value when there is no debt. */
export const NO_DEBT = (1n << 256n) - 1n;

export function healthFactor(hf: string | bigint | null | undefined): number | null {
  if (hf === null || hf === undefined) return null;
  const v = BigInt(hf);
  if (v >= NO_DEBT) return null;
  return Number(v) / 1e18;
}

export function healthFactorText(hf: string | bigint | null | undefined): string {
  const v = healthFactor(hf);
  if (v === null) return '∞';
  if (v > 100) return '99+';
  return v.toFixed(2);
}

export function percent(bps: number | null | undefined, digits = 2): string {
  if (bps === null || bps === undefined) return '—';
  return `${(bps / 100).toFixed(digits)}%`;
}

export function shortAddress(address?: string | null): string {
  if (!address) return '—';
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function countdown(seconds: number, lang: 'tr' | 'en' = 'en'): string {
  if (seconds <= 0) return '0';
  const unit = lang === 'tr' ? { d: 'g', h: 's', m: 'dk' } : { d: 'd', h: 'h', m: 'm' };
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}${unit.d} ${h}${unit.h}`;
  if (h > 0) return `${h}${unit.h} ${m}${unit.m}`;
  return `${m}${unit.m}`;
}

/**
 * Parses what a person typed into the integer the contract expects.
 *
 * Only plain decimal digits with one optional point are accepted. Anything else returns zero
 * rather than throwing: this runs while a form is being typed into, so `1e3`, a lone `.` or a
 * minus sign must not take the page down. A negative amount has no meaning for any field here,
 * and reading it as positive would send a transaction nobody asked for.
 */
const DECIMAL = /^\d*(\.\d*)?$/;

export function parseAmount(input: string, decimals: number): bigint {
  const clean = input.trim().replace(',', '.');
  if (!DECIMAL.test(clean) || clean === '' || clean === '.') return 0n;
  const [whole, frac = ''] = clean.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(padded || '0');
}
