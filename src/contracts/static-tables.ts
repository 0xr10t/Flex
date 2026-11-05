// Implements: §6.2 static tables (verbatim word lists). Owned by the Orchestrator (frozen contract) so that
// Lane A (config) and Lane B (lexical) share one copy. Regex construction from these lists is Lane B's.

import type { Token } from './types.js';

export const TOKENS: Readonly<Record<Token, { decimals: 6 | 18; native: boolean; aliases: readonly string[] }>> = {
  // `dollars` marks fiat USD (§8.4), see FIAT_USD_WORDS.
  USDC: { decimals: 6, native: false, aliases: ['usdc', 'usd coin', 'usdc.e', 'dollars'] },
  // `ethereum`/`eth` are disambiguated chain-vs-token in §8.3 rule 5.
  ETH: { decimals: 18, native: true, aliases: ['eth', 'ether', 'ethereum'] },
};

/** §6.2 "any other ticker-like word adjacent to an amount (`dai`, `usdt`, `weth`, `matic`, `sol`, `btc`, …)". */
export const UNSUPPORTED_TOKEN_EXAMPLES: readonly string[] = ['dai', 'usdt', 'weth', 'matic', 'sol', 'btc'];

export const MAINNET_WORDS: readonly string[] = [
  'mainnet',
  'base mainnet',
  'arbitrum one',
  'ethereum mainnet',
  'polygon',
  'optimism',
  'bsc',
];

/** §6.2 recurrence words as listed (patterns in parentheses are the spec's notation). */
export const RECURRENCE_WORDS: readonly string[] = [
  'every',
  'each (day|week|month|monday…)',
  'daily',
  'weekly',
  'monthly',
  'per (day|week|month)',
  '(\\d+|one|two|three…) times a (week|day|month)',
  'fortnightly',
];

export const CANCEL_WORDS: readonly string[] = ['stop', 'cancel', 'end', 'terminate', 'turn off'];

export const BACK_REFERENCE_WORDS: readonly string[] = [
  'more',
  'again',
  'same',
  'another',
  'her',
  'him',
  'them',
  'they',
  'same person',
];

/** "when not part of a recurrence phrase" (§6.2, §8.3 rule 9). */
export const DISTRIBUTIVE_WORDS: readonly string[] = ['each', 'apiece', 'every one', 'per person', 'both'];

export const SPLIT_WORDS: readonly string[] = ['split', 'divide', 'share between', 'share among'];

export const GROUP_MARKERS: readonly string[] = [
  'everyone under',
  'everyone in',
  'all of',
  'all members of',
  'everyone with @',
  'everyone at @',
  '@<domain>',
];

/** §8.3 rule 7 fiat words. */
export const FIAT_USD_WORDS: readonly string[] = ['$', 'dollars', 'bucks', 'usd'];
export const FIAT_OTHER_WORDS: readonly string[] = ['₹', 'rs', 'rupees', 'inr', '€', 'euro', '£', 'pounds'];

/** §8.3 rule 5: `eth`/`ethereum` count as a chain only with these neighbours. */
export const ETH_CHAIN_PRECEDERS: readonly string[] = ['on', 'via', 'over', 'using'];
export const ETH_CHAIN_FOLLOWERS: readonly string[] = ['chain', 'network', 'l1'];

/** §8.3 rule 1 clause-splitting words (whole words, case-insensitive) and punctuation. */
export const CLAUSE_SPLIT_WORDS: readonly string[] = ['and', 'then', 'also', 'plus'];
export const CLAUSE_SPLIT_CHARS: readonly string[] = ['.', '!', '?', ';', '\n', ','];

/** §17.3 texts. */
export const CANCEL_TEXTS: readonly string[] = ['cancel', 'stop', 'abort', 'never mind', 'nevermind', 'forget it'];
export const CONFIRM_YES_TEXTS: readonly string[] = [
  'yes',
  'y',
  'confirm',
  'go ahead',
  'ok',
  'okay',
  'do it',
  'send it',
];
export const CONFIRM_NO_TEXTS: readonly string[] = ['no', 'n', "don't", 'dont', 'stop'];

/** §8.6 rule 2 / §8.10 LLM #3 rule 2. */
export const SELF_WORDS: readonly string[] = ['me', 'my', 'i'];
