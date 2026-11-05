// Implements: §8.2 step 5 Q-LLM extraction — one call per content item (prompt §8.10, schema §12.1); invalid →
// retry once (inside the LlmClient); still invalid → the item yields nothing. Each extracted entry becomes a
// QItem { item_index, address|null, ens_name|null, amount|null, token|null }; addresses failing the regex/checksum
// and amounts failing ^\d+(\.\d+)?$ are set to null; entries with all fields null are dropped.
// §3.2 / §16.1: the Q-LLM sees only the content item, never the user's prompt; its output is typed fields.
// Owner: Lane B.

import { getAddress, isAddress } from 'viem';
import { LlmFailed, type LlmClient } from '../contracts/llm.js';
import type { Address, QItem, Token } from '../contracts/types.js';
import { buildQuarantinePrompt } from '../llm/prompt-builder/quarantine.js';

interface QOutput {
  items: Array<{ address: string | null; ens_name: string | null; amount: string | null; token: Token | null }>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

/** §8.2 step 5 field rules. Mixed-case addresses must carry a valid EIP-55 checksum; all-lower/upper are accepted. */
export function toQItem(item_index: number, e: QOutput['items'][number]): QItem | null {
  let address: Address | null = null;
  if (typeof e.address === 'string' && ADDRESS_RE.test(e.address)) {
    const lower = e.address.slice(2) === e.address.slice(2).toLowerCase();
    const upper = e.address.slice(2) === e.address.slice(2).toUpperCase();
    if (lower || upper) address = getAddress(e.address.toLowerCase());
    else if (isAddress(e.address, { strict: true })) address = getAddress(e.address);
  }
  const ens_name = typeof e.ens_name === 'string' && e.ens_name.trim().length > 0 ? e.ens_name.trim() : null;
  const amount = typeof e.amount === 'string' && AMOUNT_RE.test(e.amount) ? e.amount : null;
  const token = e.token === 'USDC' || e.token === 'ETH' ? e.token : null;
  if (address === null && ens_name === null && amount === null && token === null) return null;
  return { item_index, address, ens_name, amount, token };
}

/** Returns the QItems of one content item, or null when the Q-LLM failed twice (the item yields nothing). */
export async function extractUntrusted(
  llm: LlmClient,
  content_text: string,
  item_index: number,
): Promise<QItem[] | null> {
  const p = buildQuarantinePrompt(content_text);
  let out: QOutput;
  try {
    out = await llm.call<QOutput>({ name: 'quarantine', system: p.system, user: p.user, schema: p.schema });
  } catch (e) {
    if (e instanceof LlmFailed) return null;
    throw e;
  }
  const items: QItem[] = [];
  for (const e of out.items) {
    const q = toQItem(item_index, e);
    if (q !== null) items.push(q);
  }
  return items;
}
