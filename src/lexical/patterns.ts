// Implements: §8.3 rules 2, 3, 4, 7, 9, 10 regexes, built from the §6.2 static tables (src/contracts/static-tables.ts).
// Owner: Lane B. Regex construction from the shared word lists is Lane B's (static-tables.ts header).

import {
  BACK_REFERENCE_WORDS,
  CANCEL_WORDS,
  DISTRIBUTIVE_WORDS,
  FIAT_OTHER_WORDS,
  FIAT_USD_WORDS,
  SPLIT_WORDS,
  TOKENS,
  UNSUPPORTED_TOKEN_EXAMPLES,
} from '../contracts/static-tables.js';
import type { TokenWordKind } from '../contracts/types.js';
import { escapeRe, wordRe } from './text.js';

/** §8.3 rule 2 (global, for scanning). */
export const ADDRESS_SCAN_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
/** §9.2 step 1 / §8.6 rule 3 full-string address check. */
export const ADDRESS_FULL_RE = /^0x[0-9a-fA-F]{40}$/;

/** §8.3 rule 3 ENS regex (case-insensitive). */
export const ENS_SCAN_RE = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|xyz|com|org|in|io|ac\.in|co)\b/gi;

/** URLs in typed text (S1 replaces https ones by `[link N]`; any left are never ENS candidates). */
export const URL_SCAN_RE = /https?:\/\/[^\s<>"']+/gi;
/** The `[link N]` markers S1 writes into typed_text. */
export const LINK_MARKER_RE = /\[link \d+\]/g;

/** A dotted name (parent of a group marker). */
const DOTTED = '[a-z0-9-]+(?:\\.[a-z0-9-]+)+';

/**
 * §8.3 rule 4 / §6.2 group markers. Word markers ("everyone under X", "everyone in X", "all of X",
 * "all members of X") take the following dotted name as the parent; "everyone with @X", "everyone at @X" and a
 * bare "@X" (not part of an email) take the domain after "@". See spec-questions/B.md SQB-05.
 */
export const GROUP_WORD_MARKER_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:everyone\\s+under|everyone\\s+in|all\\s+members\\s+of|all\\s+of)\\s+(${DOTTED})`,
  'gi',
);
export const GROUP_AT_MARKER_RE = new RegExp(`(?<![A-Za-z0-9._%+-])@(${DOTTED})`, 'gi');

/** Mainnet words: §6.2 (whole words). */
export { MAINNET_WORDS } from '../contracts/static-tables.js';

/**
 * §8.3 rule 6 names `polygon` and `solana` as examples of "chain-like word after on/via that is not an alias".
 * The spec lists no other names ("…"); see spec-questions/B.md SQB-03.
 */
export const UNSUPPORTED_CHAIN_EXAMPLES: readonly string[] = ['polygon', 'solana'];

/** §8.3 rule 7 token words. */
export interface TokenPattern {
  word: string;
  kind: TokenWordKind;
}
export const TOKEN_PATTERNS: readonly TokenPattern[] = [
  // §6.2 footnote: `dollars` marks fiat USD, so it is not a USDC token word here.
  ...TOKENS.USDC.aliases.filter((w) => !FIAT_USD_WORDS.includes(w)).map((word) => ({ word, kind: 'USDC' as const })),
  ...TOKENS.ETH.aliases.map((word) => ({ word, kind: 'ETH' as const })),
  ...FIAT_USD_WORDS.map((word) => ({ word, kind: 'FIAT_USD' as const })),
  ...FIAT_OTHER_WORDS.map((word) => ({ word, kind: 'FIAT_OTHER' as const })),
];

const SYMBOLS = new Set(['$', '₹', '€', '£']);

/** One regex per token pattern: symbols match anywhere, words as whole words. */
export function tokenPatternRe(p: TokenPattern): RegExp {
  return SYMBOLS.has(p.word) ? new RegExp(escapeRe(p.word), 'g') : wordRe([p.word]);
}

export const UNSUPPORTED_TOKEN_RE = wordRe(UNSUPPORTED_TOKEN_EXAMPLES);

/**
 * §6.2 recurrence words: `every`, `each (day|week|month|monday…)`, `daily`, `weekly`, `monthly`,
 * `per (day|week|month)`, `(\d+|one|two|three…) times a (week|day|month)`, `fortnightly`.
 * "every one" is a distributive word (§6.2), not a recurrence.
 */
const WEEKDAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const SMALL_NUMBER_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
export const RECURRENCE_RES: readonly RegExp[] = [
  /(?<![A-Za-z0-9_])every(?!\s+one(?![A-Za-z0-9_]))(?![A-Za-z0-9_])/gi,
  new RegExp(`(?<![A-Za-z0-9_])each\\s+(?:day|week|month|${WEEKDAYS})s?(?![A-Za-z0-9_])`, 'gi'),
  /(?<![A-Za-z0-9_])(?:daily|weekly|monthly|fortnightly)(?![A-Za-z0-9_])/gi,
  /(?<![A-Za-z0-9_])per\s+(?:day|week|month)(?![A-Za-z0-9_])/gi,
  new RegExp(
    `(?<![A-Za-z0-9_])(?:\\d+|${SMALL_NUMBER_WORDS})\\s+times\\s+a\\s+(?:week|day|month)(?![A-Za-z0-9_])`,
    'gi',
  ),
];

/**
 * §6.2 cancel words `stop`, `cancel`, `end`, `terminate`, `turn off`, matched as whole words including their
 * inflections ("stopping", "cancelled", "turned off"); see spec-questions/B.md SQB-07.
 */
export const CANCEL_RE = new RegExp(
  `(?<![A-Za-z0-9_])(?:${CANCEL_WORDS.filter((w) => !w.includes(' '))
    .map(escapeRe)
    .join(
      '|',
    )})(?:s|ed|ing|ped|ping|led|ling)?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])turn(?:s|ed|ing)?\\s+off(?![A-Za-z0-9_])`,
  'gi',
);

export const BACK_REFERENCE_RE = wordRe(BACK_REFERENCE_WORDS);
export const DISTRIBUTIVE_RE = wordRe(DISTRIBUTIVE_WORDS);
export const SPLIT_RE = wordRe(SPLIT_WORDS);

/**
 * §8.3 rule 10 numeric tokens `\d[\d,]*(\.\d+)?\s*(k|m|lakh|lakhs|crore|crores)?`. A number glued to letters on
 * its left ("web3") or continuing a decimal is not a separate token; the suffix must end a word.
 */
export const NUMERIC_RE =
  /(?<![A-Za-z0-9_])(?<!\d[.,])\d[\d,]*(?:\.\d+)?(?:\s*(?:k|m|lakhs?|crores?)(?![A-Za-z0-9_]))?/gi;

/** Rule 10 exclusions: ordinal suffix right after the digits, or followed by a count word. */
export const ORDINAL_AFTER_RE = /^(?:st|nd|rd|th)(?![A-Za-z0-9_])/i;
export const COUNT_AFTER_RE = /^\s*(?:(?:time|week|day|month|payment)s?|x)(?![A-Za-z0-9_])/i;

/** Clause separators (§8.3 rule 1). */
export const CLAUSE_CHAR_RE = /[.!?;\n,]/g;
export const CLAUSE_WORD_RE = /(?<![A-Za-z0-9_])(?:and|then|also|plus)(?![A-Za-z0-9_])/gi;

/** Plain numbers (protected from clause splitting: "0.5", "1,000"). */
export const PLAIN_NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;
