// Implements: §8.5 S4 — Request type (LLM #2 + code): prompt input masked_text_s3; rule 1 unsupported →
// UNSUPPORTED_REQUEST, request ANSWERED (SQ-01: §15 wording); rule 2 balance → §13.2 balance answer
// (buildBalanceAnswer, Lane D), ANSWERED; rule 3 actions: empty → retry the call once → MODEL_FAILED; remove `l`
// when S2 found no cancel word; recurrence cross-check → Q_RECURRING ("Yes, repeat it" / "No, just once") setting
// k / i; i or k without pay amounts → Q_AMOUNT_MISSING (also §17.2 step 5: a follow-up needs a new amount);
// also_balance → flag for the summary response (spec-questions/B.md SQB-15). The SPLIT_UNSUPPORTED part of rule 3
// is decided after S5 (src/pipeline/s5-spans.ts). §8.10 LLM #2, §16.1 (sees typed words with amounts masked), I-21,
// I-40. Re-entrant through req.step_state.s4.
// Owner: Lane B.

import { CHIPS, QUESTION_TEXT, buildQuestion, matchChip } from '../contracts/catalog.js';
import { LlmFailed } from '../contracts/llm.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { ActionKind, Answer, Question } from '../contracts/types.js';
import {
  advanceItem,
  applyAnswer,
  mintItem,
  newWorkItem,
  reaskPending,
  toAmountItem,
  type PendingQ,
  type WorkItem,
} from '../amounts/verify.js';
import { buildRequestTypePrompt } from '../llm/prompt-builder/requestType.js';
import { buildBalanceAnswer } from '../messages/balance.js';
import { qid, unsupported } from '../lexical/step-util.js';

interface RequestTypeOut {
  request_type: 'actions' | 'balance' | 'unsupported';
  actions: ActionKind[];
  also_balance: boolean;
}

export interface S4State {
  classified: boolean;
  /** Q_RECURRING answered. */
  recurring_done: boolean;
  /** The amount asked with Q_AMOUNT_MISSING (rule 3), verified by the shared engine. */
  missing: WorkItem | null;
  pending: PendingQ | null;
  done: boolean;
}

function s4State(ctx: StepContext): S4State {
  let st = ctx.req.step_state.s4 as S4State | undefined;
  if (!st) {
    st = { classified: false, recurring_done: false, missing: null, pending: null, done: false };
    ctx.req.step_state.s4 = st;
  }
  return st;
}

async function classify(ctx: StepContext): Promise<RequestTypeOut | null> {
  const p = buildRequestTypePrompt(ctx.req.masked_text_s3 ?? '');
  return ctx.llm.call<RequestTypeOut>({ name: 'request_type', ...p });
}

