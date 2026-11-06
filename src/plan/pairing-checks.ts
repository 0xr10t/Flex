// Implements: §8.9 S8 code checks P1–P9 (retryable problems vs. terminal errors) with P4 relaxed per SQ-O-03 and the
// Q_PAIR_AMOUNT trigger (F-11), §16.1 (untrusted values in a `k`), P10 (§16.1 "every value from the model is checked by
// code", §10.6 "only days the user named"): the schedule fields of a `k` must be written in the payment's clauses.
// SQ-R-02: a distributive word relaxes P2, P4 and the Q_PAIR_AMOUNT trigger only for amounts in its own clause.
// Correction texts name placeholders only (never values), so the retry prompt keeps §16.1.

import type { StepContext } from '../contracts/step.js';
import type { AmountPh, ChainId, ErrorCode, Frequency, Payment, RecipientPh, Weekday } from '../contracts/types.js';
import { chainName, isGroupPh, recipientNameOf } from './common.js';
import { chainBindingProblems } from './chain-binding.js';
import { parseCount } from './answers.js';
import { WEEKDAYS } from './schedule.js';

export interface PairingContext {
  /** Confirmed pay amount placeholders of this request (the S8 amount enum without null). */
  amounts: AmountPh[];
  /** Every recipient placeholder offered to S8 (RECIPIENTS + SESSION). */
  recipients: RecipientPh[];
  /** S2 chain IDs. */
  chains: ChainId[];
}

export type PairingOutcome =
  | { kind: 'ok' }
  | { kind: 'retry'; problems: string[] }
  | { kind: 'error'; code: ErrorCode; params?: Record<string, string> };

const SCHEDULE_FIELDS = ['frequency', 'interval', 'times_per_week', 'days_of_week', 'day_of_month'] as const;

function amountClause(ctx: StepContext, ph: AmountPh): number | null {
  return ctx.req.amounts.find((a) => a.placeholder === ph)?.span?.clause_index ?? null;
}

function recipientClause(ctx: StepContext, ph: RecipientPh): number | null {
  const ref = ctx.req.recipients.find((r) => r.placeholder === ph);
  if (!ref) return null;
  return ctx.req.spans[ref.span_index]?.span?.clause_index ?? null;
}

/** SQ-R-02: the amount sits in a clause holding a distributive word ("each", …). */
export function isDistributiveAmount(ctx: StepContext, ph: AmountPh | null): boolean {
  if (ph === null) return false;
  const ac = amountClause(ctx, ph);
  return ac !== null && ctx.req.scan.distributive.some((d) => d.clause_index === ac);
}

// ───────────────────────────── P10: schedule fields of a `k` ─────────────────────────────

const B = '(?<![A-Za-z0-9_])';
const E = '(?![A-Za-z0-9_])';
const NUM_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const ORDINAL_WORDS: Readonly<Record<string, number>> = {
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};
const DAY_NAMES: Readonly<Record<Weekday, string>> = {
  MON: 'monday|mon',
  TUE: 'tuesday|tues|tue',
  WED: 'wednesday|wed',
  THU: 'thursday|thurs|thur|thu',
  FRI: 'friday|fri',
  SAT: 'saturday|sat',
  SUN: 'sunday|sun',
};
const WEEKDAY_WORDS = Object.values(DAY_NAMES).join('|');
const UNIT = `(day|week|month|fortnight|${WEEKDAY_WORDS})s?`;

function unitFrequency(unit: string): Frequency {
  const u = unit.toLowerCase();
  if (u === 'day') return 'daily';
  if (u === 'month') return 'monthly';
  return 'weekly'; // week, fortnight (handled by the caller) and weekdays
}

function wordNumber(w: string): number | null {
  const lower = w.toLowerCase();
  const ord = ORDINAL_WORDS[lower];
  if (ord !== undefined) return ord;
  const digits = /^(\d+)(?:st|nd|rd|th)?$/.exec(lower);
  if (digits?.[1] !== undefined) return Number(digits[1]);
  return parseCount(lower);
}

interface IntervalPhrase {
  phrase: string;
  interval: number;
  frequency: Frequency;
}

