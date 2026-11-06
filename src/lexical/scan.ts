// Implements: §8.3 S2 lexical scan rules 1–10 (clauses, addresses, ENS candidates, group markers, chains incl.
// eth chain-vs-token, mainnet/unsupported chains, tokens/fiat/unsupported tokens, chrono spans, recurrence /
// cancel / back-reference / distributive / split flags, numeric candidates). §6.2 static tables.
// Owner: Lane B. Pure function of (typed_text, chain config, now). No model involved.

import { normalize } from 'viem/ens';
import type { DateTime } from 'luxon';
import { parseAmountText } from '../amounts/parse.js';
import { ETH_CHAIN_FOLLOWERS, ETH_CHAIN_PRECEDERS, MAINNET_WORDS } from '../contracts/static-tables.js';
import type {
  ChainConfig,
  ChainMention,
  ChronoSpan,
  Clause,
  EnsCandidate,
  ErrorCode,
  GroupCandidate,
  LexicalScan,
  Span,
  TokenMention,
  WordFlag,
} from '../contracts/types.js';
import { chronoSpans } from './chrono.js';
import {
  ADDRESS_SCAN_RE,
  BACK_REFERENCE_RE,
  CANCEL_RE,
  CLAUSE_CHAR_RE,
  CLAUSE_WORD_RE,
  COUNT_AFTER_RE,
  DISTRIBUTIVE_RE,
  ENS_SCAN_RE,
  GROUP_AT_MARKER_RE,
  GROUP_MEMBERS_MARKER_RE,
  GROUP_WORD_MARKER_RE,
  LINK_MARKER_RE,
  NUMBER_WORD_RE,
  NUMBER_WORD_RUN_RE,
  NUMERIC_RE,
  ORDINAL_AFTER_RE,
  PLAIN_NUMBER_RE,
  RECURRENCE_RES,
  SPLIT_RE,
  TOKEN_PATTERNS,
  UNSUPPORTED_CHAIN_EXAMPLES,
  UNSUPPORTED_TOKEN_RE,
  URL_SCAN_RE,
  tokenPatternRe,
} from './patterns.js';
import {
  clauseIndexAt,
  inside,
  overlaps,
  overlapsAny,
  tokenAfter,
  tokenBefore,
  wordAfter,
  wordBefore,
  wordRe,
  type Range,
} from './text.js';

export interface ScanOptions {
  chains: readonly ChainConfig[];
  /** Now in the session timezone (chrono reference). */
  now: DateTime;
}

export type ScanResult =
  | { ok: true; scan: LexicalScan }
  | {
      ok: false;
      code: Extract<ErrorCode, 'MAINNET_NOT_SUPPORTED' | 'UNSUPPORTED_CHAIN' | 'UNSUPPORTED_TOKEN'>;
      params?: Record<string, string>;
    };

function matches(re: RegExp, text: string): Array<Range & { text: string; m: RegExpExecArray }> {
  const out: Array<Range & { text: string; m: RegExpExecArray }> = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (let m = r.exec(text); m !== null; m = r.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], m });
    if (m[0].length === 0) r.lastIndex++;
  }
  return out;
}

/**
 * §8.3 rule 1. Separators inside an address, ENS name, number or link are not clause separators
 * ("0.5", "1,000", "riya.eth"); see SQB-04.
 */
function splitClauses(text: string, protectedRanges: readonly Range[]): Clause[] {
  const seps: Range[] = [];
  for (const re of [CLAUSE_CHAR_RE, CLAUSE_WORD_RE]) {
    for (const s of matches(re, text)) if (!overlapsAny(s, protectedRanges)) seps.push(s);
  }
  seps.sort((a, b) => a.start - b.start);
  const clauses: Clause[] = [];
  let pos = 0;
  const push = (from: number, to: number): void => {
    let s = from;
    let e = to;
    while (s < e && /\s/.test(text[s] ?? '')) s++;
    while (e > s && /\s/.test(text[e - 1] ?? '')) e--;
    if (e > s) clauses.push({ index: clauses.length, start: s, end: e, text: text.slice(s, e) });
  };
  for (const s of seps) {
    if (s.start < pos) continue;
    push(pos, s.start);
    pos = s.end;
  }
  push(pos, text.length);
  return clauses;
}

function span(r: Range & { text: string }, clauses: Clause[]): Span {
  return { text: r.text, start: r.start, end: r.end, clause_index: clauseIndexAt(clauses, r.start) };
}

const NUMBER_TOKEN_RE = /^[$₹€£]?\d[\d,]*(?:\.\d+)?(?:k|m|lakhs?|crores?)?$/i;

/** "Adjacent to a number" (§8.3 rule 7): a digit number ("10", "5k", "$5") or an English number word. */
function isNumberToken(tok: string | null): boolean {
  if (tok === null) return false;
  const t = tok.replace(/^[(]+/, '').replace(/[.,;:!?)]+$/, '');
  if (NUMBER_TOKEN_RE.test(t)) return true;
  if (!/^[a-z-]+$/i.test(t)) return false;
  const p = parseAmountText(t, null);
  return p.ok || p.reason === 'zero';
}

