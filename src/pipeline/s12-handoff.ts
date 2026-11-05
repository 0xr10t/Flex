// Implements: §8.14 S12 — Hand off: swap_back (src/handoff/swap-back.ts), validation against §12.5 (HANDOFF_INVALID →
// INTERNAL_ERROR, SQ-02), POST with the request id as idempotency key (§14.2), on 2xx DB6 rows per §11.4, DB7 `pending`
// rows per `k`, `db8_history` append (SQ-C-08: S8 payment plus the numeric chain S9 assigned), reply §13.3; 4xx →
// EXECUTION_REJECTED; 5xx/timeout → EXECUTION_UNAVAILABLE. Retries reuse req.envelope and the key (§8.14 step 6); the
// runner counts attempts and sets HANDOFF_FAILED (src/contracts/step.ts).

import { REPLY } from '../contracts/catalog.js';
import { fromBaseUnits } from '../contracts/money.js';
import type { Db6Insert } from '../contracts/repos.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type {
  AutopayId,
  ChainId,
  EnvelopeIntent,
  HandoffEnvelope,
  InternalIntent,
  Payment,
} from '../contracts/types.js';
import { swapBack } from '../handoff/swap-back.js';
import { decimalsOf, internalError, recipientNameOf } from '../plan/common.js';
import { validators } from '../schemas/index.js';

/** §11.4 for one intent. `deliverable` is the plan's `deliverable_base_units` of a `j` (SQ-17). */
function db6Rows(ctx: StepContext, it: EnvelopeIntent, deliverable: string, now: string): Db6Insert[] {
  const base = {
    request_id: ctx.req.request_id,
    step: it.step,
    status: 'pending' as const,
    tx_hash: null,
    created_at: now,
    executed_at: null,
  };
  switch (it.intent_id) {
    case 'i':
      return [
        {
          ...base,
          kind: 'payment',
          counts_toward_limit: true,
          chain_id: it.chain_id,
          token: it.token,
          amount: it.amount.value,
          recipient_address: it.recipient,
          intent_id: 'i',
          autopay_id: null,
        },
      ];
    case 'j': {
      const shared = {
        ...base,
        chain_id: it.source_chain_id,
        token: it.token,
        recipient_address: null,
        intent_id: 'j' as const,
        autopay_id: null,
      };
      const buffer = BigInt(it.amount.base_units) - BigInt(deliverable);
      return [
        { ...shared, kind: 'bridge_out', counts_toward_limit: false, amount: it.amount.value },
        {
          ...shared,
          kind: 'bridge_buffer',
          counts_toward_limit: true,
          amount: fromBaseUnits(buffer, decimalsOf(it.token)),
        },
      ];
    }
    case 'k':
      return [
        {
          ...base,
          kind: 'autopay_prefund',
          counts_toward_limit: false,
          chain_id: it.chain_id,
          token: it.token,
          amount: it.limits.total_cap.value,
          recipient_address: it.recipient,
          intent_id: 'k',
          autopay_id: it.autopay_id as AutopayId,
        },
      ];
    case 'l':
      return [];
  }
}

/** SQ-C-08: the chain S9 assigned to this S8 payment (a group's members share the group's chain). */
function chainOfPayment(ctx: StepContext, plan: InternalIntent[], p: Payment): ChainId | null {
  for (const it of plan) {
    if (it.intent_id === 'j' || it.intent_id !== p.kind) continue;
    if (it.recipient !== p.recipient && ctx.repos.db3.get(it.recipient)?.group_placeholder !== p.recipient) continue;
    if (it.intent_id === 'l' || (it.intent_id === 'i' ? it.amount : it.amount_per_payment) === p.amount) {
      return it.chain_id;
    }
  }
  return null;
}

function recordHandoff(ctx: StepContext, plan: InternalIntent[], envelope: HandoffEnvelope): void {
  const { req, repos } = ctx;
  const now = ctx.now().toUTC().toISO({ suppressMilliseconds: true }) as string;
  const history = (req.payments ?? []).map((p) => ({ ...p, chain_id: chainOfPayment(ctx, plan, p) }));
  repos.transaction(() => {
    const rows: Db6Insert[] = [];
    envelope.intents.forEach((it, n) => {
      const planned = plan[n];
      rows.push(...db6Rows(ctx, it, planned?.intent_id === 'j' ? planned.deliverable_base_units : '0', now));
      if (it.intent_id !== 'k' || planned?.intent_id !== 'k') return;
      repos.db7.insertPending(
        {
          autopay_id: it.autopay_id as AutopayId,
          request_id: req.request_id,
          recipient_name: recipientNameOf(ctx, planned.recipient),
          recipient_address: it.recipient,
          chain_id: it.chain_id,
          token: it.token,
          amount_per_payment: it.amount_per_payment.value,
          schedule_json: JSON.stringify(it.schedule),
        },
        now,
      );
    });
    repos.db6.insertMany(rows);
    repos.db8.appendHistory({
      session_id: req.session_id,
      request_id: req.request_id,
      payments_json: JSON.stringify(history),
      handed_off_at: now,
    });
  });
}

/** §8.14 steps 1–2, once: every retry sends the same envelope. Null when it cannot be built or fails §12.5. */
function envelopeFor(ctx: StepContext, plan: InternalIntent[]): HandoffEnvelope | null {
  if (ctx.req.envelope) return ctx.req.envelope;
  try {
    const envelope = swapBack(ctx, plan);
    if (!validators.handoffEnvelope(envelope)) return null;
    ctx.req.envelope = envelope;
    return envelope;
  } catch {
    return null;
  }
}

async function step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const plan = req.plan;
  const envelope = plan ? envelopeFor(ctx, plan) : null;
  if (!plan || !envelope) return internalError(ctx, 's12', 'HANDOFF_INVALID');
  const result = await ctx.exec.submit(envelope, req.request_id);
  if (result.status === 'rejected') {
    ctx.log.warn({
      event: 'handoff_rejected',
      request_id: req.request_id,
      step: 's12',
      error_code: 'EXECUTION_REJECTED',
    });
    return { kind: 'error', code: 'EXECUTION_REJECTED', params: { message: result.message } };
  }
  if (result.status === 'unavailable') {
    ctx.log.warn({
      event: 'handoff_unavailable',
      request_id: req.request_id,
      step: 's12',
      error_code: 'EXECUTION_UNAVAILABLE',
      attempt: req.handoff_attempts,
    });
    return { kind: 'error', code: 'EXECUTION_UNAVAILABLE' };
  }
  recordHandoff(ctx, plan, envelope);
  req.state = 'HANDED_OFF';
  ctx.log.info({ event: 'handed_off', request_id: req.request_id, step: 's12', n_intents: plan.length });
  return { kind: 'answer', messages: [REPLY.HANDED_OFF()] };
}

export const s12: StepEntry = { step };