/** "every other <unit>" → 2, "every N <unit>s" / "every Nth <unit>" → N, "fortnightly" / "every fortnight" → weekly 2. */
export function intervalPhrases(text: string): IntervalPhrase[] {
  const out: IntervalPhrase[] = [];
  const push = (phrase: string, interval: number, unit: string): void => {
    const fortnight = unit.toLowerCase() === 'fortnight';
    out.push({ phrase, interval: fortnight ? interval * 2 : interval, frequency: unitFrequency(unit) });
  };
  for (const m of text.matchAll(new RegExp(`${B}every\\s+other\\s+${UNIT}${E}`, 'gi'))) push(m[0], 2, m[1] ?? '');
  const nRe = new RegExp(
    `${B}every\\s+(\\d+(?:st|nd|rd|th)?|${NUM_WORDS}|${Object.keys(ORDINAL_WORDS).join('|')})\\s+${UNIT}${E}`,
    'gi',
  );
  for (const m of text.matchAll(nRe)) {
    const n = wordNumber(m[1] ?? '');
    if (n !== null) push(m[0], n, m[2] ?? '');
  }
  for (const m of text.matchAll(new RegExp(`${B}(?:fortnightly|every\\s+fortnight)${E}`, 'gi'))) {
    out.push({ phrase: m[0], interval: 2, frequency: 'weekly' });
  }
  return out;
}

/** "for N weeks/months/days/payments/times": how long, never how often. */
export function durationPhrase(text: string): string | null {
  const re = new RegExp(
    `${B}for\\s+(?:the\\s+next\\s+)?(?:\\d+|${NUM_WORDS})\\s+(?:day|week|month|payment|time)s?${E}`,
    'i',
  );
  return re.exec(text)?.[0] ?? null;
}

/** Weekdays named in the text ("monday", "fri", "mondays"; "weekdays" → MON–FRI, "weekends" → SAT, SUN). */
export function namedDays(text: string): Set<Weekday> {
  const out = new Set<Weekday>();
  for (const d of WEEKDAYS) {
    if (new RegExp(`${B}(?:${DAY_NAMES[d]})s?${E}`, 'i').test(text)) out.add(d);
  }
  if (new RegExp(`${B}weekdays?${E}`, 'i').test(text)) for (const d of WEEKDAYS.slice(0, 5)) out.add(d);
  if (new RegExp(`${B}weekends?${E}`, 'i').test(text)) for (const d of WEEKDAYS.slice(5)) out.add(d);
  return out;
}

const DAY_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
];
function dayOrdinalWord(n: number): string {
  if (n <= 20) return DAY_ORDINALS[n - 1] as string;
  if (n === 30) return 'thirtieth';
  const tens = n < 30 ? 'twenty' : 'thirty';
  return `${tens}[- ]?${DAY_ORDINALS[(n % 10) - 1] as string}`;
}

