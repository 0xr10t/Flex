// Implements: §8.4 step 3 per-item verification (number pattern, Q_AMOUNT_MISSING, code parse equality →
// Q_AMOUNT_MISMATCH, token order (a)–(e) → Q_TOKEN, fiat OTHER / fiat USD with ETH → Q_FIAT_OTHER, precision →
// Q_AMOUNT_PRECISION, zero → Q_AMOUNT_MISSING "amount must be more than 0"), §8.4 step 6 relative amounts (token,
// chain choice, all/max = spendable, half rounded down, 0 → INSUFFICIENT_FUNDS, pinned chain), §8.4 step 7 document
// amounts (Q_TOKEN for a null token, mint source='untrusted' origin='document' confirmed=0, Q_UNTRUSTED_AMOUNT,
// "Type a different amount" → number → source='user' confirmed=1), §17.2 step 6 (previous payment's token instead of
// Q_TOKEN), §13.4 answer validation for these questions (number answers via the S3 code parser, chips via
// matchChip), §9.7 re-asks (attempt + 1), I-19, I-41, I-42, I-43. NFR-06: values are decimal strings / bigint only.
// Shared by S3 (src/pipeline/s3-amounts.ts) and S4's Q_AMOUNT_MISSING (src/pipeline/s4-type.ts).
// Owner: Lane B.

import {
  CHIPS,
  QUESTION_TEXT,
  REASK_HINT,
  buildQuestion,
  insufficientFundsParams,
  joinList,
  matchChip,
  withHint,
} from '../contracts/catalog.js';
import { fractionDigits, fromBaseUnits, isDecimalString, toBaseUnits } from '../contracts/money.js';
import type { StepContext, StepResult } from '../contracts/step.js';
import {
  TOKEN_DECIMALS,
  type AmountItem,
  type AmountPh,
  type Answer,
  type ChainId,
  type Chip,
  type Question,
  type QuestionCode,
  type Span,
  type Token,
  type TokenWordKind,
} from '../contracts/types.js';
import { chainName, lastHistoryPayments, qid, spendable, unsupported } from '../lexical/step-util.js';
import { parseAmountText } from './parse.js';

/** One amount being verified. Lives in `req.step_state` (S3 / S4), so it must stay JSON-serialisable. */
export interface WorkItem {
  id: number;
  /** typed: a pay phrase of typed_text (incl. uncovered numbers answered "Yes"); answer: Q_AMOUNT_MISSING from S4. */
  kind: 'typed' | 'answer' | 'document';
  phrase: string | null;
  /** Span in typed_text (offsets + clause), null for answer / document items. */
  span: Span | null;
  /** The LLM #1 number (or the Q-LLM amount for documents). */
  number: string | null;
  relative: 'all' | 'half' | 'max' | null;
  llm_token: Token | null;
  fiat: 'USD' | 'OTHER' | null;
  value: string | null;
  value_done: boolean;
  token: Token | null;
  /** True after Q_FIAT_OTHER was answered: an unknown token is asked with Q_TOKEN directly (SQ-09). */
  token_direct: boolean;
  code_verified: boolean;
  source: 'user' | 'untrusted';
  /** Index into req.untrusted (document items). */
  untrusted_index: number | null;
  pinned_chain_id: ChainId | null;
  placeholder: AmountPh | null;
  /** Document items: Q_UNTRUSTED_AMOUNT answered (or the value was typed by the user). */
  confirmed: boolean;
  /** Document items: "Type a different amount" chosen, Q_AMOUNT_MISSING pending. */
  retype: boolean;
  /** Code-parser value kept for the Q_AMOUNT_MISMATCH chips. */
  mismatch: { code: string; llm: string } | null;
}

/** The question an item is waiting on. */
export interface PendingQ {
  item_id: number;
  code: QuestionCode;
  /** Question text without any re-ask hint (SQ-04: hint + space + question). */
  base_text: string;
  /** Q_FIAT_OTHER: the token the answer is in, when known. */
  token: Token | null;
}

