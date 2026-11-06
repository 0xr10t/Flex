// Implements: §8.6 S5 — Recipient spans (LLM #3 + code): prompt input masked_text_s3 + CANDIDATES (every address,
// ENS and group candidate of S2, text as in the masked text); rules 1–9 (verbatim; drop chain/token aliases,
// back-reference words, placeholders, me/my/I; address regex / normalize(); missing candidates added as payees;
// overlaps keep the longest; `mentioned` dropped silently → [person] in S7; follow-ups from session history;
// document addresses as untrusted payees; Q_NO_PAYEE). §17.2 steps 2–3 (follow-up = back-reference word and no
// payee; previous single payees of the most recent history entry: one → used, several → Q_FOLLOWUP_WHO, none →
// Q_NO_PAYEE; the chosen payee keeps its earlier placeholder in `followup_placeholder` for S6/S7). §8.5 rule 3
// SPLIT_UNSUPPORTED (decided here, after S5). §16.1 provenance (document payees only when the typed text has none),
// §16.2 / D-29 (mentioned names never stored or looked up). SQ-O-01 / F-12 (human, 2026-11-06): a name tagged both
// payee and mentioned → Q_NAME_ROLE "Should I pay {name}?"; "Yes, pay {name}" keeps it a payee (its mentioned
// occurrences go, S7 sweeps them to the payee placeholder), "No, they're only mentioned" turns its payee spans into
// mentioned ones (all become [person]; with no payee left the normal no-payee flow follows). One name is one contact
// (D-11), so the answer covers every occurrence. Re-entrant through req.step_state.s5.
// SQ-S-01: an amount correction with no new payee reuses the immediately previous failed payment's recipient.
// SQ-S-02: explanatory prose is allowed, but a mentioned person makes the reference ambiguous; ask instead.
// An explicit new payee takes the ordinary resolution path and does not inherit the old recipient's chain.
// Owner: Lane B.

import { normalize } from 'viem/ens';
import {
  NAME_ROLE,
  NAME_ROLE_CHIP,
  NAME_ROLE_YES_NO,
  QUESTION_TEXT,
  buildQuestion,
  joinList,
  matchChip,
} from '../contracts/catalog.js';
import { LlmFailed } from '../contracts/llm.js';
import { shortAddress } from '../contracts/money.js';
import {
  BACK_REFERENCE_WORDS,
  FIAT_OTHER_WORDS,
  FIAT_USD_WORDS,
  SELF_WORDS,
  TOKENS,
} from '../contracts/static-tables.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { AddressPh, Answer, Chip, Question, RecipientSpan, Span, SpanKind } from '../contracts/types.js';
import { buildSpansPrompt } from '../llm/prompt-builder/spans.js';
import { ADDRESS_FULL_RE, PLACEHOLDER_TOKEN_RE } from '../lexical/patterns.js';
import { lastHistoryPayments, qid } from '../lexical/step-util.js';
import { reaskPending } from '../amounts/verify.js';
import { nameKey } from '../lexical/sweep.js';
import { clauseIndexAt, findUnused, overlaps, type Range } from '../lexical/text.js';
import { maskedToTyped, type S3State } from './s3-amounts.js';

interface LlmSpan {
  text: string;
  kind: SpanKind;
  role: 'payee' | 'mentioned';
}

interface FollowupChoice {
  placeholder: AddressPh;
  label: string;
}

export interface S5State {
  tagged: boolean;
  /** LLM #3 spans after rules 1–5, kept while Q_NAME_ROLE questions settle their roles (F-12). */
  raw: Tagged[] | null;
  pending:
    | { code: 'Q_FOLLOWUP_WHO' | 'Q_NO_PAYEE'; base_text: string; choices: FollowupChoice[] }
    | { code: 'Q_NAME_ROLE'; base_text: string; name_key: string }
    | null;
  done: boolean;
}

const PLACEHOLDER_RE = new RegExp(PLACEHOLDER_TOKEN_RE.source);

function s5State(ctx: StepContext): S5State {
  let st = ctx.req.step_state.s5 as S5State | undefined;
  if (!st) {
    st = { tagged: false, raw: null, pending: null, done: false };
    ctx.req.step_state.s5 = st;
  }
  return st;
}

function normalizes(text: string): boolean {
  try {
    normalize(text);
    return true;
  } catch {
    return false;
  }
}

