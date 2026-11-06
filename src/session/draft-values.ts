// Exact values stay in a turn-local registry. The interpreter sees references and structural metadata only.
import { parseAmountText } from '../amounts/parse.js';
import type { StepContext } from '../contracts/step.js';
import type { ChainId, Token } from '../contracts/types.js';
import { NUMBER_WORD_RUN_RE, PLACEHOLDER_TOKEN_RE } from '../lexical/patterns.js';
import { lexicalScan } from '../lexical/scan.js';
import { findUnused, isIdentifierAt, overlapsAny, replaceRanges, wordRe, type Range } from '../lexical/text.js';
import { fillSlots, loadPromptTemplate } from '../llm/prompt-builder/amounts.js';
import { compileEphemeral } from '../schemas/index.js';
import { newId, newPlaceholder } from '../util/ids.js';
import { simpleRecipient } from './conversation.js';
import type { PaymentDraft } from './draft-correction.js';

interface Value {
  placeholder: string;
  value: string;
  valid: boolean;
  explicit_token?: Token;
}
export interface DraftValues {
  session_id: string;
  draft_revision: string;
  turn_id: string;
  masked: string;
  amounts: Value[];
  recipients: Value[];
  tokens: Token[];
  chains: ChainId[];
  complex: boolean;
}

