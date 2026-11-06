// Implements: §8.4 S3 — Amounts (LLM #1 + code): prompt input = unmasked typed_text; verification rules 1–8
// (phrase verbatim / first unused occurrence else dropped; context items dropped silently and masked as [amount];
// pay items verified by src/amounts/verify.ts — number pattern, Q_AMOUNT_MISSING, Q_AMOUNT_MISMATCH, token order,
// Q_TOKEN, Q_FIAT_OTHER, Q_AMOUNT_PRECISION, zero; uncovered numeric candidates → Q_AMOUNT_UNCOVERED (Yes → pay amount,
// No → ignored); mint one amount_<8hex> per pay item → DB1 (source='user', origin='phrase'|'relative', confirmed=1);
// relative amounts with chain pinning; document amounts only when there are no typed pay amounts (Q_UNTRUSTED_AMOUNT,
// else note "Amounts in the attached content weren't used."); no pay amounts → continue). Output masked_text_s3.
// §8.10 LLM #1 (MODEL_FAILED after the second failure), §16.1 (the P-LLM sees typed text only; untrusted values
// never enter a prompt), §16.2 (context amounts never stored), §17.2 step 6 (previous token, in verify.ts), D-29.
// Re-entrant through req.step_state.s3 (src/contracts/step.ts): asks one question at a time.
// Owner: Lane B.

import { CHIPS, NOTES, QUESTION_TEXT, buildQuestion, matchChip } from '../contracts/catalog.js';
import { LlmFailed } from '../contracts/llm.js';
import { TOKENS } from '../contracts/static-tables.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { Answer, Question, Span } from '../contracts/types.js';
import { parseAmountText } from '../amounts/parse.js';
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
import { buildAmountsPrompt } from '../llm/prompt-builder/amounts.js';
import { clauseIndexAt, escapeRe, findUnused, inside, overlaps, replaceRanges, type Range } from '../lexical/text.js';
import { qid, unsupported } from '../lexical/step-util.js';

interface LlmAmount {
  phrase: string;
  number: string | null;
  relative: 'all' | 'half' | 'max' | null;
  token: 'USDC' | 'ETH' | null;
  fiat: 'USD' | 'OTHER' | null;
  role: 'pay' | 'context';
}

/** One replacement of typed_text in masked_text_s3 (typed offsets). S5 maps masked offsets back with it. */
export interface Mask {
  start: number;
  end: number;
  with: string;
}

interface Uncovered {
  span: Span;
  decision: 'pending' | 'yes' | 'no';
}

export interface S3State {
  items: WorkItem[];
  /** Context phrases (typed ranges) → `[amount]`. */
  context: Range[];
  /** Ranges of every returned phrase (pay or context) for the rule 4 coverage check. */
  covered: Range[];
  uncovered: Uncovered[] | null;
  doc_started: boolean;
  pending: (PendingQ & { uncovered_index?: number }) | null;
  next_id: number;
  masks: Mask[];
  done: boolean;
}

const AMOUNT_MASK = '[amount]';

const RELATIVE_AMOUNT_RE = new RegExp(
  `^(?:all|half|max)(?:\\s+of)?(?:\\s+my)?\\s+(?:${Object.values(TOKENS)
    .flatMap((token) => token.aliases)
    .map(escapeRe)
    .join('|')})$`,
  'i',
);

/** B13: the model's number/relative fields do not prove that an arbitrary context phrase states an amount. */
function isContextAmount(phrase: string): boolean {
  const parsed = parseAmountText(phrase, null);
  return parsed.ok || parsed.reason === 'zero' || RELATIVE_AMOUNT_RE.test(phrase.trim());
}

/** Maps an offset of masked_text_s3 back to typed_text (an offset inside a replacement maps to its start). */
export function maskedToTyped(masks: readonly Mask[], offset: number): number {
  let delta = 0;
  for (const m of [...masks].sort((a, b) => a.start - b.start)) {
    const mStart = m.start + delta;
    if (offset < mStart) break;
    const mEnd = mStart + m.with.length;
    if (offset < mEnd) return m.start;
    delta += m.with.length - (m.end - m.start);
  }
  return offset - delta;
}

function s3State(ctx: StepContext): S3State | undefined {
  return ctx.req.step_state.s3 as S3State | undefined;
}

