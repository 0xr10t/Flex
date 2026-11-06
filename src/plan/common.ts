// Implements: shared helpers for S8–S12: §10.1 "display values … without trailing zeros" (via contracts/money),
// §13.1 {Name} precedence (contact name, else ENS name, else subname) and chain display names from config,
// §11.1 INTERNAL_ERROR handling (log the rule ID only), §0 UNSUPPORTED_REQUEST for uncovered states (SQ-19).

import type { StepContext, StepResult } from '../contracts/step.js';
import type { Db3Row } from '../contracts/repos.js';
import type { AmountPh, RecipientPh, Token } from '../contracts/types.js';
import { TOKEN_DECIMALS } from '../contracts/types.js';
import { fromBaseUnits, toBaseUnits } from '../contracts/money.js';
import { joinList } from '../contracts/catalog.js';

export function decimalsOf(token: Token): 6 | 18 {
  return TOKEN_DECIMALS[token];
}

/** "A", "A and B", "A, B and C" (SQ-06): the catalog's joinList. */
export const joinAnd = joinList;

/** DB1 amount of a placeholder in base units (throws when missing: callers validate first). */
export function db1BaseUnits(ctx: StepContext, ph: AmountPh): { units: bigint; token: Token; amount: string } {
  const row = ctx.repos.db1.get(ph);
  if (!row) throw new Error('db1 row missing');
  return { units: toBaseUnits(row.amount, decimalsOf(row.token)), token: row.token, amount: row.amount };
}

export function fmt(units: bigint, token: Token): string {
  return fromBaseUnits(units, decimalsOf(token));
}

/** §13.1 {Name}: contact name, else ENS name, else subname (DB3 name). */
export function recipientName(ctx: StepContext, row: Db3Row | undefined): string {
  if (!row) return '';
  if (row.address) {
    const contact = ctx.repos.db2.findByAddress(row.address)[0];
    if (contact) return contact.name;
  }
  return row.ens_name ?? row.name ?? '';
}

export function recipientNameOf(ctx: StepContext, ph: RecipientPh): string {
  return recipientName(ctx, ctx.repos.db3.get(ph));
}

/** Appends a §13.1 note once (steps may be re-entered). */
export function pushNote(ctx: StepContext, note: string): void {
  if (!ctx.req.notes.includes(note)) ctx.req.notes.push(note);
}

/** §11.1: INTERNAL_ERROR — log the rule ID (never values), user gets the catalog message, request FAILED. */
export function internalError(ctx: StepContext, step: string, rule_id: string): StepResult {
  ctx.log.error({
    event: 'internal_error',
    request_id: ctx.req.request_id,
    session_id: ctx.req.session_id,
    step,
    rule_id,
    error_code: 'INTERNAL_ERROR',
  });
  return { kind: 'error', code: 'INTERNAL_ERROR' };
}

/** §0 / SQ-19: a state the spec does not cover → UNSUPPORTED_REQUEST, logging the state and branch id. */
export function unsupported(ctx: StepContext, step: string, rule_id: string): StepResult {
  ctx.log.warn({
    event: 'unsupported_state',
    request_id: ctx.req.request_id,
    session_id: ctx.req.session_id,
    step,
    state: ctx.req.state,
    rule_id,
    error_code: 'UNSUPPORTED_REQUEST',
  });
  return { kind: 'error', code: 'UNSUPPORTED_REQUEST' };
}

export function isGroupPh(ph: string): boolean {
  return ph.startsWith('group_');
}
