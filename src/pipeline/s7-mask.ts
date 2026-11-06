// Implements: §8.8 S7 — Mask recipients (single → new `address_` + DB3 `single` row with chain_id = pinned chain or
// NULL; group → reuse the §9.6 `group_` placeholder; follow-up refs reuse the earlier placeholder, no new row),
// `masked_text_s8`, §7.3 rules 5–6 (one placeholder per span per request; never reused across requests except
// follow-ups), §17.2 step 4 (follow-up payee offered to S8 under SESSION with its previous chain). SQ-O-01 / SQB-23
// (human, 2026-11-06): further whole-word occurrences of a tagged text are masked with the same placeholder
// (`sweepRepeats`), without a new DB3 row; the fail-closed `s7_span_mismatch` check covers them too.

import type { Db8HistoryRow } from '../contracts/repos.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { AddressPh, ChainId, RecipientPh, RecipientRef, ResolvedRecipient } from '../contracts/types.js';
import { CHAIN_IDS } from '../contracts/types.js';
import { PERSON, sweepRepeats, type Masking } from '../lexical/sweep.js';
import { s6State } from '../recipients/state.js';

/** §17.2 step 1: session history depth. */
const HISTORY_LIMIT = 5;

/**
 * §17.2 step 4: the payee's previous chain. History rows hold the handed-off payments (placeholders only); only the
 * most recent item naming this placeholder counts: its numeric `chain_id` (SQ-C-08), else its numeric S8 `chain`,
 * else null (`"unstated"` never falls back to an older payment).
 */
export function lastChainFor(history: Db8HistoryRow[], placeholder: AddressPh): ChainId | null {
  for (const h of history) {
    let items: unknown;
    try {
      items = JSON.parse(h.payments_json);
    } catch {
      continue;
    }
    if (!Array.isArray(items)) continue;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i] as Record<string, unknown> | null;
      if (it === null || typeof it !== 'object' || it.recipient !== placeholder) continue;
      const c = typeof it.chain_id === 'number' ? it.chain_id : it.chain;
      return typeof c === 'number' && (CHAIN_IDS as readonly number[]).includes(c) ? (c as ChainId) : null;
    }
  }
  return null;
}

/**
 * Applies the replacements right to left. The offsets are in masked_text_s3 and S5 keeps no overlaps (§8.6 rule 5), so
 * a replacement that doesn't match its text or overlaps another is a bug: null, because a recipient could otherwise
 * stay readable in the text LLM #4 sees (§16.1).
 */
function applyReplacements(text: string, reps: Masking[]): string | null {
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const r of [...reps].sort((a, b) => b.start - a.start)) {
    if (r.end > floor || text.slice(r.start, r.end) !== r.text) return null;
    out = out.slice(0, r.start) + r.with + out.slice(r.end);
    floor = r.start;
  }
  return out;
}

export async function maskStep(ctx: StepContext): Promise<StepResult> {
  const req = ctx.req;
  const done = req.step_state.s7 as { done: boolean } | undefined;
  if (done?.done) return { kind: 'continue' };
  const s6 = s6State(req);
  const refs: RecipientRef[] = [];
  const reps: Masking[] = [];

  for (let i = 0; i < req.spans.length; i++) {
    const span = req.spans[i];
    const r: ResolvedRecipient | undefined = req.resolved[i];
    if (span === undefined || r === undefined) return { kind: 'error', code: 'INTERNAL_ERROR' };
    let placeholder: RecipientPh;
    if (span.followup_placeholder !== null) {
      // Follow-up: reuse the earlier request's placeholder, no new DB3 row.
      placeholder = span.followup_placeholder;
      refs.push({
        placeholder,
        span_index: i,
        type: 'person',
        source: 'session',
        followup: true,
        last_chain_id: lastChainFor(
          ctx.repos.db8.recentHistory(req.session_id, HISTORY_LIMIT),
          span.followup_placeholder,
        ),
      });
    } else if (r.kind === 'group') {
      const g = s6.groups[i];
      if (g === undefined) return { kind: 'error', code: 'INTERNAL_ERROR' };
      placeholder = g;
      refs.push({ placeholder, span_index: i, type: 'group', source: r.source, followup: false, last_chain_id: null });
    } else {
      placeholder = ctx.repos.db3.mint({
        session_id: req.session_id,
        request_id: req.request_id,
        kind: 'single',
        name: r.display_name,
        address: r.address,
        ens_name: r.ens_name,
        chain_id: r.pinned_chain_id,
        group_placeholder: null,
        source: r.source,
      });
      refs.push({ placeholder, span_index: i, type: 'person', source: r.source, followup: false, last_chain_id: null });
    }
    if (span.span !== null)
      reps.push({ start: span.span.start, end: span.span.end, text: span.text, with: placeholder });
  }
  // §8.6 rule 6 / §8.8 (CCR C-1): S5's `mentioned` spans become `[person]`.
  for (const m of req.mentioned_spans) reps.push({ start: m.start, end: m.end, text: m.text, with: PERSON });

  const source = req.masked_text_s3 ?? req.typed_text;
  const masked = applyReplacements(source, [...reps, ...sweepRepeats(source, reps)]);
  if (masked === null) {
    ctx.log.error({
      event: 'internal_error',
      step: 's7',
      error_code: 'INTERNAL_ERROR',
      rule_id: 's7_span_mismatch',
      request_id: req.request_id,
    });
    return { kind: 'error', code: 'INTERNAL_ERROR' };
  }
  req.recipients = refs;
  req.masked_text_s8 = masked;
  req.state = 'RECIPIENTS_MASKED';
  req.step_state.s7 = { done: true };
  return { kind: 'continue' };
}

export const s7: StepEntry = { step: maskStep };