export type Advance =
  { kind: 'done' } | { kind: 'question'; question: Question; pending: PendingQ } | { kind: 'stop'; result: StepResult };

export function newWorkItem(id: number, over: Partial<WorkItem> & Pick<WorkItem, 'kind'>): WorkItem {
  return {
    id,
    phrase: null,
    span: null,
    number: null,
    relative: null,
    llm_token: null,
    fiat: null,
    value: null,
    value_done: false,
    token: null,
    token_direct: false,
    code_verified: false,
    source: 'user',
    untrusted_index: null,
    pinned_chain_id: null,
    placeholder: null,
    confirmed: true,
    retype: false,
    mismatch: null,
    ...over,
  };
}

/** Canonical form of a plain decimal ("050.50" → "50.5"), at its own precision. */
export function canonicalDecimal(s: string): string {
  const d = fractionDigits(s);
  return fromBaseUnits(toBaseUnits(s, d), d);
}

function isZero(s: string): boolean {
  return /^0+(\.0+)?$/.test(s);
}

function ask(
  item: WorkItem,
  code: QuestionCode,
  opts: { params?: Record<string, string>; chips?: Chip[]; hint?: string; token?: Token | null } = {},
): Advance {
  const base_text = QUESTION_TEXT[code](opts.params ?? {});
  const args: Parameters<typeof buildQuestion>[0] = {
    question_id: qid(),
    code,
    text: opts.hint !== undefined ? withHint(opts.hint, base_text) : base_text,
  };
  if (opts.chips !== undefined) args.chips = opts.chips;
  return {
    kind: 'question',
    question: buildQuestion(args),
    pending: { item_id: item.id, code, base_text, token: opts.token ?? null },
  };
}

/** §9.7 / §13.4: the same question again, new id, attempt + 1, optional hint in front of the original text. */
export function reaskPending(q: Question, pending: Pick<PendingQ, 'base_text'>, hint?: string): Question {
  return {
    ...q,
    question_id: qid(),
    attempt: q.attempt + 1,
    text: hint !== undefined ? withHint(hint, pending.base_text) : pending.base_text,
  };
}

function mapKind(k: TokenWordKind): Token | 'FIAT_OTHER' {
  if (k === 'FIAT_USD') return 'USDC';
  if (k === 'FIAT_OTHER') return 'FIAT_OTHER';
  return k;
}

/** §17.2 step 6: the token of the previous payment (most recent history entry), when it names exactly one. */
export function previousToken(ctx: StepContext): Token | null {
  if (ctx.req.scan.back_reference.length === 0) return null;
  const tokens = new Set<Token>();
  for (const p of lastHistoryPayments(ctx)) {
    if (p.token === 'USDC' || p.token === 'ETH') tokens.add(p.token);
    else if (typeof p.amount === 'string' && p.amount.startsWith('amount_')) {
      const row = ctx.repos.db1.get(p.amount as AmountPh);
      if (row) tokens.add(row.token);
    }
  }
  return tokens.size === 1 ? ([...tokens][0] ?? null) : null;
}

/** §8.4 step 3 token order (a)–(d) and §17.2 step 6. Null → Q_TOKEN. 'FIAT_OTHER' → Q_FIAT_OTHER. */
export function inferToken(ctx: StepContext, item: WorkItem): Token | 'FIAT_OTHER' | null {
  if (item.llm_token !== null) return item.llm_token; // (a)
  if (item.fiat === 'USD') return 'USDC'; // (b)
  const tokens = ctx.req.scan.tokens;
  if (item.span !== null) {
    // (c) a token word in the same clause (one kind of token there)
    const kinds = new Set(tokens.filter((t) => t.clause_index === item.span?.clause_index).map((t) => mapKind(t.kind)));
    if (kinds.size === 1) return [...kinds][0] ?? null;
  }
  // (d) exactly one token word in the whole prompt
  const only = tokens.length === 1 ? tokens[0] : undefined;
  if (only !== undefined) return mapKind(only.kind);
  return previousToken(ctx); // §17.2 step 6, else (e) Q_TOKEN
}

