// Implements: §8.12 / §11 S10 — Validate: V-01…V-09 structural (§11.1), V-10…V-12 funding (§11.2), V-13…V-15 limits
// (§11.3) incl. the `Q_GROUP_OVER_LIMIT` override (§13.4), §11.1 INTERNAL_ERROR logging the rule ID, §16.1 / V-08
// keyed on DB3 source='untrusted' (§9.2 step 7), SQ-15 reply for the "No" answer, SQ-17 `deliverable` = x.

import { getAddress, zeroAddress } from 'viem';
import {
  CHIPS,
  LIMIT_OVERRIDE,
  NOTES,
  REPLY,
  buildQuestion,
  matchChip,
  reask,
  type LimitOverrideArgs,
} from '../contracts/catalog.js';
import { toBaseUnits } from '../contracts/money.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { AddressPh, AmountPh, ChainId, InternalIntent, QuestionId, Token } from '../contracts/types.js';
import { validators } from '../schemas/index.js';
import { newId } from '../util/ids.js';
import { db1BaseUnits, decimalsOf, fmt, internalError, isGroupPh, pushNote, recipientNameOf } from '../plan/common.js';
import {
  autopayDurationError,
  checkAutopayPeriod,
  checkBridgeCount,
  checkPerTx,
  spentToday,
  thisRequest,
  tokensUsed,
} from '../plan/limits.js';
import { enumerateOccurrences } from '../plan/schedule.js';
import { checkChain, checkGas, insufficientParams, readBalances, type ChainBalance } from '../plan/spendable.js';

type Failure = StepResult | null;

function amountsOf(it: InternalIntent): AmountPh[] {
  if (it.intent_id === 'i' || it.intent_id === 'j') return [it.amount];
  if (it.intent_id === 'k') return [it.amount_per_payment, it.limits.per_period_cap, it.limits.total_cap];
  return [];
}

function recipientOf(it: InternalIntent): AddressPh | null {
  return it.intent_id === 'j' ? null : it.recipient;
}

function chainsOf(it: InternalIntent): ChainId[] {
  return it.intent_id === 'j' ? [it.source_chain_id, it.dest_chain_id] : [it.chain_id];
}

// ───────────────────────────── §11.1 structural ─────────────────────────────

function placeholdersExist(ctx: StepContext, plan: InternalIntent[]): boolean {
  const sid = ctx.req.session_id;
  return plan.every((it) => {
    const r = recipientOf(it);
    return (
      amountsOf(it).every((a) => ctx.repos.db1.get(a)?.session_id === sid) &&
      (r === null || ctx.repos.db3.get(r)?.session_id === sid)
    );
  });
}

function stepsConsistent(plan: InternalIntent[]): boolean {
  return plan.every((it, n) => {
    if (it.step !== n) return false;
    if (it.intent_id === 'j') return it.funds_steps.every((s) => s > n && s < plan.length);
    if (it.intent_id === 'l') return true;
    return it.depends_on.every((d) => d < n && plan[d]?.intent_id === 'j');
  });
}

function amountsPositive(ctx: StepContext, plan: InternalIntent[]): boolean {
  const positive = (a: AmountPh): boolean => {
    const row = ctx.repos.db1.get(a);
    if (!row) return false;
    try {
      return toBaseUnits(row.amount, decimalsOf(row.token)) > 0n;
    } catch {
      return false; // more decimals than the token has
    }
  };
  return plan.every((it) => amountsOf(it).every(positive));
}

function checkChains(ctx: StepContext, plan: InternalIntent[], balances: ChainBalance[]): Failure {
  for (const c of plan.flatMap(chainsOf)) {
    const bad = checkChain(ctx, balances, c);
    if (bad) return bad;
  }
  return null;
}

