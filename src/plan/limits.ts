// Implements: §10.4 LIMIT_BRIDGES and §10.6 derived 3–5 / V-12…V-14 limit errors (shared by S9 and S10);
// §11.3 V-15 quantities shared with the §13.1 footer: spent_today (Σ DB6 rows of the local calendar day in
// the session timezone), this_request (Σ `i` amounts + Σ `j` buffers, SQ-17; `k` creation adds 0, D-19; each `j` counts
// only its buffer, D-20) and the tokens a plan uses.

import type { StepContext, StepResult } from '../contracts/step.js';
import type { InternalIntent, Token } from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { db1BaseUnits, decimalsOf, fmt, nowUtcIso } from './common.js';
import { TOKENS_ORDER } from './spendable.js';

/** Tokens of the plan's `i`, `j`, `k` intents, in a fixed order (SQ-D-13: `l` moves no token). */
export function tokensUsed(plan: InternalIntent[]): Token[] {
  return TOKENS_ORDER.filter((t) => plan.some((it) => it.intent_id !== 'l' && it.token === t));
}

export function spentToday(ctx: StepContext, token: Token): bigint {
  return ctx.repos.db6
    .spentToday(token, ctx.timezone, nowUtcIso(ctx))
    .reduce((sum, r) => sum + toBaseUnits(r.amount, decimalsOf(token)), 0n);
}

export function thisRequest(ctx: StepContext, plan: InternalIntent[], token: Token): bigint {
  let sum = 0n;
  for (const it of plan) {
    if (it.intent_id === 'i' && it.token === token) sum += db1BaseUnits(ctx, it.amount).units;
    if (it.intent_id === 'j' && it.token === token) {
      sum += db1BaseUnits(ctx, it.amount).units - BigInt(it.deliverable_base_units);
    }
  }
  return sum;
}

/** §10.4 / V-12: number of `j` ≤ max_bridges_per_request. */
export function checkBridgeCount(ctx: StepContext, n: number): StepResult | null {
  const max = ctx.limits.max_bridges_per_request;
  return n > max ? { kind: 'error', code: 'LIMIT_BRIDGES', params: { n: String(n), max: String(max) } } : null;
}

/** §10.6 derived 5 / V-13 / V-14: one payment ≤ per_tx_max[token]. */
export function checkPerTx(ctx: StepContext, units: bigint, token: Token): StepResult | null {
  const max = ctx.limits.per_tx_max[token];
  if (units <= toBaseUnits(max, decimalsOf(token))) return null;
  return { kind: 'error', code: 'LIMIT_PER_TX', params: { amount: fmt(units, token), token, max } };
}

/** §10.6 derived 4 / V-14: per_period_cap ≤ autopay_max_per_period[token]. */
export function checkAutopayPeriod(ctx: StepContext, cap: bigint, token: Token): StepResult | null {
  const max = ctx.limits.autopay_max_per_period[token];
  if (cap <= toBaseUnits(max, decimalsOf(token))) return null;
  return { kind: 'error', code: 'LIMIT_AUTOPAY_PERIOD', params: { cap: fmt(cap, token), token, max } };
}

/** §10.6 derived 3 / V-14: duration beyond autopay_max_weeks. */
export function autopayDurationError(ctx: StepContext): StepResult {
  return { kind: 'error', code: 'LIMIT_AUTOPAY_DURATION', params: { weeks: String(ctx.limits.autopay_max_weeks) } };
}