function chainsDistinct(list: ReadonlyArray<{ chain_id: ChainId }>): ChainId[] {
  return [...new Set(list.map((c) => c.chain_id))];
}

/** §8.4 step 6: chain and value of a relative amount. */
function resolveRelative(ctx: StepContext, item: WorkItem, token: Token): Advance {
  const { scan } = ctx.req;
  const decimals = TOKEN_DECIMALS[token];
  let chain: ChainId | null = null;
  const inClause =
    item.span === null ? [] : chainsDistinct(scan.chains.filter((c) => c.clause_index === item.span?.clause_index));
  const inPrompt = chainsDistinct(scan.chains);
  if (inClause.length === 1) chain = inClause[0] ?? null;
  else if (inPrompt.length === 1) chain = inPrompt[0] ?? null;
  let amount: bigint;
  if (chain !== null) {
    if (!ctx.limits.allowed_chain_ids.includes(chain)) {
      // spec-questions/B.md SQB-20
      return {
        kind: 'stop',
        result: { kind: 'error', code: 'CHAIN_NOT_ALLOWED', params: { chain: chainName(ctx.config, chain) } },
      };
    }
    const sp = spendable(ctx, chain, token);
    if (sp === null) {
      return {
        kind: 'stop',
        result: { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: chainName(ctx.config, chain) } },
      };
    }
    amount = sp;
  } else {
    // the allowed `ok` chain with the largest spendable balance of that token (§10.1); ties → allowlist order
    let best: { chain: ChainId; sp: bigint } | null = null;
    for (const c of ctx.limits.allowed_chain_ids) {
      const sp = spendable(ctx, c, token);
      if (sp === null) continue;
      if (best === null || sp > best.sp) best = { chain: c, sp };
    }
    if (best === null) {
      const names = joinList(ctx.limits.allowed_chain_ids.map((c) => chainName(ctx.config, c)));
      return { kind: 'stop', result: { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: names } } };
    }
    chain = best.chain;
    amount = best.sp;
  }
  const value = item.relative === 'half' ? amount / 2n : amount;
  if (value === 0n) {
    // SQB-11 with SQ-08 / F-10: a zero chain is not listed, so "…, and can use 0." (no "across" part).
    const have = fromBaseUnits(amount, decimals);
    return {
      kind: 'stop',
      result: {
        kind: 'error',
        code: 'INSUFFICIENT_FUNDS',
        params: insufficientFundsParams({
          token,
          need: '0',
          have,
          chains: [{ name: chainName(ctx.config, chain), spendable: have }],
        }),
      },
    };
  }
  item.value = fromBaseUnits(value, decimals);
  item.value_done = true;
  item.pinned_chain_id = chain;
  item.code_verified = false;
  return { kind: 'done' };
}

/** Item resolved enough to mint? */
export function itemReady(item: WorkItem): boolean {
  return item.value_done && item.value !== null && item.token !== null;
}

function originOf(item: WorkItem): AmountItem['origin'] {
  return item.relative !== null ? 'relative' : item.kind === 'document' ? 'document' : 'phrase';
}

/** DB1 row for an item (§8.4 steps 5–7). */
export function mintItem(ctx: StepContext, item: WorkItem): AmountPh {
  if (item.value === null || item.token === null) throw new Error('mintItem: unresolved amount');
  const ph = ctx.repos.db1.mint({
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
    amount: item.value,
    token: item.token,
    source: item.source,
    origin: originOf(item),
    confirmed: item.confirmed,
  });
  item.placeholder = ph;
  return ph;
}

