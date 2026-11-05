// Implements: §8.10 LLM #4 "Pair payments (S8)" prompt builder (fixed text, `{…}` slots filled by code, nothing
// else added), §8.9 per-request schema slot values (kind / amount / recipient / chain enums, maxItems formula),
// §12.2 template (filled through src/schemas buildPaymentsSchema), §16.1 (content values only as placeholders).
// SQ-21 (Orchestrator ruling): the `// …` remarks after the USER slots in §8.10 are spec annotations and are not
// part of the prompt; `{correction_line}` is `CORRECTION: <problems>` on the retry only, else the line is omitted.

import { readFileSync } from 'node:fs';
import type { BuiltPrompt } from '../../contracts/llm.js';
import type { ActionKind, AddressPh, AmountPh, ChainId, GroupPh, RecipientPh, Token } from '../../contracts/types.js';
import { buildPaymentsSchema } from '../../schemas/index.js';

/** The §8.10 LLM #4 block as stored in src/llm/prompts/payments.txt ("SYSTEM" … "USER" … slots). */
export const PAYMENTS_PROMPT_TEMPLATE: string = readFileSync(
  new URL('../prompts/payments.txt', import.meta.url),
  'utf8',
)
  .replace(/\r\n/g, '\n')
  .replace(/\n$/, '');

export interface PaymentsAmount {
  placeholder: AmountPh;
  token: Token;
  from_attached_content: boolean;
}
export interface PaymentsRecipient {
  placeholder: AddressPh | GroupPh;
  type: 'person' | 'group';
}
/** A pair as listed in the attached content, expressed only through placeholders (§16.1). */
export interface PaymentsDocItem {
  amount: AmountPh | null;
  recipient: AddressPh | null;
}
export interface PaymentsSessionItem {
  placeholder: AddressPh;
  last_chain_id: ChainId | null;
}
export interface PaymentsChain {
  word: string;
  chain_id: ChainId;
}

export interface PaymentsPromptInput {
  masked_text_s8: string;
  amounts: PaymentsAmount[];
  recipients: PaymentsRecipient[];
  doc_items: PaymentsDocItem[] | 'none';
  chains: PaymentsChain[];
  actions: ActionKind[];
  session: PaymentsSessionItem[] | 'none';
  /** Plain-words list of problems for the retry (§8.9); absent on the first call. */
  correction?: string;
}

/** §8.9: maxItems = min(50, A × R + R), A = amount placeholders, R = recipient placeholders. */
export function paymentsMaxItems(a: number, r: number): number {
  return Math.min(50, a * r + r);
}

function splitTemplate(): { system: string; user: string } {
  const lines = PAYMENTS_PROMPT_TEMPLATE.split('\n');
  const s = lines.indexOf('SYSTEM');
  const u = lines.indexOf('USER');
  if (s !== 0 || u < 0) throw new Error('payments prompt template malformed');
  return { system: lines.slice(s + 1, u).join('\n'), user: lines.slice(u + 1).join('\n') };
}

const SLOT_RE = /\{([a-z0-9_]+)\}/g;

/** Fills every `{slot}`; an unknown slot is a bug. Values are inserted as-is (no re-scanning of inserted text). */
function fillSlots(template: string, values: Record<string, string>): string {
  return template.replace(SLOT_RE, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) throw new Error(`payments prompt: missing slot ${name}`);
    return v;
  });
}

function uniqueChains(chains: PaymentsChain[]): ChainId[] {
  const out: ChainId[] = [];
  for (const c of chains) if (!out.includes(c.chain_id)) out.push(c.chain_id);
  return out;
}

/** §8.10 LLM #4: returns `{ system, user, schema }` for this request. */
export function buildPaymentsPrompt(input: PaymentsPromptInput): BuiltPrompt {
  const { system, user } = splitTemplate();
  const session = input.session === 'none' ? [] : input.session;
  const values: Record<string, string> = {
    masked_text_s8: input.masked_text_s8,
    amounts_json: JSON.stringify(input.amounts),
    recipients_json: JSON.stringify(input.recipients),
    doc_items_json: input.doc_items === 'none' ? 'none' : JSON.stringify(input.doc_items),
    chains_json: JSON.stringify(input.chains),
    actions_json: JSON.stringify(input.actions),
    session_json: input.session === 'none' ? 'none' : JSON.stringify(input.session),
    correction_line: input.correction !== undefined ? `CORRECTION: ${input.correction}` : '',
  };
  let userTemplate = user;
  if (input.correction === undefined) {
    // First call: the `{correction_line}` line is omitted entirely (SQ-21).
    userTemplate = user
      .split('\n')
      .filter((l) => l !== '{correction_line}')
      .join('\n');
  }
  const recipients: RecipientPh[] = [
    ...input.recipients.map((r) => r.placeholder),
    ...session.map((s) => s.placeholder),
  ];
  const schema = buildPaymentsSchema({
    maxItems: paymentsMaxItems(input.amounts.length, recipients.length),
    kinds: [...input.actions],
    amounts: input.amounts.map((a) => a.placeholder),
    recipients,
    chains: uniqueChains(input.chains),
  });
  return { system, user: fillSlots(userTemplate, values), schema };
}
