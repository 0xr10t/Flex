// Implements: §11.3 V-15 quantities shared with the §13.1 footer: spent_today (Σ DB6 rows of the local calendar day in
// the session timezone), this_request (Σ `i` amounts + Σ `j` buffers, SQ-17; `k` creation adds 0, D-19; each `j` counts
// only its buffer, D-20) and the tokens a plan uses.

import type { StepContext } from '../contracts/step.js';
import type { InternalIntent, Token } from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { db1BaseUnits, decimalsOf, nowUtcIso } from './common.js';
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