export function toAmountItem(item: WorkItem): AmountItem {
  if (item.value === null || item.token === null || item.placeholder === null) {
    throw new Error('toAmountItem: unresolved amount');
  }
  return {
    placeholder: item.placeholder,
    phrase: item.phrase,
    span: item.span,
    amount: item.value,
    token: item.token,
    source: item.source,
    origin: originOf(item),
    confirmed: item.confirmed,
    relative: item.relative,
    fiat: item.fiat,
    pinned_chain_id: item.pinned_chain_id,
    code_verified: item.code_verified,
    untrusted_item_index: item.untrusted_index,
  };
}

/**
 * Moves one item forward until it needs an answer, stops the request, or is fully verified. Document items are
 * minted here (§8.4 step 7 mints before Q_UNTRUSTED_AMOUNT); other items are minted by the caller (§8.4 step 5).
 */
export function advanceItem(ctx: StepContext, item: WorkItem): Advance {
  // ── value ──
  if (!item.value_done && item.relative === null) {
    if (item.kind === 'document') {
      if (item.number === null || !isDecimalString(item.number)) return ask(item, 'Q_AMOUNT_MISSING');
      item.value = canonicalDecimal(item.number);
      item.value_done = true;
      item.code_verified = true; // a document value is shown with the "From attached content" note, not "You wrote"
    } else if (item.fiat === 'OTHER' || (item.fiat === 'USD' && item.llm_token === 'ETH')) {
      // I-41: no price feed. "{USDC or ETH}" names the token when it is known.
      const token = item.fiat === 'USD' ? 'ETH' : item.llm_token;
      const params: Record<string, string> = { phrase: item.phrase ?? item.number ?? '' };
      if (token !== null) params.token = token;
      return ask(item, 'Q_FIAT_OTHER', { params, token });
    } else if (item.number === null) {
      return ask(item, 'Q_AMOUNT_MISSING');
    } else if (!isDecimalString(item.number)) {
      // "number MUST match ^\d+(\.\d+)?$" — a non-null number that does not: spec-questions/B.md SQB-06.
      return { kind: 'stop', result: unsupported(ctx, 's3', 'S3_NUMBER_PATTERN') };
    } else {
      const llm = canonicalDecimal(item.number);
      const parsed = item.phrase !== null ? parseAmountText(item.phrase, null) : null;
      if (parsed !== null && parsed.ok) {
        if (parsed.value !== llm) {
          item.mismatch = { code: parsed.value, llm };
          const chips: Chip[] = [
            { id: 'code', label: parsed.value, disabled: false, detail: '' },
            { id: 'llm', label: llm, disabled: false, detail: '' },
          ];
          return ask(item, 'Q_AMOUNT_MISMATCH', { params: { a: parsed.value, b: llm }, chips });
        }
        item.code_verified = true;
      } else if (parsed !== null && parsed.reason === 'zero') {
        item.code_verified = isZero(llm);
      }
      item.value = llm;
      item.value_done = true;
    }
  }

  // ── zero ──
  if (item.value_done && item.value !== null && item.relative === null && isZero(item.value)) {
    item.value_done = false;
    item.value = null;
    return ask(item, 'Q_AMOUNT_MISSING', { hint: REASK_HINT.AMOUNT_ZERO() });
  }

  // ── token ──
  if (item.token === null) {
    const t = item.kind === 'document' || item.token_direct ? null : inferToken(ctx, item);
    if (t === 'FIAT_OTHER') {
      item.fiat = 'OTHER';
      item.value_done = item.relative !== null ? item.value_done : false;
      item.value = item.relative !== null ? item.value : null;
      if (item.relative === null) return advanceItem(ctx, item);
      return ask(item, 'Q_TOKEN', { params: { amount: item.phrase ?? '' }, chips: [CHIPS.USDC, CHIPS.ETH] });
    }
    if (t === null) {
      const amount = item.relative !== null ? (item.phrase ?? '') : (item.value ?? '');
      return ask(item, 'Q_TOKEN', { params: { amount }, chips: [CHIPS.USDC, CHIPS.ETH] });
    }
    item.token = t;
  }

  // ── relative (§8.4 step 6) ──
  if (item.relative !== null) {
    if (!item.value_done) return resolveRelative(ctx, item, item.token);
    return { kind: 'done' };
  }

  // ── precision ──
  if (item.value !== null && fractionDigits(item.value) > TOKEN_DECIMALS[item.token]) {
    return ask(item, 'Q_AMOUNT_PRECISION', { params: { token: item.token, d: String(TOKEN_DECIMALS[item.token]) } });
  }

  // ── document: mint, then Q_UNTRUSTED_AMOUNT (§8.4 step 7) ──
  if (item.kind === 'document' && !item.confirmed) {
    if (item.placeholder === null) mintItem(ctx, item);
    if (item.retype) return ask(item, 'Q_AMOUNT_MISSING');
    return ask(item, 'Q_UNTRUSTED_AMOUNT', {
      params: { amount: item.value ?? '', token: item.token },
      chips: [CHIPS.USE_AMOUNT, CHIPS.TYPE_AMOUNT],
    });
  }
  return { kind: 'done' };
}

