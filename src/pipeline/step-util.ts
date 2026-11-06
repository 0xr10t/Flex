// Implements: helpers shared by the pipeline steps: chain display names (§6.1 config, §13.1 "Chain display names
// from config"), question ids (§7.3 `q_` + 12 hex via newId), the current time as stored in the DB, the last
// handed-off request (§17.2), §0 / SQ-19 "log the internal state code" for uncovered states, and §10.1 spendable
// balance (used by §8.4 step 6 relative amounts).

import type { StepContext, StepResult } from '../contracts/step.js';
import type { ChainId, Config, QuestionId, Token } from '../contracts/types.js';
import { TOKEN_DECIMALS } from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { newId } from '../util/ids.js';

/** Display name of a chain from config (§13.1). */
export function chainName(config: Config, chain_id: ChainId): string {
  return config.chains.find((c) => c.chain_id === chain_id)?.name ?? String(chain_id);
}

export function qid(): QuestionId {
  return newId('question') as QuestionId;
}

/** §17.2 step 1: session history = the last 5 handed-off requests. */
const HISTORY_LIMIT = 5;

/**
 * §17.2 steps 3 and 6: the payments of the most recent history entry (parsed `payments_json`), objects only;
 * empty when there is no history or the row cannot be parsed.
 */
export function lastHistoryPayments(ctx: StepContext): Array<Record<string, unknown>> {
  const last = ctx.repos.db8.recentHistory(ctx.req.session_id, HISTORY_LIMIT)[0];
  if (!last) return [];
  let payments: unknown;
  try {
    payments = JSON.parse(last.payments_json);
  } catch {
    return [];
  }
  if (!Array.isArray(payments)) return [];
  return payments.filter((p): p is Record<string, unknown> => p !== null && typeof p === 'object');
}

export function nowUtcIso(ctx: StepContext): string {
  return ctx.now().toUTC().toISO() ?? new Date().toISOString();
}

/**
 * §0: a state the spec does not cover stops the request with UNSUPPORTED_REQUEST and logs the internal state code
 * (SQ-19: `event: "unsupported_state"`, `state`, `rule_id`).
 */
export function unsupported(ctx: StepContext, step: string, rule_id: string): StepResult {
  ctx.log.warn({
    event: 'unsupported_state',
    step,
    state: ctx.req.state,
    rule_id,
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
  });
  return { kind: 'error', code: 'UNSUPPORTED_REQUEST' };
}

/**
 * §10.1 spendable(c, t) = DB4.balance − Σ pending DB6 rows of the last 10 minutes (payment, bridge_out,
 * autopay_prefund) − (ETH ? eth_gas_reserve[c] : 0), floored at 0. Base units (bigint). Null when the chain's DB4
 * row is missing or `unavailable`.
 */
export function spendable(ctx: StepContext, chain_id: ChainId, token: Token): bigint | null {
  const row = ctx.repos.db4.get(chain_id, token);
  if (!row || row.status !== 'ok') return null;
  const decimals = TOKEN_DECIMALS[token];
  let v = BigInt(row.base_units);
  for (const p of ctx.repos.db6.pendingRecent(chain_id, token, nowUtcIso(ctx))) v -= toBaseUnits(p.amount, decimals);
  if (token === 'ETH') v -= toBaseUnits(ctx.limits.eth_gas_reserve[String(chain_id)] ?? '0', decimals);
  return v > 0n ? v : 0n;
}
