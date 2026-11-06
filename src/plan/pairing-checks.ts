// Implements: §8.9 S8 code checks P1–P9 (retryable problems vs. terminal errors) with P4 relaxed per SQ-O-03 and the
// Q_PAIR_AMOUNT trigger (F-11), §16.1 (untrusted values in a `k`).
// Correction texts name placeholders only (never values), so the retry prompt keeps §16.1.

import type { StepContext } from '../contracts/step.js';
import type { AmountPh, ChainId, ErrorCode, Payment, RecipientPh } from '../contracts/types.js';
import { chainName, isGroupPh, recipientNameOf } from './common.js';

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
  const distributive = ctx.req.scan.distributive.length > 0;

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
    else if (uses > 1 && !distributive) problems.push(`${a} is used more than once, but the user did not say "each".`);
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
  // of its own; otherwise ("10 to A and 20 to B") P4 applies as written.
  if (!distributive) {
    for (const p of payments) {
      if (p.amount === null) continue;
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
 * 0.01 eth to mihir") and same-clause pairs ("10 to A and 20 to B") never ask.
 */
export function pairsToConfirm(ctx: StepContext, pc: PairingContext, payments: Payment[]): number[] {
  if (ctx.req.scan.distributive.length > 0) return [];
  const sentence = sentenceOfClause(ctx);
  const out: number[] = [];
  payments.forEach((p, n) => {
    if (p.amount === null) return;
    const ac = amountClause(ctx, p.amount);
    const rc = recipientClause(ctx, p.recipient);
    if (ac === null || rc === null || ac === rc) return;
    if (pc.recipients.length > 1 || sentence.get(ac) !== sentence.get(rc)) out.push(n);
  });
  return out;
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
