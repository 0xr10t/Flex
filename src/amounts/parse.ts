// Implements: §8.4 step 3 "Code parse" (digits with optional commas/decimals; suffix k ×1,000, m ×1,000,000,
// lakh ×100,000, crore ×10,000,000; English number words zero … nine hundred ninety-nine million), §8.4 step 3
// "Precision" (more decimals than the token allows) and "Zero", §13.4 "Number answers go through the S3 code
// parser (no LLM)", I-42, I-43, NFR-06 (string/bigint math only).
// Owner: Lane B. Used by S3/S4 and by the number-answer handlers of lanes C/D.

import type { ParseAmountText, ParsedAmount } from '../contracts/step.js';
import { FIAT_OTHER_WORDS, FIAT_USD_WORDS, TOKENS } from '../contracts/static-tables.js';
import { TOKEN_DECIMALS, type TokenWordKind } from '../contracts/types.js';
import { fractionDigits, fromBaseUnits, toBaseUnits } from '../contracts/money.js';
import { escapeRe } from '../lexical/text.js';

/** Internal scale used before the token precision check (more than any token's decimals). */
const SCALE = 36;

const SUFFIX_EXP: Record<string, number> = {
  k: 3,
  m: 6,
  lakh: 5,
  lakhs: 5,
  crore: 7,
  crores: 7,
};

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/**
 * Token / currency words that may surround the number in a phrase or answer ("50 USDc", "fifty bucks", "$50",
 * "₹500"). They carry no numeric value; the token itself is decided by §8.4's token rules, not here.
 */
const CURRENCY_WORDS: readonly string[] = [
  ...TOKENS.USDC.aliases,
  ...TOKENS.ETH.aliases,
  ...FIAT_USD_WORDS,
  ...FIAT_OTHER_WORDS,
].sort((a, b) => b.length - a.length);

const CURRENCY_SYMBOLS = new Set(['$', '₹', '€', '£']);

const CURRENCY_WORD_RE = new RegExp(
  `(^|[^a-z])(${CURRENCY_WORDS.filter((w) => !CURRENCY_SYMBOLS.has(w))
    .map(escapeRe)
    .join('|')})(?=$|[^a-z0-9])`,
  'g',
);

/** Currency markers removed by the numeric parser; callers must still validate the complete amount text. */
export function amountCurrencyKinds(text: string): ReadonlySet<TokenWordKind> {
  const lower = text.toLowerCase();
  const kinds = new Set<TokenWordKind>();
  const add = (word: string): void => {
    if (FIAT_USD_WORDS.includes(word)) kinds.add('FIAT_USD');
    else if (FIAT_OTHER_WORDS.includes(word)) kinds.add('FIAT_OTHER');
    else kinds.add(TOKENS.USDC.aliases.includes(word) ? 'USDC' : 'ETH');
  };
  for (const symbol of CURRENCY_SYMBOLS) if (lower.includes(symbol)) add(symbol);
  for (const match of lower.matchAll(CURRENCY_WORD_RE)) if (match[2] !== undefined) add(match[2]);
  return kinds;
}

/** Removes currency and one trailing "more" (§17.2: a new amount, never an addition to the previous payment). */
function numericCore(text: string): string {
  let s = text.toLowerCase();
  for (const sym of CURRENCY_SYMBOLS) s = s.split(sym).join(' ');
  s = s.replace(CURRENCY_WORD_RE, '$1 ');
  return s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/ more$/, '');
}

/** Shifts a plain decimal string by 10^exp (exp ≥ 0) and returns it at SCALE decimals as bigint. */
function scaled(decimal: string, exp: number): bigint | null {
  if (!/^\d+(\.\d+)?$/.test(decimal)) return null;
  if (fractionDigits(decimal) > SCALE) return null;
  return toBaseUnits(decimal, SCALE) * 10n ** BigInt(exp);
}

/** "1,000" / "10,00,000" / "1000.5" → plain decimal, or null. Commas only between digits. */
function digitsCore(s: string): string | null {
  const m = /^(\d{1,3}(?:,\d{2,3})+|\d+)(\.\d+)?$/.exec(s);
  if (!m) return null;
  return (m[1] ?? '').replace(/,/g, '') + (m[2] ?? '');
}

/** Syntax-only span check; fiat conversion and decimals beyond parser/token precision still need questions. */
export function isAbsoluteAmountPhrase(text: string): boolean {
  const normalized = text.replace(/\brs\.\s*/gi, 'rs ').replace(/\s+(?:worth\s+)?of\s+/i, ' ');
  const parsed = parseAmountText(normalized, null);
  if (parsed.ok || parsed.reason === 'zero') return true;
  const core = numericCore(normalized).replace(/^\.(?=\d)/, '0.');
  const digits = /^([\d,]+(?:\.\d+)?)\s*(k|m|lakhs?|crores?)?$/.exec(core);
  return digits !== null && digitsCore(digits[1] ?? '') !== null;
}

