// Implements: §8.9 S8 — Pair payments (LLM #4, constrained) + code checks P1–P9, retry once with a `CORRECTION:`
// line, PAIRING_FAILED; I-06 token from DB1; §17.2 step 4 (follow-up placeholder under SESSION);
// §16.1 (document pairs only as placeholder pairs); §8.10 MODEL_FAILED after the client's own retry; SQ-O-03 / F-11
// Q_PAIR_AMOUNT (who gets a cross-clause amount), with P1–P9 re-run on the user's choices. Re-entrant: the checked
// payments and the answers are kept in req.step_state.s8, so the model is not called again after a question.

import { PAIR_AMOUNT, REASK_HINT, buildQuestion, matchChip, reask, withHint } from '../contracts/catalog.js';
import { shortAddress } from '../contracts/money.js';
import { LlmFailed } from '../contracts/llm.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { AddressPh, AmountPh, ChainId, Payment, QuestionId, RecipientPh } from '../contracts/types.js';
import { newId } from '../util/ids.js';
import {
  buildPaymentsPrompt,
  type PaymentsAmount,
  type PaymentsDocItem,
  type PaymentsPromptInput,
  type PaymentsRecipient,
  type PaymentsSessionItem,
} from '../llm/prompt-builder/payments.js';
import { db1BaseUnits, fmt, internalError, recipientNameOf, unsupported } from '../plan/common.js';
import { checkPayments, pairsToConfirm, type PairingContext } from '../plan/pairing-checks.js';

type RawPayment = Omit<Payment, 'token'>;

/** §13.4 `max_attempts` (first ask plus at most 3 re-asks). */
const MAX_ATTEMPTS = 4;

/** Q_PAIR_AMOUNT progress: the checked payments, which of them to confirm, and the recipients chosen so far. */
interface S8State {
  payments: Payment[];
  confirm: number[];
  /** Payment index → chosen recipient placeholder. */
  choices: Record<string, RecipientPh>;
  /** R1-F2 / R4-F3, §9.7: the attempt of the amount question being asked (1 for each new amount). */
  attempt: number;
  /** Rounds of questions: 1, +1 for each "That would leave {name} with nothing" re-ask (its own counter). */
  round?: number;
  /** Re-ask hint after choices that leave a payee unpaid (shown on the first question of the round). */
  hint?: string;
}

function buildInput(ctx: StepContext): { input: PaymentsPromptInput; pc: PairingContext } {
  const { req } = ctx;
  const amounts: PaymentsAmount[] = [];
  for (const a of req.amounts) {
    const row = ctx.repos.db1.get(a.placeholder);
    if (!row || !row.confirmed) continue; // §8.9: confirmed only
    amounts.push({ placeholder: a.placeholder, token: row.token, from_attached_content: row.source === 'untrusted' });
  }
  const recipients: PaymentsRecipient[] = [];
  const session: PaymentsSessionItem[] = [];
  for (const r of req.recipients) {
    if (r.followup) session.push({ placeholder: r.placeholder as AddressPh, last_chain_id: r.last_chain_id });
    else recipients.push({ placeholder: r.placeholder, type: r.type });
  }

  // DOCUMENT ITEMS: pairs as listed in the attached content, only as placeholders (§16.1). A pair links the
  // untrusted amount and the untrusted payee that came from the same Q-LLM entry (untrusted_item_index).
  const docAmount = new Map<number, AmountPh>();
  for (const a of req.amounts) {
    if (a.untrusted_item_index !== null && amounts.some((x) => x.placeholder === a.placeholder)) {
      docAmount.set(a.untrusted_item_index, a.placeholder);
    }
  }
  const docRecipient = new Map<number, AddressPh>();
  for (const r of req.recipients) {
    const idx = req.spans[r.span_index]?.untrusted_item_index ?? null;
    if (idx !== null && r.type === 'person') docRecipient.set(idx, r.placeholder as AddressPh);
  }
  const indexes = [...new Set([...docAmount.keys(), ...docRecipient.keys()])].sort((x, y) => x - y);
  const docItems: PaymentsDocItem[] = indexes.map((i) => ({
    amount: docAmount.get(i) ?? null,
    recipient: docRecipient.get(i) ?? null,
  }));

  const chains: Array<{ word: string; chain_id: ChainId }> = [];
  for (const c of req.scan.chains) {
    if (!chains.some((x) => x.word === c.word && x.chain_id === c.chain_id)) {
      chains.push({ word: c.word, chain_id: c.chain_id });
    }
  }
  const input: PaymentsPromptInput = {
    masked_text_s8: req.masked_text_s8 ?? '',
    amounts,
    recipients,
    doc_items: docItems.length > 0 ? docItems : 'none',
    chains,
    actions: [...(req.actions ?? [])],
    session: session.length > 0 ? session : 'none',
  };
  const pc: PairingContext = {
    amounts: amounts.map((a) => a.placeholder),
    recipients: [...recipients.map((r) => r.placeholder), ...session.map((s) => s.placeholder)] as RecipientPh[],
    chains: [...new Set(chains.map((c) => c.chain_id))],
  };
  return { input, pc };
}