function textOf(answer: Answer): string | null {
  return answer.kind === 'text' ? answer.text.trim() : null;
}

/** A value the user typed replaces a document value: the row becomes source='user', confirmed=1 (§8.4 step 7). */
function userTyped(ctx: StepContext, item: WorkItem): void {
  if (item.kind !== 'document') return;
  item.source = 'user';
  item.confirmed = true;
  item.retype = false;
  if (item.placeholder !== null && item.value !== null) {
    const patch: { amount: string; source: 'user'; confirmed: true; token?: Token } = {
      amount: item.value,
      source: 'user',
      confirmed: true,
    };
    if (item.token !== null) patch.token = item.token;
    ctx.repos.db1.update(item.placeholder, patch);
  }
}

/**
 * Applies an answer to the item's pending question (§13.4 "Valid answer → effect"). Returns null when the answer was
 * accepted (the caller re-enters the step), or the re-asked question when it was invalid.
 */
export function applyAnswer(
  ctx: StepContext,
  item: WorkItem,
  pending: PendingQ,
  q: Question,
  answer: Answer,
): Question | null {
  switch (pending.code) {
    case 'Q_AMOUNT_MISSING':
    case 'Q_FIAT_OTHER':
    case 'Q_AMOUNT_PRECISION': {
      const t = textOf(answer);
      if (t === null) return reaskPending(q, pending);
      const token = item.token ?? pending.token;
      const p = parseAmountText(t, token);
      if (!p.ok) return reaskPending(q, pending, p.reason === 'zero' ? REASK_HINT.AMOUNT_ZERO() : undefined);
      item.value = p.value;
      item.value_done = true;
      item.code_verified = true;
      item.mismatch = null;
      if (pending.code === 'Q_FIAT_OTHER') {
        item.fiat = null;
        item.token = pending.token;
        item.token_direct = true;
      }
      userTyped(ctx, item);
      return null;
    }
    case 'Q_AMOUNT_MISMATCH': {
      const chip = matchChip(q, answer);
      if (chip === null || item.mismatch === null) return reaskPending(q, pending);
      item.value = chip.id === 'code' ? item.mismatch.code : item.mismatch.llm;
      item.code_verified = chip.id === 'code';
      item.value_done = true;
      item.mismatch = null;
      return null;
    }
    case 'Q_TOKEN': {
      const chip = matchChip(q, answer);
      if (chip === null) return reaskPending(q, pending);
      item.token = chip.id === 'ETH' ? 'ETH' : 'USDC';
      return null;
    }
    case 'Q_UNTRUSTED_AMOUNT': {
      const chip = matchChip(q, answer);
      if (chip === null) return reaskPending(q, pending);
      if (chip.id === CHIPS.USE_AMOUNT.id) {
        item.confirmed = true;
        if (item.placeholder !== null) ctx.repos.db1.update(item.placeholder, { confirmed: true });
      } else {
        item.retype = true;
      }
      return null;
    }
    default:
      return reaskPending(q, pending);
  }
}
