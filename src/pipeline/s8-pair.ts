// Implements: §8.9 S8 — Pair payments (LLM #4, constrained) + code checks P1–P9, retry once with a `CORRECTION:`
// line, PAIRING_FAILED; I-06 token from DB1; §17.2 step 4 (follow-up placeholder under SESSION);
// §16.1 (document pairs only as placeholder pairs); §8.10 MODEL_FAILED after the client's own retry.

import { LlmFailed } from '../contracts/llm.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { AddressPh, AmountPh, ChainId, Payment, RecipientPh } from '../contracts/types.js';
import {
  buildPaymentsPrompt,
  type PaymentsAmount,
  type PaymentsDocItem,
  type PaymentsPromptInput,
  type PaymentsRecipient,
  type PaymentsSessionItem,
} from '../llm/prompt-builder/payments.js';
import { unsupported } from '../plan/common.js';
import { checkPayments, type PairingContext } from '../plan/pairing-checks.js';

type RawPayment = Omit<Payment, 'token'>;

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

async function step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const { input, pc } = buildInput(ctx);
  if (input.actions.length === 0 || pc.recipients.length === 0) return unsupported(ctx, 's8', 'S8_NO_INPUT');

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
      req.payments = payments;
      req.state = 'PAIRED';
      ctx.log.info({ event: 'paired', request_id: req.request_id, step: 's8', n_intents: payments.length });
      return { kind: 'continue' };
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

export const s8: StepEntry = { step };