function withToken(ctx: StepContext, raw: RawPayment[]): Payment[] {
  return raw.map((p) => ({
    kind: p.kind,
    amount: p.amount,
    recipient: p.recipient,
    chain: p.chain,
    frequency: p.frequency,
    interval: p.interval,
    times_per_week: p.times_per_week,
    days_of_week: p.days_of_week,
    day_of_month: p.day_of_month,
    // I-06: the token is the DB1 token of the amount placeholder, never chosen by the model.
    token: p.amount === null ? null : (ctx.repos.db1.get(p.amount)?.token ?? null),
  }));
}

function paired(ctx: StepContext, payments: Payment[]): StepResult {
  const { req } = ctx;
  req.payments = payments;
  req.state = 'PAIRED';
  delete req.step_state.s8;
  ctx.log.info({ event: 'paired', request_id: req.request_id, step: 's8', n_intents: payments.length });
  return { kind: 'continue' };
}

function recipientLabel(ctx: StepContext, ph: RecipientPh): string {
  const name = recipientNameOf(ctx, ph);
  if (name !== '') return name;
  const address = ctx.repos.db3.get(ph)?.address;
  return address ? shortAddress(address) : ph;
}

/** Asks Q_PAIR_AMOUNT for the next unanswered amount; once all are answered, re-runs P1–P9 on the choices. */
function confirmPairs(ctx: StepContext, pc: PairingContext, st: S8State): StepResult {
  const next = st.confirm.find((n) => st.choices[String(n)] === undefined);
  const p = next === undefined ? undefined : st.payments[next];
  if (p !== undefined) {
    if (p.amount === null) return internalError(ctx, 's8', 'S8_PAIR_AMOUNT_NULL');
    const { units, token } = db1BaseUnits(ctx, p.amount);
    const text = PAIR_AMOUNT.text({ amount: fmt(units, token), token });
    const first = next === st.confirm[0];
    return {
      kind: 'question',
      question: buildQuestion({
        question_id: newId('question') as QuestionId,
        code: 'Q_PAIR_AMOUNT',
        text: first && st.hint !== undefined ? withHint(st.hint, text) : text,
        chips: PAIR_AMOUNT.chips(pc.recipients.map((r) => ({ id: r, label: recipientLabel(ctx, r) }))),
        attempt: st.attempt,
      }),
    };
  }
  const chosen = st.payments.map((q, n) => {
    const r = st.choices[String(n)];
    return r === undefined ? q : { ...q, recipient: r };
  });
  const outcome = checkPayments(ctx, pc, chosen);
  if (outcome.kind === 'ok') return paired(ctx, chosen);
  if (outcome.kind === 'error') {
    return outcome.params
      ? { kind: 'error', code: outcome.code, params: outcome.params }
      : { kind: 'error', code: outcome.code };
  }
  // F-11: choices that leave a payee unpaid (P3) are re-asked with a hint; attempts count as for other questions.
  const unpaid = pc.recipients.find((r) => !chosen.some((q) => q.recipient === r));
  if (unpaid === undefined) {
    ctx.log.warn({ event: 'pairing_failed', request_id: ctx.req.request_id, step: 's8', error_code: 'PAIRING_FAILED' });
    return { kind: 'error', code: 'PAIRING_FAILED' };
  }
  // §9.7 / §13.4: the round question is asked at most 1 + 3 times.
  st.round = (st.round ?? 1) + 1;
  if (st.round > MAX_ATTEMPTS) {
    ctx.log.warn({ event: 'pair_amount_rounds', request_id: ctx.req.request_id, step: 's8', attempt: st.round });
    return { kind: 'error', code: 'TOO_MANY_RETRIES' };
  }
  st.attempt = 1;
  st.choices = {};
  st.hint = REASK_HINT.PAIR_UNPAID({ name: recipientLabel(ctx, unpaid) });
  return confirmPairs(ctx, pc, st);
}