function checkSelfPayment(ctx: StepContext, plan: InternalIntent[]): Failure {
  const wallet = getAddress(ctx.config.wallet.address);
  for (const it of plan) {
    const ph = recipientOf(it);
    if (ph === null) continue;
    const address = ctx.repos.db3.get(ph)?.address;
    if (!address) return internalError(ctx, 's10', 'V-07');
    const checksummed = getAddress(address);
    if (checksummed === wallet || checksummed === zeroAddress) return { kind: 'error', code: 'SELF_PAYMENT' };
  }
  return null;
}

function checkUntrusted(ctx: StepContext, plan: InternalIntent[]): Failure {
  const { db1, db3 } = ctx.repos;
  for (const it of plan) {
    for (const a of amountsOf(it)) {
      const row = db1.get(a);
      if (row?.source === 'untrusted' && !row.confirmed) return internalError(ctx, 's10', 'V-08');
    }
    if (it.intent_id !== 'k') continue;
    if (db1.get(it.amount_per_payment)?.source === 'untrusted' || db3.get(it.recipient)?.source === 'untrusted') {
      return { kind: 'error', code: 'UNTRUSTED_IN_AUTOPAY' };
    }
  }
  return null;
}

function checkCancels(ctx: StepContext, plan: InternalIntent[]): Failure {
  for (const it of plan) {
    if (it.intent_id !== 'l') continue;
    const row = ctx.repos.db7.get(it.autopay_id);
    if (row?.status !== 'active' || row.delegate_address === null) {
      return { kind: 'error', code: 'NO_ACTIVE_AUTOPAY', params: { name: recipientNameOf(ctx, it.recipient) } };
    }
  }
  return null;
}

function structural(ctx: StepContext, plan: InternalIntent[], balances: ChainBalance[]): Failure {
  if (!validators.internalPlan(plan)) return internalError(ctx, 's10', 'V-01');
  if (!placeholdersExist(ctx, plan)) return internalError(ctx, 's10', 'V-02');
  if (!stepsConsistent(plan)) return internalError(ctx, 's10', 'V-03');
  if (plan.some((it) => it.intent_id === 'j' && it.source_chain_id === it.dest_chain_id)) {
    return internalError(ctx, 's10', 'V-04');
  }
  const chains = checkChains(ctx, plan, balances);
  if (chains) return chains;
  if (!amountsPositive(ctx, plan)) return internalError(ctx, 's10', 'V-06');
  return checkSelfPayment(ctx, plan) ?? checkUntrusted(ctx, plan) ?? checkCancels(ctx, plan);
}

// ───────────────────────────── §11.2 funding ─────────────────────────────

/** V-10 for one (chain, token): need, and spendable + bridged in − bridged out. */
function needAndAvailable(
  ctx: StepContext,
  plan: InternalIntent[],
  b: ChainBalance,
  token: Token,
): { need: bigint; available: bigint } {
  let need = 0n;
  let available = b.spendable[token];
  for (const it of plan) {
    if (it.intent_id === 'l' || it.token !== token) continue;
    if (it.intent_id === 'j') {
      if (it.dest_chain_id === b.chain_id) available += BigInt(it.deliverable_base_units);
      if (it.source_chain_id === b.chain_id) available -= db1BaseUnits(ctx, it.amount).units;
    } else if (it.chain_id === b.chain_id) {
      need += db1BaseUnits(ctx, it.intent_id === 'i' ? it.amount : it.limits.total_cap).units;
    }
  }
  return { need, available };
}

function funding(ctx: StepContext, plan: InternalIntent[], balances: ChainBalance[]): Failure {
  for (const token of tokensUsed(plan)) {
    const perChain = balances.map((b) => needAndAvailable(ctx, plan, b, token));
    if (perChain.some((x) => x.need > x.available)) {
      const total = perChain.reduce((sum, x) => sum + x.need, 0n);
      return { kind: 'error', code: 'INSUFFICIENT_FUNDS', params: insufficientParams(ctx, token, balances, total) };
    }
  }
  const touched = new Set(plan.map((it) => (it.intent_id === 'j' ? it.source_chain_id : it.chain_id)));
  return checkGas(ctx, balances, touched) ?? checkBridgeCount(ctx, plan.filter((it) => it.intent_id === 'j').length);
}