function spanOf(ctx: StepContext, r: Range): Span {
  return {
    text: ctx.req.typed_text.slice(r.start, r.end),
    start: r.start,
    end: r.end,
    clause_index: clauseIndexAt(ctx.req.scan.clauses, r.start),
  };
}

/** Fiat word that S2 found inside the phrase (code check of the LLM's `fiat`, §8.3 rule 7 / §8.4 step 3). */
function fiatInside(ctx: StepContext, r: Range): 'USD' | 'OTHER' | null {
  for (const t of ctx.req.scan.tokens) {
    if (t.start >= r.start && t.end <= r.end) {
      if (t.kind === 'FIAT_OTHER') return 'OTHER';
      if (t.kind === 'FIAT_USD') return 'USD';
    }
  }
  return null;
}

/** §8.4 rules 1–2: verbatim check and context filtering. */
function initState(ctx: StepContext, out: { amounts: LlmAmount[] }): S3State {
  const text = ctx.req.typed_text;
  const used: Range[] = [];
  const st: S3State = {
    items: [],
    context: [],
    covered: [],
    uncovered: null,
    doc_started: false,
    pending: null,
    next_id: 1,
    masks: [],
    done: false,
  };
  const pay: Array<{ r: Range; a: LlmAmount }> = [];
  for (const a of out.amounts) {
    const r = findUnused(text, a.phrase, used, true);
    if (r === null) continue; // rule 1: not verbatim → dropped
    if (a.role === 'context' && !isContextAmount(a.phrase)) continue;
    used.push(r);
    st.covered.push(r);
    if (a.role === 'context') {
      st.context.push(r); // rule 2: dropped silently (no row, not shown, not counted)
      continue;
    }
    pay.push({ r, a });
  }
  pay.sort((x, y) => x.r.start - y.r.start);
  for (const { r, a } of pay) {
    // §8.4 step 3 / §16.1: a non-USD fiat marker that S2 found inside the phrase wins over the LLM's `fiat` (R2-3),
    // so "send ₹500 to riya" asks Q_FIAT_OTHER even when LLM #1 says USD.
    const found = fiatInside(ctx, r);
    const fiat = found === 'OTHER' ? 'OTHER' : (a.fiat ?? found);
    st.items.push(
      newWorkItem(st.next_id++, {
        kind: 'typed',
        phrase: a.phrase,
        span: spanOf(ctx, r),
        number: a.number,
        relative: a.relative,
        llm_token: a.token,
        fiat,
      }),
    );
  }
  return st;
}

function questionResult(st: S3State, question: Question, pending: S3State['pending']): StepResult {
  st.pending = pending;
  return { kind: 'question', question };
}

/** Advances the typed (or document) items in order; the first question or stop ends the step. */
function advanceAll(ctx: StepContext, st: S3State, documents: boolean): StepResult | null {
  for (const item of st.items) {
    if ((item.kind === 'document') !== documents) continue;
    const a = advanceItem(ctx, item);
    if (a.kind === 'question') return questionResult(st, a.question, a.pending);
    if (a.kind === 'stop') return a.result;
  }
  return null;
}