async function s4Step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const st = s4State(ctx);
  if (st.done) return { kind: 'continue' };

  if (!st.classified) {
    let out: RequestTypeOut | null;
    try {
      out = await classify(ctx);
      // rule 3: actions empty → retry the call once; still empty → MODEL_FAILED
      if (out !== null && out.request_type === 'actions' && out.actions.length === 0) out = await classify(ctx);
    } catch (e) {
      if (e instanceof LlmFailed) return { kind: 'error', code: 'MODEL_FAILED' };
      throw e;
    }
    if (out === null) return { kind: 'error', code: 'MODEL_FAILED' };
    req.request_type = out.request_type;
    if (out.request_type === 'unsupported') {
      return { kind: 'error', code: 'UNSUPPORTED_REQUEST', final_state: 'ANSWERED' };
    }
    if (out.request_type === 'balance') {
      return { kind: 'answer', messages: buildBalanceAnswer(ctx) };
    }
    if (out.actions.length === 0) return { kind: 'error', code: 'MODEL_FAILED' };
    // Remove `l` if S2 found no cancel word. Remove nothing else.
    let actions = [...new Set(out.actions)];
    if (req.scan.cancel.length === 0) actions = actions.filter((a) => a !== 'l');
    if (actions.length === 0) return unsupported(ctx, 's4', 'S4_ONLY_L_WITHOUT_CANCEL_WORD'); // SQB-14
    req.actions = actions;
    req.also_balance = out.also_balance;
    st.classified = true;
  }

  const actions = req.actions ?? [];
  // ── recurrence cross-check → Q_RECURRING ──
  if (!st.recurring_done) {
    const hasK = actions.includes('k');
    const hasRec = req.scan.recurrence.length > 0;
    if ((hasK && !hasRec) || (!hasK && hasRec && req.amounts.length > 0)) {
      const base_text = QUESTION_TEXT.Q_RECURRING({});
      st.pending = { item_id: 0, code: 'Q_RECURRING', base_text, token: null };
      return {
        kind: 'question',
        question: buildQuestion({
          question_id: qid(),
          code: 'Q_RECURRING',
          text: base_text,
          chips: [CHIPS.REPEAT_YES, CHIPS.REPEAT_NO],
        }),
      };
    }
    st.recurring_done = true;
  }

  // ── i or k present but no pay amounts → Q_AMOUNT_MISSING (§17.2 step 5) ──
  if ((req.actions ?? []).some((a) => a === 'i' || a === 'k') && req.amounts.length === 0) {
    st.missing ??= newWorkItem(1, { kind: 'answer' });
    const a = advanceItem(ctx, st.missing);
    if (a.kind === 'question') {
      st.pending = a.pending;
      return { kind: 'question', question: a.question };
    }
    if (a.kind === 'stop') return a.result;
    mintItem(ctx, st.missing);
    req.amounts = [toAmountItem(st.missing)];
  }

  st.pending = null;
  st.done = true;
  req.state = 'TYPED';
  ctx.log.info({ event: 'typed', step: 's4', session_id: req.session_id, request_id: req.request_id });
  return { kind: 'continue' };
}

/**
 * Q_RECURRING effect (§8.5): "Yes, repeat it" → `k` (and the amounts in the recurrence clauses are no longer `i`);
 * "No, just once" → `i` instead of `k`. spec-questions/B.md SQB-21.
 */
function applyRecurring(ctx: StepContext, repeat: boolean): void {
  const { req } = ctx;
  const actions = new Set(req.actions ?? []);
  if (repeat) {
    actions.add('k');
    const recClauses = new Set(req.scan.recurrence.map((r) => r.clause_index));
    const allInRec =
      recClauses.size > 0 &&
      req.amounts.length > 0 &&
      req.amounts.every((a) => a.span !== null && recClauses.has(a.span.clause_index));
    if (allInRec) actions.delete('i');
  } else {
    actions.delete('k');
    actions.add('i');
  }
  req.actions = (['i', 'k', 'l'] as const).filter((a) => actions.has(a));
}

const s4Answer: AnswerHandler = async (ctx: StepContext, q: Question, answer: Answer): Promise<StepResult> => {
  const st = s4State(ctx);
  const pending = st.pending;
  if (!pending || pending.code !== q.code) return { kind: 'error', code: 'INTERNAL_ERROR' };
  if (pending.code === 'Q_RECURRING') {
    const chip = matchChip(q, answer);
    if (chip === null) return { kind: 'question', question: reaskPending(q, pending) };
    applyRecurring(ctx, chip.id === CHIPS.REPEAT_YES.id);
    st.recurring_done = true;
    st.pending = null;
    return { kind: 'continue' };
  }
  if (!st.missing) return { kind: 'error', code: 'INTERNAL_ERROR' };
  const again = applyAnswer(ctx, st.missing, pending, q, answer);
  if (again !== null) return { kind: 'question', question: again };
  st.pending = null;
  return { kind: 'continue' };
};

export const s4: StepEntry = { step: s4Step, onAnswer: s4Answer };