// ───────────────────────────── §11.3 limits ─────────────────────────────

function perIntentLimits(ctx: StepContext, plan: InternalIntent[]): Failure {
  for (const it of plan) {
    if (it.intent_id === 'i') {
      const bad = checkPerTx(ctx, db1BaseUnits(ctx, it.amount).units, it.token);
      if (bad) return bad;
    } else if (it.intent_id === 'k') {
      const bad =
        checkPerTx(ctx, db1BaseUnits(ctx, it.amount_per_payment).units, it.token) ??
        checkAutopayPeriod(ctx, db1BaseUnits(ctx, it.limits.per_period_cap).units, it.token);
      if (bad) return bad;
      if (enumerateOccurrences(it.schedule, ctx.limits.autopay_max_weeks).exceedsMaxWeeks) {
        return autopayDurationError(ctx);
      }
    }
  }
  return null;
}

function dailyLimit(ctx: StepContext, plan: InternalIntent[]): Failure {
  const { req, limits } = ctx;
  const hasGroup = (req.payments ?? []).some((p) => isGroupPh(p.recipient));
  for (const token of tokensUsed(plan)) {
    const max = toBaseUnits(limits.daily_max[token], decimalsOf(token));
    const spent = spentToday(ctx, token);
    const request = thisRequest(ctx, plan, token);
    if (spent + request <= max) continue;
    if (req.limit_override) {
      pushNote(ctx, NOTES.LIMIT_LIFTED());
      continue;
    }
    const remaining = fmt(spent < max ? max - spent : 0n, token);
    if (!hasGroup) return { kind: 'error', code: 'LIMIT_DAILY', params: { token, remaining } };
    // contracts-v4 stub: still only the group daily case asks; the general rule lands with lane D (SQ-D-16).
    const over: LimitOverrideArgs = {
      broken: [{ kind: 'daily', daily_max: limits.daily_max[token], remaining, token, repeating: false }],
      amount: { value: fmt(request, token), token },
    };
    return {
      kind: 'question',
      question: buildQuestion({
        question_id: newId('question') as QuestionId,
        code: 'Q_LIMIT_OVERRIDE',
        text: LIMIT_OVERRIDE.text(over),
        chips: LIMIT_OVERRIDE.chips(over),
      }),
    };
  }
  return null;
}

// ───────────────────────────── step ─────────────────────────────

async function step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const plan = req.plan;
  if (!plan) return internalError(ctx, 's10', 'V-01');
  const balances = readBalances(ctx);
  const failure =
    structural(ctx, plan, balances) ??
    funding(ctx, plan, balances) ??
    perIntentLimits(ctx, plan) ??
    dailyLimit(ctx, plan);
  if (failure) return failure;
  req.state = 'VALIDATED';
  ctx.log.info({ event: 'validated', request_id: req.request_id, step: 's10', n_intents: plan.length });
  return { kind: 'continue' };
}

const onAnswer: AnswerHandler = async (ctx, q, answer) => {
  if (q.code !== 'Q_LIMIT_OVERRIDE') return internalError(ctx, 's10', 'S10_UNKNOWN_QUESTION');
  const chip = matchChip(q, answer);
  // §13.4 allows plain "yes" for a Yes chip; this one is labelled "Yes, this once".
  const saidYes = answer.kind === 'text' && answer.text.trim().toLowerCase() === 'yes';
  if (chip?.id === CHIPS.OVER_LIMIT_YES.id || saidYes) {
    ctx.req.limit_override = true;
    return { kind: 'continue' };
  }
  if (chip?.id === CHIPS.NO.id) return { kind: 'discard', messages: [REPLY.CANCELLED()] };
  return { kind: 'question', question: reask(q, newId('question') as QuestionId) };
};

export const s10: StepEntry = { step, onAnswer };