/** Rule 2 word list: chain aliases (config, plus `eth`), token aliases (§6.2, incl. fiat words), back-references, me/my/I. */
function droppedWords(ctx: StepContext): Set<string> {
  const words = new Set<string>(['eth', 'myself']); // Handoff LIVE-P046: self references are never payees.
  for (const c of ctx.config.chains) for (const a of c.aliases) words.add(a.toLowerCase());
  for (const t of [...TOKENS.USDC.aliases, ...TOKENS.ETH.aliases, ...FIAT_USD_WORDS, ...FIAT_OTHER_WORDS]) {
    words.add(t.toLowerCase());
  }
  for (const w of [...BACK_REFERENCE_WORDS, ...SELF_WORDS]) words.add(w.toLowerCase());
  return words;
}

/** A span of masked_text_s3, with the clause of the typed text it maps to. */
function maskedSpan(ctx: StepContext, r: Range, text: string): Span {
  const masks = (ctx.req.step_state.s3 as S3State | undefined)?.masks ?? [];
  return {
    text,
    start: r.start,
    end: r.end,
    clause_index: clauseIndexAt(ctx.req.scan.clauses, maskedToTyped(masks, r.start)),
  };
}

interface Tagged {
  text: string;
  kind: SpanKind;
  role: 'payee' | 'mentioned';
  range: Range;
}

/** Rules 1–6 over the LLM #3 output. */
function filterSpans(
  ctx: StepContext,
  masked: string,
  out: LlmSpan[],
  candidates: Array<{ text: string; kind: SpanKind }>,
): Tagged[] {
  const drop = droppedWords(ctx);
  // Occurrences already taken, per span text: a text returned twice takes its next occurrence. Overlaps between
  // different texts are left to rule 5 (so the longest span wins whatever the model's output order).
  const usedByText = new Map<string, Range[]>();
  const claim = (text: string): Range | null => {
    const used = usedByText.get(text) ?? [];
    const range = findUnused(masked, text, used, 'identifier');
    if (range !== null) usedByText.set(text, [...used, range]);
    return range;
  };
  const kept: Tagged[] = [];
  for (const s of out) {
    const t = s.text.trim().toLowerCase();
    if (drop.has(t) || PLACEHOLDER_RE.test(s.text)) continue; // rule 2
    if (s.kind === 'address' && !ADDRESS_FULL_RE.test(s.text)) continue; // rule 3
    if ((s.kind === 'ens' || s.kind === 'group') && !normalizes(s.text)) continue;
    const range = claim(s.text);
    if (range === null) continue; // rule 1
    kept.push({ text: s.text, kind: s.kind, role: s.role, range });
  }
  // rule 4: every S2 candidate missing from the output is added as a payee (the S2 kind wins, SQB-16)
  for (const c of candidates) {
    const same = kept.find((k) => k.text === c.text);
    if (same) {
      same.kind = c.kind;
      continue;
    }
    const range = claim(c.text);
    if (range === null) continue;
    kept.push({ text: c.text, kind: c.kind, role: 'payee', range });
  }
  // rule 5: overlapping spans → keep the longest (ties: the earlier one)
  const byLength = [...kept].sort(
    (a, b) => b.range.end - b.range.start - (a.range.end - a.range.start) || a.range.start - b.range.start,
  );
  const result: Tagged[] = [];
  for (const s of byLength) if (!result.some((r) => overlaps(r.range, s.range))) result.push(s);
  return result.sort((a, b) => a.range.start - b.range.start);
}

/** F-12: the first payee span (in text order) whose name is also tagged `mentioned`, else null. */
function roleConflict(tagged: readonly Tagged[]): Tagged | null {
  const mentioned = new Set(tagged.filter((t) => t.role === 'mentioned').map((t) => nameKey(t.text)));
  return tagged.find((t) => t.role === 'payee' && mentioned.has(nameKey(t.text))) ?? null;
}

function nameRoleQuestion(st: S5State, payee: Tagged): StepResult {
  const name = payee.text;
  const base_text = NAME_ROLE.text({ name });
  st.pending = { code: 'Q_NAME_ROLE', base_text, name_key: nameKey(name) };
  return {
    kind: 'question',
    question: buildQuestion({
      question_id: qid(),
      code: 'Q_NAME_ROLE',
      text: base_text,
      chips: NAME_ROLE.chips({ name }),
    }),
  };
}

/** §17.2 step 3: single (non-group) recipients of the most recent history entry, in order, deduplicated. */
function previousPayees(ctx: StepContext): FollowupChoice[] {
  const out: FollowupChoice[] = [];
  for (const p of lastHistoryPayments(ctx)) {
    const ph = p.recipient;
    if (typeof ph !== 'string' || !ph.startsWith('address_')) continue;
    if (out.some((o) => o.placeholder === ph)) continue;
    const row = ctx.repos.db3.get(ph as AddressPh);
    if (!row || row.kind === 'group') continue;
    const label = row.name ?? row.ens_name ?? (row.address !== null ? shortAddress(row.address) : ph);
    out.push({ placeholder: ph as AddressPh, label });
  }
  return out;
}