async function step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const { input, pc } = buildInput(ctx);
  if (input.actions.length === 0 || pc.recipients.length === 0) return unsupported(ctx, 's8', 'S8_NO_INPUT');
  const pending = req.step_state.s8 as S8State | undefined;
  if (pending !== undefined) return confirmPairs(ctx, pc, pending);

  let correction: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = buildPaymentsPrompt(correction === undefined ? input : { ...input, correction });
    let out: { payments: RawPayment[] };
    try {
      out = await ctx.llm.call<{ payments: RawPayment[] }>({ name: 'payments', ...prompt });
    } catch (e) {
      if (e instanceof LlmFailed) {
        ctx.log.warn({
          event: 'llm_failed',
          request_id: req.request_id,
          step: 's8',
          llm_call: 'payments',
          error_code: 'MODEL_FAILED',
        });
        return { kind: 'error', code: 'MODEL_FAILED' };
      }
      throw e;
    }
    const payments = withToken(ctx, out.payments);
    const outcome = checkPayments(ctx, pc, payments);
    if (outcome.kind === 'ok') {
      const confirm = pairsToConfirm(ctx, pc, payments);
      if (confirm.length === 0) return paired(ctx, payments);
      const st: S8State = { payments, confirm, choices: {}, attempt: 1 };
      req.step_state.s8 = st;
      return confirmPairs(ctx, pc, st);
    }
    if (outcome.kind === 'error') {
      ctx.log.info({ event: 'pairing_rejected', request_id: req.request_id, step: 's8', error_code: outcome.code });
      return outcome.params
        ? { kind: 'error', code: outcome.code, params: outcome.params }
        : { kind: 'error', code: outcome.code };
    }
    correction = outcome.problems.join(' ');
    ctx.log.info({
      event: 'pairing_check_failed',
      request_id: req.request_id,
      step: 's8',
      attempt,
      llm_call: 'payments',
      llm_retry: attempt === 1,
    });
  }
  ctx.log.warn({ event: 'pairing_failed', request_id: req.request_id, step: 's8', error_code: 'PAIRING_FAILED' });
  return { kind: 'error', code: 'PAIRING_FAILED' };
}

/** Q_PAIR_AMOUNT answer: a recipient chip (or its label typed); anything else is re-asked. */
const onAnswer: AnswerHandler = async (ctx, q, answer) => {
  const st = ctx.req.step_state.s8 as S8State | undefined;
  if (q.code !== 'Q_PAIR_AMOUNT' || st === undefined) return internalError(ctx, 's8', 'S8_STALE_ANSWER');
  const next = st.confirm.find((n) => st.choices[String(n)] === undefined);
  const chip = matchChip(q, answer);
  if (chip === null || next === undefined) {
    const again = reask(q, newId('question') as QuestionId);
    st.attempt = again.attempt;
    return { kind: 'question', question: again };
  }
  st.choices[String(next)] = chip.id as RecipientPh;
  st.attempt = 1; // the next amount's question starts its own counter
  return { kind: 'continue' };
};

export const s8: StepEntry = { step, onAnswer };
