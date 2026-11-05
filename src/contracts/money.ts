// Implements: NFR-06 / §7 decimal strings + bigint base units, §10.1 "display values … without trailing zeros",
// §12.5 hand-off rule "base_units = decimal × 10^decimals with string/bigint math; value has no trailing zeros",
// §13.1 address display "first 6 characters + … + last 4 hex".
// Owned by the Orchestrator (frozen contract). Shared by lanes B, C, D. No JS `number` touches an amount.

const DECIMAL_RE = /^\d+(\.\d+)?$/;

/** True for a plain non-negative decimal string like "40", "10.2", "0.5" (§8.4 step 3 / §8.2 step 5 pattern). */
export function isDecimalString(s: string): boolean {
  return DECIMAL_RE.test(s);
}

/** Number of fractional digits after trimming trailing zeros ("1.50" → 1). */
export function fractionDigits(decimal: string): number {
  if (!isDecimalString(decimal)) throw new Error('not a decimal string');
  const frac = decimal.split('.')[1] ?? '';
  return frac.replace(/0+$/, '').length;
}

/** Decimal string → base units. Throws if not a decimal or if it has more significant decimals than `decimals`. */
export function toBaseUnits(decimal: string, decimals: number): bigint {
  if (!isDecimalString(decimal)) throw new Error('not a decimal string');
  if (fractionDigits(decimal) > decimals) throw new Error('too many decimals');
  const [int = '0', frac = ''] = decimal.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(int) * 10n ** BigInt(decimals) + (decimals > 0 ? BigInt(fracPadded) : 0n);
}

/** Base units → canonical decimal string without trailing zeros (and without a trailing "."). Negative allowed. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const int = abs / base;
  const frac = abs % base;
  let s = int.toString();
  if (decimals > 0 && frac > 0n) {
    s += '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  }
  return neg ? `-${s}` : s;
}

/** Canonical form of a decimal string ("010.50" → "10.5"). */
export function normalizeDecimal(decimal: string, decimals: number): string {
  return fromBaseUnits(toBaseUnits(decimal, decimals), decimals);
}

/** a < b → -1, a = b → 0, a > b → 1 (decimal strings, same token decimals). */
export function compareDecimal(a: string, b: string, decimals: number): -1 | 0 | 1 {
  const x = toBaseUnits(a, decimals);
  const y = toBaseUnits(b, decimals);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** floor(a × num / den) in base units (e.g. §10.4 deliverable, §8.4 "half" rounded down). */
export function mulDivFloor(a: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('den must be > 0');
  if (a < 0n || num < 0n) throw new Error('negative operand');
  return (a * num) / den;
}

/** ceil(a × num / den) in base units (e.g. §10.4 padded amount). */
export function mulDivCeil(a: bigint, num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error('den must be > 0');
  if (a < 0n || num < 0n) throw new Error('negative operand');
  return (a * num + den - 1n) / den;
}

/** §13.1 address display: `0x` + 4 hex + `…` + last 4 hex, from the (checksummed) address as given. */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