function followupSpan(c: FollowupChoice): RecipientSpan {
  return {
    text: c.label,
    kind: 'name',
    role: 'payee',
    span: null,
    source: 'user',
    followup_placeholder: c.placeholder,
    untrusted_item_index: null,
  };
}

function noPayeeQuestion(st: S5State): StepResult {
  const base_text = QUESTION_TEXT.Q_NO_PAYEE({});
  st.pending = { code: 'Q_NO_PAYEE', base_text, choices: [] };
  return { kind: 'question', question: buildQuestion({ question_id: qid(), code: 'Q_NO_PAYEE', text: base_text }) };
}

/** LLM #3 over masked_text_s3 and the S2 candidates, then rules 1–5. null: the model failed (MODEL_FAILED). */
async function tagSpans(ctx: StepContext): Promise<Tagged[] | null> {
  const req = ctx.req;
  const masked = req.masked_text_s3 ?? req.typed_text;
  // CANDIDATES: every address, ENS and group candidate from S2, text as in the masked text.
  const candidates: Array<{ text: string; kind: SpanKind }> = [];
  const seen = new Set<string>();
  const add = (text: string, kind: SpanKind): void => {
    if (seen.has(text) || !masked.includes(text)) return;
    seen.add(text);
    candidates.push({ text, kind });
  };
  const all = [
    ...req.scan.addresses.map((s) => ({ s, kind: 'address' as const, text: s.text })),
    ...req.scan.ens.map((s) => ({ s, kind: 'ens' as const, text: s.text })),
    ...req.scan.groups.map((s) => ({ s, kind: 'group' as const, text: s.parent })),
  ].sort((a, b) => a.s.start - b.s.start);
  for (const c of all) add(c.text, c.kind);

  const p = buildSpansPrompt(
    masked,
    candidates.map((c) => c.text),
  );
  let out: { spans: LlmSpan[] };
  try {
    out = await ctx.llm.call<{ spans: LlmSpan[] }>({ name: 'spans', ...p });
  } catch (e) {
    if (e instanceof LlmFailed) return null;
    throw e;
  }
  return filterSpans(ctx, masked, out.spans, candidates);
}