/**
 * Number-word phrases that `parseAmountText` reads ("two hundred and five"), so an "and" inside one is not a clause
 * separator (SQB-04, R2-2). Within a run of number words, the longest parseable prefix is taken, then the rest of
 * the run is scanned the same way ("five and two" is not one number, so its "and" still separates).
 */
function numberWordPhrases(text: string): Range[] {
  const out: Range[] = [];
  for (const run of matches(NUMBER_WORD_RUN_RE, text)) {
    const words = matches(NUMBER_WORD_RE, run.text).map((w) => ({
      start: run.start + w.start,
      end: run.start + w.end,
    }));
    let i = 0;
    while (i < words.length) {
      let best = -1;
      for (let j = words.length - 1; j > i; j--) {
        const first = words[i] as Range;
        const last = words[j] as Range;
        const p = parseAmountText(text.slice(first.start, last.end), null);
        if (p.ok || p.reason === 'zero') {
          best = j;
          break;
        }
      }
      if (best > i) {
        out.push({ start: (words[i] as Range).start, end: (words[best] as Range).end });
        i = best + 1;
      } else {
        i++;
      }
    }
  }
  return out;
}

/** §8.3 S2. Returns the scan, or the stopping error of rule 6 / rule 7. */
export function lexicalScan(text: string, opts: ScanOptions): ScanResult {
  // ── protected ranges (addresses, ENS-like names, numbers, links) ──
  const addressMatches = matches(ADDRESS_SCAN_RE, text);
  const urlMatches = matches(URL_SCAN_RE, text);
  const linkMarkers = matches(LINK_MARKER_RE, text);
  const ensRaw = matches(ENS_SCAN_RE, text);
  // A leading dot in ".team.eth" must not split the amount and recipient into different clauses.
  // Protect that dot while keeping the actual ENS candidate and its offsets on team.eth.
  const ensProtected = ensRaw.map((m) =>
    text[m.start - 1] === '.' && (m.start === 1 || /\s/.test(text[m.start - 2] ?? ''))
      ? { ...m, start: m.start - 1 }
      : m,
  );
  const numbersRaw = matches(PLAIN_NUMBER_RE, text);
  const numberWords = numberWordPhrases(text);
  const clauses = splitClauses(text, [
    ...addressMatches,
    ...urlMatches,
    ...linkMarkers,
    ...ensProtected,
    ...numbersRaw,
    ...numberWords,
  ]);

  // ── rule 2: addresses ──
  const addresses = addressMatches.map((m) => span(m, clauses));

  // ── rule 4: group markers ──
  const groups: GroupCandidate[] = [];
  for (const re of [GROUP_WORD_MARKER_RE, GROUP_AT_MARKER_RE, GROUP_MEMBERS_MARKER_RE]) {
    for (const m of matches(re, text)) {
      const parent = m.m[1] ?? '';
      const start = m.start + m.text.lastIndexOf(parent);
      const r = { start, end: start + parent.length, text: parent };
      if (groups.some((g) => overlaps(g, r))) continue;
      if (overlapsAny(r, urlMatches)) continue;
      groups.push({ ...span(r, clauses), parent });
    }
  }
  groups.sort((a, b) => a.start - b.start);

  // ── rule 3: ENS candidates (not inside an email or URL; not a group parent; normalize() must pass) ──
  const ens: EnsCandidate[] = [];
  for (const m of ensRaw) {
    if (overlapsAny(m, urlMatches) || overlapsAny(m, groups) || overlapsAny(m, addressMatches)) continue;
    const prev = text[m.start - 1] ?? '';
    const next = text[m.end] ?? '';
    const prevPrev = text[m.start - 2] ?? '';
    if (prev === '@' && /\S/.test(prevPrev)) continue; // domain part of an email
    if (next === '@') continue; // local part of an email
    let normalized: string;
    try {
      normalized = normalize(m.text);
    } catch {
      continue;
    }
    ens.push({ ...span(m, clauses), normalized });
  }

  const nameRanges: Range[] = [...addressMatches, ...ens, ...groups, ...urlMatches, ...linkMarkers];

  // ── rule 6: mainnet words / unsupported chains ──
  for (const m of matches(wordRe(UNSUPPORTED_CHAIN_EXAMPLES), text)) {
    if (overlapsAny(m, nameRanges)) continue;
    const before = wordBefore(text, m.start);
    if (before === 'on' || before === 'via') {
      return { ok: false, code: 'UNSUPPORTED_CHAIN', params: { word: m.text } };
    }
  }
  for (const m of matches(wordRe(MAINNET_WORDS), text)) {
    if (overlapsAny(m, nameRanges)) continue;
    return { ok: false, code: 'MAINNET_NOT_SUPPORTED' };
  }

  // ── rule 5: chains ──
  const chains: ChainMention[] = [];
  const claimed: Range[] = [...nameRanges];
  const aliasList: Array<{ alias: string; chain: ChainConfig }> = [];
  for (const c of opts.chains) for (const a of c.aliases) aliasList.push({ alias: a.toLowerCase(), chain: c });
  // `eth` is not an alias in config but counts as the chain whose aliases include "ethereum" (§8.3 rule 5).
  const ethChain = opts.chains.find((c) => c.aliases.some((a) => a.toLowerCase() === 'ethereum'));
  if (ethChain && !aliasList.some((a) => a.alias === 'eth')) aliasList.push({ alias: 'eth', chain: ethChain });
  aliasList.sort((a, b) => b.alias.length - a.alias.length);
  for (const { alias, chain } of aliasList) {
    for (const m of matches(wordRe([alias]), text)) {
      if (overlapsAny(m, claimed)) continue;
      if (alias === 'eth' || alias === 'ethereum') {
        const before = wordBefore(text, m.start);
        const after = wordAfter(text, m.end);
        const isChain =
          (before !== null && ETH_CHAIN_PRECEDERS.includes(before)) ||
          (after !== null && ETH_CHAIN_FOLLOWERS.includes(after));
        if (!isChain) continue;
      }
      claimed.push(m);
      chains.push({ ...span(m, clauses), word: m.text, chain_id: chain.chain_id });
    }
  }
  chains.sort((a, b) => a.start - b.start);

  // ── rule 7: tokens ──
  const tokens: TokenMention[] = [];
  const tokenClaimed: Range[] = [...claimed];
  const patterns = [...TOKEN_PATTERNS].sort((a, b) => b.word.length - a.word.length);
  for (const p of patterns) {
    for (const m of matches(tokenPatternRe(p), text)) {
      if (overlapsAny(m, tokenClaimed)) continue;
      tokenClaimed.push(m);
      tokens.push({ ...span(m, clauses), word: m.text, kind: p.kind });
    }
  }
  tokens.sort((a, b) => a.start - b.start);
  for (const m of matches(UNSUPPORTED_TOKEN_RE, text)) {
    if (overlapsAny(m, nameRanges)) continue;
    // A compound number may end in "hundred" or "thousand", neither of which parses on its own (B12).
    const adjacentNumberWords = numberWords.some(
      (n) =>
        (n.end <= m.start && text.slice(n.end, m.start).trim() === '') ||
        (n.start >= m.end && text.slice(m.end, n.start).trim() === ''),
    );
    if (adjacentNumberWords || isNumberToken(tokenBefore(text, m.start)) || isNumberToken(tokenAfter(text, m.end))) {
      return { ok: false, code: 'UNSUPPORTED_TOKEN' };
    }
  }

  // ── rule 8: dates / times ──
  const dates: ChronoSpan[] = chronoSpans(text, opts.now).map((c) => ({
    text: c.text,
    start: c.start,
    end: c.end,
    clause_index: clauseIndexAt(clauses, c.start),
    kind: c.kind,
    date: c.date,
    time: c.time,
  }));

  // ── rule 9: flags ──
  const flags = (re: RegExp, exclude: readonly Range[] = []): WordFlag[] =>
    matches(re, text)
      .filter((m) => !overlapsAny(m, nameRanges) && !overlapsAny(m, exclude))
      .map((m) => ({ ...span(m, clauses), word: m.text }));
  const recurrence: WordFlag[] = [];
  for (const re of RECURRENCE_RES) {
    for (const f of flags(re)) if (!recurrence.some((r) => overlaps(r, f))) recurrence.push(f);
  }
  recurrence.sort((a, b) => a.start - b.start);
  const cancel = flags(CANCEL_RE);
  const back_reference = flags(BACK_REFERENCE_RE);
  // "A distributive word inside a recurrence phrase ("each week") is not distributive."
  const distributive = flags(DISTRIBUTIVE_RE).filter((d) => !recurrence.some((r) => inside(d, r)));
  const split = flags(SPLIT_RE);

  // ── rule 10: numeric candidates ──
  const numeric_candidates: Span[] = [];
  for (const m0 of matches(NUMERIC_RE, text)) {
    const t = m0.text.replace(/,+$/, '');
    const m = { start: m0.start, end: m0.start + t.length, text: t };
    if (overlapsAny(m, nameRanges)) continue;
    if (dates.some((d) => overlaps(m, d))) continue;
    const rest = text.slice(m.end);
    if (ORDINAL_AFTER_RE.test(rest)) continue;
    if (COUNT_AFTER_RE.test(rest)) continue;
    numeric_candidates.push(span(m, clauses));
  }

  return {
    ok: true,
    scan: {
      clauses,
      addresses,
      ens,
      groups,
      chains,
      tokens,
      dates,
      recurrence,
      cancel,
      back_reference,
      distributive,
      split,
      numeric_candidates,
    },
  };
}