function parseDigits(core: string): bigint | null {
  // number, optional space, optional suffix
  const numeric = core.replace(/^\.(?=\d)/, '0.');
  const m = /^([\d,]+(?:\.\d+)?)\s*(k|m|lakhs?|crores?)?$/.exec(numeric);
  if (!m) return null;
  const plain = digitsCore(m[1] ?? '');
  if (plain === null) return null;
  const exp = m[2] !== undefined ? (SUFFIX_EXP[m[2]] ?? 0) : 0;
  return scaled(plain, exp);
}

/**
 * English number words zero … nine hundred ninety-nine million ("fifty", "two hundred and five",
 * "twenty-five thousand"), optionally followed by lakh/crore ("five lakh", "two crore" — §8.10 LLM #1 rule 3).
 */
function parseWords(core: string): bigint | null {
  const words = core
    .replace(/-/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0);
  if (words.length === 0) return null;
  let suffixExp = 0;
  const last = words[words.length - 1];
  if (last !== undefined && (last === 'lakh' || last === 'lakhs' || last === 'crore' || last === 'crores')) {
    suffixExp = SUFFIX_EXP[last] ?? 0;
    words.pop();
    if (words.length === 0) return null;
  }
  let total = 0n; // completed millions/thousands
  let group = 0n; // current group < 1000
  let sawNumber = false;
  let lastKind: 'none' | 'unit' | 'teen' | 'tens' | 'hundred' | 'scale' | 'and' = 'none';
  let seenThousand = false;
  let seenMillion = false;
  for (const w of words) {
    if (w === 'and') {
      if (lastKind !== 'hundred' && lastKind !== 'scale') return null;
      lastKind = 'and';
      continue;
    }
    const unit = UNITS[w];
    const tens = TENS[w];
    if (unit !== undefined) {
      if (lastKind === 'unit' || lastKind === 'teen') return null;
      if (lastKind === 'tens' && unit >= 10) return null;
      if (lastKind === 'tens' && unit === 0) return null;
      if (unit === 0 && sawNumber) return null;
      group += BigInt(unit);
      lastKind = unit >= 10 ? 'teen' : 'unit';
      sawNumber = true;
      continue;
    }
    if (tens !== undefined) {
      if (lastKind === 'unit' || lastKind === 'teen' || lastKind === 'tens') return null;
      if (group % 100n !== 0n) return null;
      group += BigInt(tens);
      lastKind = 'tens';
      sawNumber = true;
      continue;
    }
    if (w === 'hundred') {
      if (lastKind !== 'unit' && lastKind !== 'teen') return null;
      if (group === 0n || group >= 100n) return null;
      group *= 100n;
      lastKind = 'hundred';
      continue;
    }
    if (w === 'thousand') {
      if (!sawNumber || group === 0n || seenThousand) return null;
      total += group * 1000n;
      group = 0n;
      seenThousand = true;
      lastKind = 'scale';
      continue;
    }
    if (w === 'million') {
      if (!sawNumber || group === 0n || seenMillion || seenThousand || total !== 0n) return null;
      total += group * 1000000n;
      group = 0n;
      seenMillion = true;
      lastKind = 'scale';
      continue;
    }
    return null;
  }
  if (!sawNumber || lastKind === 'and') return null;
  const value = total + group;
  if (value > 999999999n) return null;
  return value * 10n ** BigInt(SCALE) * 10n ** BigInt(suffixExp);
}

/**
 * §8.4 step 3 code parser. Returns the canonical decimal string (no trailing zeros) or why it failed.
 * `token` decides the precision check (USDC 6, ETH 18); with a null token only the zero check applies.
 */
export const parseAmountText: ParseAmountText = (text: string, token): ParsedAmount => {
  const core = numericCore(text);
  if (core.length === 0) return { ok: false, reason: 'unparseable' };
  const value = parseDigits(core) ?? parseWords(core);
  if (value === null) return { ok: false, reason: 'unparseable' };
  if (value === 0n) return { ok: false, reason: 'zero' };
  const canonical = fromBaseUnits(value, SCALE);
  if (token !== null && fractionDigits(canonical) > TOKEN_DECIMALS[token]) {
    return { ok: false, reason: 'precision' };
  }
  return { ok: true, value: canonical };
};
