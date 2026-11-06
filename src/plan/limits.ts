// Implements: §10.4 LIMIT_BRIDGES, §10.6 derived 3–5 / V-12…V-15 limit breaches (shared by S9 and S10) with the
// SQ-D-16 / F-5 / F-6 rule on when a broken limit can be lifted by Q_LIMIT_OVERRIDE;
// §11.3 V-15 quantities shared with the §13.1 footer: spent_today (Σ DB6 rows of the local calendar day in
// the session timezone), this_request (Σ `i` amounts + Σ `j` buffers, SQ-17; `k` creation adds 0, D-19; each `j` counts
// only its buffer, D-20) and the tokens a plan uses.

import type { BrokenLimit } from '../contracts/catalog.js';
import type { StepContext, StepResult } from '../contracts/step.js';
import type { InternalIntent, Token } from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { nowUtcIso } from '../pipeline/step-util.js';
import { db1BaseUnits, decimalsOf, fmt } from './common.js';
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

/**
 * One broken DB5 limit (SQ-D-16, F-1…F-6): the fragment for Q_LIMIT_OVERRIDE and the §15 error it ends with when the
 * limit cannot be lifted (an amount from attached content, F-5).
 */
export interface LimitBreach {
  limit: BrokenLimit;
  error: StepResult;
}

/** §10.4 / V-12: number of `j` ≤ max_bridges_per_request. */
export function bridgeBreach(ctx: StepContext, n: number, repeating: boolean): LimitBreach | null {
  const max = String(ctx.limits.max_bridges_per_request);
  if (n <= ctx.limits.max_bridges_per_request) return null;
  return {
    limit: { kind: 'bridges', n: String(n), max, repeating },
    error: { kind: 'error', code: 'LIMIT_BRIDGES', params: { n: String(n), max } },
  };
}

/** §10.6 derived 5 / V-13 / V-14: one payment ≤ per_tx_max[token]. */
export function perTxBreach(ctx: StepContext, units: bigint, token: Token, repeating: boolean): LimitBreach | null {
  const max = ctx.limits.per_tx_max[token];
  if (units <= toBaseUnits(max, decimalsOf(token))) return null;
  return {
    limit: { kind: 'per_payment', max, token, repeating },
    error: { kind: 'error', code: 'LIMIT_PER_TX', params: { amount: fmt(units, token), token, max } },
  };
}

/** §10.6 derived 4 / V-14: per_period_cap ≤ autopay_max_per_period[token]. */
export function autopayPeriodBreach(ctx: StepContext, cap: bigint, token: Token): LimitBreach | null {
  const max = ctx.limits.autopay_max_per_period[token];
  if (cap <= toBaseUnits(max, decimalsOf(token))) return null;
  return {
    limit: { kind: 'autopay_period', max, token, repeating: true },
    error: { kind: 'error', code: 'LIMIT_AUTOPAY_PERIOD', params: { cap: fmt(cap, token), token, max } },
  };
}

/** §10.6 derived 3 / V-14: duration beyond autopay_max_weeks. */
export function autopayDurationBreach(ctx: StepContext): LimitBreach {
  const weeks = String(ctx.limits.autopay_max_weeks);
  return {
    limit: { kind: 'autopay_duration', weeks, repeating: true },
    error: { kind: 'error', code: 'LIMIT_AUTOPAY_DURATION', params: { weeks } },
  };
}

/** §11.3 V-15: spent today + this request ≤ daily_max[token]. */
export function dailyBreach(ctx: StepContext, plan: InternalIntent[], token: Token): LimitBreach | null {
  const daily_max = ctx.limits.daily_max[token];
  const max = toBaseUnits(daily_max, decimalsOf(token));
  const spent = spentToday(ctx, token);
  if (spent + thisRequest(ctx, plan, token) <= max) return null;
  const remaining = fmt(spent < max ? max - spent : 0n, token);
  return {
    limit: { kind: 'daily', daily_max, remaining, token, repeating: false },
    error: { kind: 'error', code: 'LIMIT_DAILY', params: { token, remaining } },
  };
}

/**
 * F-5 / F-6: true when any amount of the request came from attached content (DB1 source 'untrusted', also when the
 * user confirmed it). Relative amounts are typed; derived amounts (bridge padding, autopay caps) follow the payment
 * amounts they come from, so only the request's own amounts are looked at.
 */
function hasContentAmount(ctx: StepContext): boolean {
  const { req, repos } = ctx;
  const own = [...req.amounts.map((a) => a.placeholder), ...(req.payments ?? []).map((p) => p.amount)];
  return own.some((ph) => ph !== null && repos.db1.get(ph)?.source === 'untrusted');
}

/** SQ-D-16: a broken limit leads to Q_LIMIT_OVERRIDE (or is already lifted) rather than ending the request. */
export function limitsCanBeLifted(ctx: StepContext): boolean {
  return ctx.req.limit_override || !hasContentAmount(ctx);
}