const TEMPLATE = loadPromptTemplate('draft-values.txt');
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recipients'],
  properties: {
    recipients: {
      type: 'array',
      maxItems: 8,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
};
const validate = compileEphemeral(SCHEMA);

/** No DB rows are minted or mutated until the proposed edit enters the normal validated request pipeline. */
export async function collectDraftValues(
  ctx: StepContext,
  current: PaymentDraft,
  text: string,
): Promise<DraftValues | null> {
  if (!text.trim() || text.length > 4000 || new RegExp(PLACEHOLDER_TOKEN_RE).test(text)) return null;
  const result = lexicalScan(text, { chains: ctx.config.chains, now: ctx.now() });
  if (!result.ok) return null;
  const scan = result.scan;
  const payment = ctx.req.payments?.[0];
  if (!payment?.amount) return null;
  const amounts: Value[] = [
    { placeholder: payment.amount, value: current.amount, valid: true, explicit_token: current.token },
  ];
  const recipients: Value[] = [{ placeholder: payment.recipient, value: current.recipient, valid: true }];
  const used = new Set<string>([payment.amount, payment.recipient]);
  const replacements: Array<Range & { with: string }> = [];
  const protectedRanges: Range[] = [...scan.chains, ...scan.tokens, ...scan.dates, ...scan.groups];
  const unique = (kind: 'amount' | 'address'): string => {
    let ref = newPlaceholder(kind);
    while (used.has(ref)) ref = newPlaceholder(kind);
    used.add(ref);
    return ref;
  };
  const register = (kind: 'amount' | 'address', r: Range, value: string, valid: boolean, token?: Token): void => {
    if (overlapsAny(r, replacements)) return;
    const list = kind === 'amount' ? amounts : recipients;
    let entry = list.find(
      (v) => v.value === value && v.valid === valid && (kind !== 'amount' || v.explicit_token === token),
    );
    // Unqualified mentions of the current amount use its existing DB1 reference.
    if (kind === 'amount' && token === undefined && valid && value === current.amount) entry = amounts[0];
    if (!entry) {
      entry = { placeholder: unique(kind), value, valid, ...(token === undefined ? {} : { explicit_token: token }) };
      list.push(entry);
    }
    replacements.push({ ...r, with: entry.placeholder });
  };

  for (const value of [...scan.addresses, ...scan.ens]) register('address', value, value.text, true);
  // Match only contacts actually typed; the contact book and resolved addresses never enter either prompt.
  const currentName = ctx.repos.db3.get(payment.recipient);
  const names = [
    ...new Set([
      ...ctx.repos.db2.listAll().map((r) => r.name),
      ...(currentName?.kind === 'single' ? [currentName.name] : []),
    ]),
  ].filter((name): name is string => typeof name === 'string' && name.length > 0);
  if (names.length) {
    for (const m of text.matchAll(wordRe(names))) {
      const range = { start: m.index, end: m.index + m[0].length };
      if (!isIdentifierAt(text, range) || overlapsAny(range, protectedRanges)) continue;
      const isCurrent = currentName?.kind === 'single' && m[0].toLowerCase() === currentName.name?.toLowerCase();
      register('address', range, isCurrent ? current.recipient : m[0], true);
    }
  }

  const numbers: Range[] = [...scan.numeric_candidates];
  for (const m of text.matchAll(NUMBER_WORD_RUN_RE)) numbers.push({ start: m.index, end: m.index + m[0].length });
  for (const candidate of numbers.sort((a, b) => a.start - b.start)) {
    if (overlapsAny(candidate, [...protectedRanges, ...replacements])) continue;
    // Include a leading decimal point or sign; never turn a negative value into a positive candidate.
    let start = candidate.start;
    if (text[start - 1] === '.') start--;
    const sign = /[+\-−]\s*$/.exec(text.slice(0, start));
    if (sign) start = sign.index;
    const r = { start, end: candidate.end };
    const raw = text.slice(r.start, r.end);
    const parsed = parseAmountText(raw, null);
    // A lexical match must not salvage a valid prefix of an unsupported literal (1e-3, 1.2.3, 2–4).
    const joined =
      /[\p{L}\p{M}\p{N}_]/u.test(text[r.start - 1] ?? '') || /^[\p{L}\p{M}\p{N}_]|^[.\-–−]\d/u.test(text.slice(r.end));
    const adjacent = scan.tokens.filter(
      (t) =>
        (t.end <= r.start && text.slice(t.end, r.start).trim() === '') ||
        (t.start >= r.end && text.slice(r.end, t.start).trim() === ''),
    );
    const kinds = [...new Set(adjacent.map((t) => (t.kind === 'FIAT_USD' ? 'USDC' : t.kind)))];
    const token = kinds.length === 1 && (kinds[0] === 'ETH' || kinds[0] === 'USDC') ? kinds[0] : undefined;
    register(
      'amount',
      r,
      parsed.ok ? parsed.value : raw,
      parsed.ok && !joined && kinds.length <= 1 && !kinds.includes('FIAT_OTHER'),
      token,
    );
  }
  if (amounts.length + recipients.length > 24) return null;
  const masked = replaceRanges(text, replacements);
  const extracted = await ctx.llm.call<{ recipients: string[] }>({
    name: 'draft_values',
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { message_json: JSON.stringify(masked) }),
    schema: SCHEMA,
    think: false,
  });
  if (!validate(extracted)) return null;
  for (const name of extracted.recipients) {
    if (!simpleRecipient(name) || new RegExp(PLACEHOLDER_TOKEN_RE).test(name) || parseAmountText(name, null).ok)
      return null;
    // Resolve an exact original span, not a model-authored substitute or a substring of another identifier.
    const range = findUnused(text, name, [...replacements, ...protectedRanges], 'identifier');
    if (!range) return null;
    register('address', range, text.slice(range.start, range.end), true);
    for (
      let next = findUnused(text, name, [...replacements, ...protectedRanges], 'identifier');
      next;
      next = findUnused(text, name, [...replacements, ...protectedRanges], 'identifier')
    )
      register('address', next, name, true);
  }
  if (amounts.length + recipients.length > 24) return null;
  return {
    session_id: ctx.req.session_id,
    draft_revision: ctx.req.request_id,
    turn_id: newId('question'),
    masked: replaceRanges(text, replacements),
    amounts,
    recipients,
    tokens: [
      ...new Set<Token>([
        current.token,
        ...scan.tokens.flatMap((t) =>
          t.kind === 'ETH' ? ['ETH' as const] : t.kind === 'USDC' || t.kind === 'FIAT_USD' ? ['USDC' as const] : [],
        ),
      ]),
    ],
    chains: [...new Set([current.chain_id, ...scan.chains.map((c) => c.chain_id)])],
    complex:
      [...scan.groups, ...scan.dates, ...scan.recurrence, ...scan.distributive, ...scan.split].length > 0 ||
      scan.tokens.some((t) => t.kind === 'FIAT_OTHER'),
  };
}