async function s5Step(ctx: StepContext): Promise<StepResult> {
  const req = ctx.req;
  const st = s5State(ctx);
  if (st.done) return { kind: 'continue' };

  if (!st.tagged) {
    if (st.raw === null) {
      st.raw = await tagSpans(ctx);
      if (st.raw === null) return { kind: 'error', code: 'MODEL_FAILED' };
    }
    // F-12: one name tagged with both roles → ask, one name at a time.
    const conflict = roleConflict(st.raw);
    if (conflict !== null) return nameRoleQuestion(st, conflict);
    const tagged = st.raw;
    st.raw = null;
    req.spans = tagged
      .filter((t) => t.role === 'payee')
      .map((t) => ({
        text: t.text,
        kind: t.kind,
        role: 'payee' as const,
        span: maskedSpan(ctx, t.range, t.text),
        source: 'user' as const,
        followup_placeholder: null,
        untrusted_item_index: null,
      }));
    // rule 6: mentioned spans are dropped silently (no lookup, no placeholder); S7 masks them as [person].
    req.mentioned_spans = tagged.filter((t) => t.role === 'mentioned').map((t) => maskedSpan(ctx, t.range, t.text));
    st.tagged = true;
    if (req.spans.length > 0) delete req.retry_context;

    if (req.spans.length === 0) {
      if (req.retry_context !== undefined) {
        const amount = req.amounts.length === 1 ? req.amounts[0] : undefined;
        if (
          req.mentioned_spans.length > 0 ||
          req.actions?.length !== 1 ||
          req.actions[0] !== 'i' ||
          amount === undefined ||
          amount.source !== 'user' ||
          !amount.confirmed ||
          amount.relative !== null
        ) {
          delete req.retry_context;
          return noPayeeQuestion(st);
        }
        const row = ctx.repos.db3.get(req.retry_context.recipient);
        if (!row || row.kind !== 'single' || row.address === null) return { kind: 'error', code: 'INTERNAL_ERROR' };
        req.spans = [
          followupSpan({
            placeholder: req.retry_context.recipient,
            label: row.name ?? row.ens_name ?? shortAddress(row.address),
          }),
        ];
      } else if (req.scan.back_reference.length > 0) {
        // rule 7 / §17.2 steps 2–3: follow-up
        const prev = previousPayees(ctx);
        const only = prev.length === 1 ? prev[0] : undefined;
        if (only !== undefined) {
          req.spans = [followupSpan(only)];
        } else if (prev.length > 1) {
          const base_text = QUESTION_TEXT.Q_FOLLOWUP_WHO({ names: joinList(prev.map((c) => c.label)) });
          st.pending = { code: 'Q_FOLLOWUP_WHO', base_text, choices: prev };
          const chips: Chip[] = prev.map((c) => ({ id: c.placeholder, label: c.label, disabled: false, detail: '' }));
          return {
            kind: 'question',
            question: buildQuestion({ question_id: qid(), code: 'Q_FOLLOWUP_WHO', text: base_text, chips }),
          };
        } else {
          return noPayeeQuestion(st);
        }
      } else {
        // rule 8: document addresses / ENS names become untrusted payees (SQB-17: an item's address wins over its ENS)
        const seenDoc = new Set<string>();
        req.untrusted.forEach((q, index) => {
          const text = q.address ?? q.ens_name;
          if (text === null) return;
          const key = text.toLowerCase();
          if (seenDoc.has(key)) return;
          seenDoc.add(key);
          req.spans.push({
            text,
            kind: q.address !== null ? 'address' : 'ens',
            role: 'payee',
            span: null,
            source: 'untrusted',
            followup_placeholder: null,
            untrusted_item_index: index,
          });
        });
      }
    }
  }

  // rule 9: actions i/k/l and still no payees → Q_NO_PAYEE
  if (req.spans.length === 0 && (req.actions ?? []).some((a) => a === 'i' || a === 'k' || a === 'l')) {
    return noPayeeQuestion(st);
  }

  // §8.5 rule 3 (decided after S5): split word + exactly one pay amount + two or more recipients
  if (req.scan.split.length > 0 && req.amounts.length === 1 && req.spans.length >= 2) {
    return { kind: 'error', code: 'SPLIT_UNSUPPORTED' };
  }

  st.pending = null;
  st.done = true;
  req.state = 'SPANS_TAGGED';
  ctx.log.info({
    event: 'spans_tagged',
    step: 's5',
    session_id: req.session_id,
    request_id: req.request_id,
    n_payees: req.spans.length,
  });
  return { kind: 'continue' };
}

function looksLikeEns(t: string): boolean {
  return /^[^\s]+\.[^\s]+$/.test(t) && normalizes(t);
}

const s5Answer: AnswerHandler = async (ctx: StepContext, q: Question, answer: Answer): Promise<StepResult> => {
  const st = s5State(ctx);
  const pending = st.pending;
  if (!pending || pending.code !== q.code) return { kind: 'error', code: 'INTERNAL_ERROR' };
  const again = (): StepResult => ({ kind: 'question', question: reaskPending(q, pending) });
  if (pending.code === 'Q_NAME_ROLE') {
    const chip = matchChip(q, answer, NAME_ROLE_YES_NO);
    if (chip === null || !st.raw) return again();
    const same = (t: Tagged): boolean => nameKey(t.text) === pending.name_key;
    st.raw =
      chip.id === NAME_ROLE_CHIP.PAY
        ? st.raw.filter((t) => !(same(t) && t.role === 'mentioned'))
        : st.raw.map((t) => (same(t) ? { ...t, role: 'mentioned' as const } : t));
  } else if (pending.code === 'Q_FOLLOWUP_WHO') {
    const chip = matchChip(q, answer);
    const choice = chip === null ? undefined : pending.choices.find((c) => c.placeholder === chip.id);
    if (choice === undefined) return again();
    ctx.req.spans = [followupSpan(choice)];
  } else {
    // Q_NO_PAYEE: text (name, ENS or address), resolved by S6 via §9
    const t = answer.kind === 'text' ? answer.text.trim() : '';
    if (t.length === 0) return again();
    const kind: SpanKind = ADDRESS_FULL_RE.test(t) ? 'address' : looksLikeEns(t) ? 'ens' : 'name';
    ctx.req.spans = [
      {
        text: t,
        kind,
        role: 'payee',
        span: null,
        source: 'user',
        followup_placeholder: null,
        untrusted_item_index: null,
      },
    ];
  }
  st.pending = null;
  return { kind: 'continue' };
};

export const s5: StepEntry = { step: s5Step, onAnswer: s5Answer };