/** Days of the month written as a day: "31st", "on the 15", "day 15", "the fifteenth". */
export function namedDaysOfMonth(text: string): Set<number> {
  const out = new Set<number>();
  // "every 3rd month" / "every third day" are intervals, not days of the month.
  const notUnit = `(?!\\s+${UNIT}${E})`;
  for (const m of text.matchAll(new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th)${E}${notUnit}`, 'gi'))) {
    out.add(Number(m[1]));
  }
  for (const m of text.matchAll(new RegExp(`${B}(?:on\\s+the|day)\\s+(\\d{1,2})${E}`, 'gi'))) out.add(Number(m[1]));
  for (let n = 1; n <= 31; n++) {
    if (new RegExp(`${B}(?:the|on)\\s+${dayOrdinalWord(n)}${E}${notUnit}`, 'i').test(text)) out.add(n);
  }
  return new Set([...out].filter((n) => n >= 1 && n <= 31));
}

/** "N times a week" (also "once" / "twice" / "thrice", "per week", "weekly"); "daily" / "every day" stand for 7. */
export function namedTimesPerWeek(text: string): Set<number> {
  const out = new Set<number>();
  const re = new RegExp(
    `${B}(\\d+|${NUM_WORDS}|once|twice|thrice)(?:\\s+times)?\\s+(?:a|per|each|every)\\s+week${E}|${B}(\\d+|${NUM_WORDS})\\s+times\\s+weekly${E}`,
    'gi',
  );
  const special: Readonly<Record<string, number>> = { once: 1, twice: 2, thrice: 3 };
  for (const m of text.matchAll(re)) {
    const w = (m[1] ?? m[2] ?? '').toLowerCase();
    const n = special[w] ?? parseCount(w);
    if (n !== null) out.add(n);
  }
  if (new RegExp(`${B}(?:daily|every\\s+day|each\\s+day|per\\s+day)${E}`, 'i').test(text)) out.add(7);
  return out;
}

/**
 * Text a payment's schedule words may come from: the clauses of its amount and recipient, plus the clauses right after
 * them that hold no amount and no recipient of their own ("pay mihir 5 usdc, every other friday"). Typed text when
 * neither has a clause.
 */
function scheduleText(ctx: StepContext, pc: PairingContext, p: Payment): string {
  const { clauses } = ctx.req.scan;
  const own = new Set<number>();
  const ac = p.amount === null ? null : amountClause(ctx, p.amount);
  const rc = recipientClause(ctx, p.recipient);
  if (ac !== null) own.add(ac);
  if (rc !== null) own.add(rc);
  if (own.size === 0 || clauses.length === 0) return ctx.req.typed_text;
  const holdsOwn = (ci: number): boolean =>
    pc.amounts.some((a) => amountClause(ctx, a) === ci) || pc.recipients.some((r) => recipientClause(ctx, r) === ci);
  const scope = new Set(own);
  for (const ci of own) {
    for (let next = ci + 1; next < clauses.length && !holdsOwn(next); next++) scope.add(next);
  }
  return clauses
    .filter((c) => scope.has(c.index))
    .map((c) => c.text)
    .join(' ');
}

/**
 * P10 (live run P061 / P073: "for 4 weeks" read as interval 4). For each `k`: `interval` > 1 needs an interval phrase
 * with that number and unit, and an interval phrase needs its interval; `days_of_week` only days the user named;
 * `day_of_month` only a day written as one; `times_per_week` only with "N times a week". Problems name no amount,
 * address or name, only the schedule words the user typed.
 */
export function scheduleProblems(ctx: StepContext, pc: PairingContext, payments: Payment[]): string[] {
  const problems: string[] = [];
  payments.forEach((p, i) => {
    if (p.kind !== 'k') return;
    const n = i + 1;
    const text = scheduleText(ctx, pc, p);
    const phrases = intervalPhrases(text);
    const interval = p.interval ?? 1;
    const match = phrases.find((x) => x.interval === interval && x.frequency === p.frequency);
    if (interval > 1 && match === undefined) {
      const duration = durationPhrase(text);
      if (duration !== null) {
        problems.push(`Payment ${n}: '${duration}' is how long, not how often; interval must be 1.`);
      } else if (phrases[0] !== undefined) {
        const x = phrases[0];
        problems.push(`Payment ${n}: '${x.phrase}' means frequency "${x.frequency}" with interval ${x.interval}.`);
      } else {
        problems.push(`Payment ${n}: the request gives no interval such as "every other week"; interval must be 1.`);
      }
    } else if (interval <= 1 && phrases[0] !== undefined && match === undefined) {
      const x = phrases[0];
      problems.push(`Payment ${n}: '${x.phrase}' means frequency "${x.frequency}" with interval ${x.interval}.`);
    }
    if (p.days_of_week !== null && p.days_of_week.length > 0) {
      const named = namedDays(text);
      if (p.days_of_week.some((d) => !named.has(d))) {
        problems.push(
          named.size === 0
            ? `Payment ${n}: the request names no day of the week, so days_of_week must be null.`
            : `Payment ${n}: days_of_week may list only the days the user named (${WEEKDAYS.filter((d) => named.has(d)).join(', ')}).`,
        );
      }
    }
    if (p.day_of_month !== null && !namedDaysOfMonth(text).has(p.day_of_month)) {
      problems.push(`Payment ${n}: day_of_month must be a day the user wrote, like "on the 15th"; otherwise null.`);
    }
    if (p.times_per_week !== null && !namedTimesPerWeek(text).has(p.times_per_week)) {
      problems.push(`Payment ${n}: times_per_week needs "N times a week" in the request; otherwise it must be null.`);
    }
  });
  return problems;
}

/** P8 (§8.9): split word + one amount + ≥ 2 recipients. Independent of the model output. */
export function checkSplit(ctx: StepContext, pc: PairingContext): PairingOutcome {
  if (ctx.req.scan.split.length > 0 && pc.amounts.length === 1 && pc.recipients.length >= 2) {
    return { kind: 'error', code: 'SPLIT_UNSUPPORTED' };
  }
  return { kind: 'ok' };
}

/** P1–P4, P5 (`l` with a group) and the P9 enum part: problems that trigger the one retry. */
export function retryableProblems(ctx: StepContext, pc: PairingContext, payments: Payment[]): string[] {
  const problems: string[] = [];
  problems.push(...chainBindingProblems(ctx, payments));

  // P1 kind fields.
  payments.forEach((p, i) => {
    const n = i + 1;
    if ((p.kind === 'i' || p.kind === 'k') && p.amount === null) {
      problems.push(`Payment ${n} is kind "${p.kind}" and needs an amount placeholder.`);
    }
    if (p.kind === 'l' && p.amount !== null) {
      problems.push(`Payment ${n} is kind "l" and its amount must be null.`);
    }
    if (p.kind !== 'k' && SCHEDULE_FIELDS.some((f) => p[f] !== null)) {
      problems.push(
        `Payment ${n} is kind "${p.kind}", so frequency, interval, times_per_week, days_of_week and day_of_month must be null.`,
      );
    }
  });

  // P2 amount coverage.
  for (const a of pc.amounts) {
    const uses = payments.filter((p) => p.amount === a).length;
    if (uses === 0) problems.push(`${a} is not used.`);
    else if (uses > 1 && !isDistributiveAmount(ctx, a))
      problems.push(`${a} is used more than once, but the user did not say "each".`);
  }

  // P3 recipient coverage and no duplicate (amount, recipient).
  for (const r of pc.recipients) {
    if (!payments.some((p) => p.recipient === r)) problems.push(`${r} is not used.`);
  }
  const seen = new Set<string>();
  for (const p of payments) {
    const key = `${p.amount ?? 'null'}|${p.recipient}`;
    if (seen.has(key)) problems.push(`${p.amount ?? 'null'} and ${p.recipient} are paired more than once.`);
    seen.add(key);
  }

  // P4 clause binding, relaxed by SQ-O-03: a cross-clause pairing passes when the amount's clause holds no recipient
  // of its own; otherwise ("10 to A and 20 to B") P4 applies as written. SQ-R-02: skipped only for an amount in a
  // distributive word's clause.
  for (const p of payments) {
    if (p.amount === null || isDistributiveAmount(ctx, p.amount)) continue;
    const ac = amountClause(ctx, p.amount);
    const rc = recipientClause(ctx, p.recipient);
    if (ac === null || rc === null || ac === rc) continue;
    if (!pc.recipients.some((r) => recipientClause(ctx, r) === ac)) continue;
    const other = pc.amounts.find((a) => a !== p.amount && amountClause(ctx, a) === rc);
    if (other !== undefined) {
      problems.push(
        `${p.amount} is paired with ${p.recipient}, but ${other} is in the same part of the sentence as ${p.recipient}.`,
      );
    }
  }

  // P5 groups only with kind i (k with a group is terminal, see terminalError).
  for (const p of payments) {
    if (isGroupPh(p.recipient) && p.kind === 'l') problems.push(`${p.recipient} can only be used with kind "i".`);
  }

  // P9 chain must be "unstated" or one of the S2 chain IDs.
  for (const p of payments) {
    if (p.chain !== 'unstated' && !pc.chains.includes(p.chain)) {
      problems.push(`Chain ${String(p.chain)} was not mentioned; use "unstated".`);
    }
  }
  // P10 schedule fields of a `k`.
  problems.push(...scheduleProblems(ctx, pc, payments));
  return problems;
}

/** Index of the sentence each clause belongs to: a gap between two clauses holding ".", "!", "?" or a line break. */
function sentenceOfClause(ctx: StepContext): Map<number, number> {
  const { clauses } = ctx.req.scan;
  const text = ctx.req.typed_text;
  const out = new Map<number, number>();
  let sentence = 0;
  clauses.forEach((c, n) => {
    const prev = clauses[n - 1];
    if (prev !== undefined && /[.!?\n]/.test(text.slice(prev.end, c.start))) sentence++;
    out.set(c.index, sentence);
  });
  return out;
}

/**
 * SQ-O-03, F-11 (trigger confirmed by the human): the payments whose recipient Q_PAIR_AMOUNT must confirm, as
 * indexes into `payments`. A payment qualifies when its amount and recipient are in different clauses and either the
 * request has several recipients or the two are in different sentences. One recipient in one sentence ("10 usdc and
 * 0.01 eth to mihir") and same-clause pairs ("10 to A and 20 to B") never ask. SQ-R-02: an amount in a distributive
 * word's clause never qualifies. R4-F1: once one payment qualifies, every payment with a (non-distributive) amount is
 * asked, so the user can choose any pairing ("10 usdc and 20 usdc to mihir and aradhya": both amounts).
 */
export function pairsToConfirm(ctx: StepContext, pc: PairingContext, payments: Payment[]): number[] {
  const sentence = sentenceOfClause(ctx);
  const askable = (p: Payment): boolean => p.amount !== null && !isDistributiveAmount(ctx, p.amount);
  const triggers = payments.some((p) => {
    if (!askable(p) || p.amount === null) return false;
    const ac = amountClause(ctx, p.amount);
    const rc = recipientClause(ctx, p.recipient);
    if (ac === null || rc === null || ac === rc) return false;
    return pc.recipients.length > 1 || sentence.get(ac) !== sentence.get(rc);
  });
  if (!triggers) return [];
  return payments.flatMap((p, n) => (askable(p) ? [n] : []));
}

/** P5 (k + group), P6, P7, P9 (pin conflict): terminal errors, no retry. */
export function terminalError(ctx: StepContext, payments: Payment[]): PairingOutcome {
  // P5
  if (payments.some((p) => p.kind === 'k' && isGroupPh(p.recipient))) {
    return { kind: 'error', code: 'GROUP_AUTOPAY_UNSUPPORTED' };
  }
  // P6 relative amounts: only i, a single recipient, used once.
  for (const item of ctx.req.amounts) {
    if (item.relative === null) continue;
    const uses = payments.filter((p) => p.amount === item.placeholder);
    if (uses.length === 0) continue;
    if (uses.length > 1 || uses.some((p) => p.kind !== 'i' || isGroupPh(p.recipient))) {
      return { kind: 'error', code: 'RELATIVE_AMOUNT_NOT_ALLOWED' };
    }
  }
  // P7 untrusted values in a k.
  for (const p of payments) {
    if (p.kind !== 'k') continue;
    if (p.amount !== null && ctx.repos.db1.get(p.amount)?.source === 'untrusted') {
      return { kind: 'error', code: 'UNTRUSTED_IN_AUTOPAY' };
    }
    // Keyed on the DB3 source: a content address the user just confirmed has a DB2 row through add_contact but
    // "stays flagged untrusted for this request only" (§9.2 step 7). Only a contact that existed before this request
    // (S6 sets source='contact') passes the §16.1 exception.
    if (ctx.repos.db3.get(p.recipient)?.source === 'untrusted') return { kind: 'error', code: 'UNTRUSTED_IN_AUTOPAY' };
  }
  // P9 pinned recipient (DB3 chain_id of a single row, §8.8) or pinned amount with a different stated chain.
  for (const p of payments) {
    if (p.chain === 'unstated') continue;
    const row = ctx.repos.db3.get(p.recipient);
    const recipientPin = row?.kind === 'single' ? row.chain_id : null;
    const amountPin =
      p.amount === null ? null : (ctx.req.amounts.find((a) => a.placeholder === p.amount)?.pinned_chain_id ?? null);
    const pin = recipientPin !== null && recipientPin !== p.chain ? recipientPin : amountPin;
    if (pin !== null && pin !== p.chain) {
      return {
        kind: 'error',
        code: 'CHAIN_CONFLICT',
        params: {
          name: recipientNameOf(ctx, p.recipient),
          chain: chainName(ctx, pin),
          other: chainName(ctx, p.chain),
        },
      };
    }
  }
  return { kind: 'ok' };
}

/** Runs P8, then the retryable checks, then the terminal ones (see §8.9 table). */
export function checkPayments(ctx: StepContext, pc: PairingContext, payments: Payment[]): PairingOutcome {
  const split = checkSplit(ctx, pc);
  if (split.kind !== 'ok') return split;
  const problems = retryableProblems(ctx, pc, payments);
  if (problems.length > 0) return { kind: 'retry', problems };
  return terminalError(ctx, payments);
}