async function s3Step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  let st = s3State(ctx);
  if (st?.done) return { kind: 'continue' };
  if (st === undefined) {
    const p = buildAmountsPrompt(req.typed_text);
    let out: { amounts: LlmAmount[] };
    try {
      out = await ctx.llm.call<{ amounts: LlmAmount[] }>({ name: 'amounts', ...p });
    } catch (e) {
      if (e instanceof LlmFailed) return { kind: 'error', code: 'MODEL_FAILED' };
      throw e;
    }
    st = initState(ctx, out);
    req.step_state.s3 = st;
  }

  // ── rules 3 and 6: verify every pay item, one question at a time ──
  const typedStop = advanceAll(ctx, st, false);
  if (typedStop !== null) return typedStop;

  // ── rule 4: uncovered numbers ──
  if (st.uncovered === null) {
    st.uncovered = req.scan.numeric_candidates
      .filter((c) => !st.covered.some((r) => inside(c, r)))
      .map((c) => ({ span: c, decision: 'pending' as const }));
  }
  for (const [i, u] of st.uncovered.entries()) {
    if (u.decision !== 'pending') continue;
    const base_text = QUESTION_TEXT.Q_AMOUNT_UNCOVERED({ n: u.span.text });
    const question = buildQuestion({
      question_id: qid(),
      code: 'Q_AMOUNT_UNCOVERED',
      text: base_text,
      chips: [CHIPS.YES, CHIPS.NO],
    });
    return questionResult(st, question, {
      item_id: 0,
      code: 'Q_AMOUNT_UNCOVERED',
      base_text,
      token: null,
      uncovered_index: i,
    });
  }

  // ── rule 7: document amounts ──
  const typedPay = st.items.filter((it) => it.kind !== 'document');
  const docAmounts = req.untrusted.map((q, index) => ({ q, index })).filter((x) => x.q.amount !== null);
  if (docAmounts.length > 0) {
    if (typedPay.length === 0) {
      if (!st.doc_started) {
        st.doc_started = true;
        for (const { q, index } of docAmounts) {
          st.items.push(
            newWorkItem(st.next_id++, {
              kind: 'document',
              number: q.amount,
              token: q.token,
              source: 'untrusted',
              untrusted_index: index,
              confirmed: false,
            }),
          );
        }
      }
      const docStop = advanceAll(ctx, st, true);
      if (docStop !== null) return docStop;
    } else if (!req.notes.includes(NOTES.CONTENT_AMOUNTS_UNUSED())) {
      req.notes.push(NOTES.CONTENT_AMOUNTS_UNUSED());
    }
  }

  // ── rule 5: mint, mask ──
  for (const item of st.items) if (item.placeholder === null) mintItem(ctx, item);
  const masks: Mask[] = [];
  for (const item of st.items) {
    if (item.kind === 'typed' && item.span !== null && item.placeholder !== null) {
      masks.push({ start: item.span.start, end: item.span.end, with: item.placeholder });
    }
  }
  for (const r of st.context) masks.push({ start: r.start, end: r.end, with: AMOUNT_MASK });
  st.masks = masks;
  req.masked_text_s3 = replaceRanges(req.typed_text, masks);
  req.amounts = st.items.map(toAmountItem);
  req.state = 'AMOUNTS_MASKED';
  st.done = true;
  st.pending = null;
  ctx.log.info({
    event: 'amounts_masked',
    step: 's3',
    session_id: req.session_id,
    request_id: req.request_id,
    n_amounts: req.amounts.length,
  });
  // rule 8: no pay amounts → continue (S4 decides)
  return { kind: 'continue' };
}

const s3Answer: AnswerHandler = async (ctx: StepContext, q: Question, answer: Answer): Promise<StepResult> => {
  const st = s3State(ctx);
  const pending = st?.pending;
  if (!st || !pending || pending.code !== q.code) return { kind: 'error', code: 'INTERNAL_ERROR' };
  if (pending.code === 'Q_AMOUNT_UNCOVERED') {
    const u = pending.uncovered_index !== undefined ? st.uncovered?.[pending.uncovered_index] : undefined;
    if (!u) return { kind: 'error', code: 'INTERNAL_ERROR' };
    const chip = matchChip(q, answer);
    if (chip === null) return { kind: 'question', question: reaskPending(q, pending) };
    if (chip.id === CHIPS.YES.id) {
      // A number that partly overlaps a returned phrase cannot be masked as its own amount (SQB-24).
      if (st.covered.some((r) => overlaps(r, u.span))) return unsupported(ctx, 's3', 'S3_UNCOVERED_OVERLAPS_PHRASE');
      u.decision = 'yes';
      const parsed = parseAmountText(u.span.text, null);
      st.items.push(
        newWorkItem(st.next_id++, {
          kind: 'typed',
          phrase: u.span.text,
          span: u.span,
          number: parsed.ok ? parsed.value : parsed.reason === 'zero' ? '0' : null,
          fiat: fiatInside(ctx, u.span),
        }),
      );
      st.covered.push(u.span);
    } else {
      u.decision = 'no';
    }
    st.pending = null;
    return { kind: 'continue' };
  }
  const item = st.items.find((it) => it.id === pending.item_id);
  if (!item) return { kind: 'error', code: 'INTERNAL_ERROR' };
  const again = applyAnswer(ctx, item, pending, q, answer);
  if (again !== null) return { kind: 'question', question: again };
  st.pending = null;
  return { kind: 'continue' };
};

export const s3: StepEntry = { step: s3Step, onAnswer: s3Answer };
