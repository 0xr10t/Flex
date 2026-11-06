// Implements: SQ-S-01 (human, 2026-11-06), extending §17.2 to a fresh amount correction after an insufficient-funds
// failure. Only one resolved, trusted, unsubmitted one-time payment is eligible. Context is in memory, never DB8
// history; §8.4 verifies the new amount, §8.6/§8.8 reuse its recipient placeholder, §10 replans, §17.3 requires yes.
// SQ-S-02: S2's ordinary back-references also select this context, including requests with explanatory prose.
// S5 still checks for one new payment and no explicit/ambiguous payee before it reuses the recipient.

import { parseAmountText } from '../amounts/parse.js';
import type { Repos } from '../contracts/repos.js';
import { FIAT_OTHER_WORDS, FIAT_USD_WORDS, TOKENS } from '../contracts/static-tables.js';
import type { AgentRequest, ChainConfig, FailedPaymentContext, MessageInput } from '../contracts/types.js';
import { escapeRe } from '../lexical/text.js';

const CURRENCIES = [
  ...Object.values(TOKENS).flatMap((token) => token.aliases),
  ...FIAT_USD_WORDS,
  ...FIAT_OTHER_WORDS,
].sort((a, b) => b.length - a.length);
const CURRENCY_RE = new RegExp(
  CURRENCIES.map((currency) =>
    /^[a-z]+$/i.test(currency) ? `(?<![a-z])${escapeRe(currency)}(?![a-z0-9])` : escapeRe(currency),
  ).join('|'),
  'gi',
);

/** Called only for FAILED / INSUFFICIENT_FUNDS. Never retain a possibly submitted or unresolved payment. */
export function failedPaymentContext(req: AgentRequest, repos: Repos): FailedPaymentContext | undefined {
  if (
    req.state !== 'FAILED' ||
    req.handoff_attempts !== 0 ||
    repos.handoffs.get(req.request_id) !== undefined ||
    req.untrusted.length !== 0 ||
    req.payments?.length !== 1 ||
    req.recipients.length !== 1 ||
    req.amounts.length !== 1 ||
    req.resolved.length !== 1
  )
    return undefined;
  const payment = req.payments[0];
  const ref = req.recipients[0];
  const resolved = req.resolved[0];
  const amount = req.amounts[0];
  if (
    !payment ||
    payment.kind !== 'i' ||
    payment.amount === null ||
    !ref ||
    ref.type !== 'person' ||
    ref.placeholder !== payment.recipient ||
    !resolved ||
    resolved.kind !== 'single' ||
    !amount ||
    amount.placeholder !== payment.amount ||
    amount.source !== 'user' ||
    amount.origin !== 'phrase' ||
    !amount.confirmed ||
    amount.relative !== null
  )
    return undefined;
  const recipient = repos.db3.get(payment.recipient);
  const storedAmount = repos.db1.get(payment.amount);
  if (
    !recipient ||
    recipient.kind !== 'single' ||
    recipient.address === null ||
    recipient.source === 'untrusted' ||
    recipient.session_id !== req.session_id ||
    !recipient.placeholder.startsWith('address_') ||
    !storedAmount ||
    storedAmount.source !== 'user' ||
    !storedAmount.confirmed ||
    storedAmount.session_id !== req.session_id ||
    storedAmount.token !== payment.token
  )
    return undefined;
  const planned = req.plan?.find((intent) => intent.intent_id === 'i' && intent.recipients.some((p) => p.recipient === payment.recipient));
  return {
    request_id: req.request_id,
    recipient: recipient.placeholder as FailedPaymentContext['recipient'],
    token: storedAmount.token,
    ens_chain_ids: [...resolved.ens_chain_ids],
    // An explicit chain (or a previous follow-up/pin) survives a failure before S9 can finish building the plan.
    chain_id:
      planned?.intent_id === 'i'
        ? planned.chain_id
        : payment.chain !== 'unstated'
          ? payment.chain
          : (ref.last_chain_id ?? recipient.chain_id),
  };
}

/**
 * A deliberately closed grammar: acknowledgements + a payment verb + one exact amount, optional token/chain.
 * Unknown words (including any new payee), multiple amounts, recurring payments and attached content cannot inherit
 * context. This only decides whether defaults are available; S0–S11 still process the unchanged user text normally.
 */
export function isAmountCorrection(input: MessageInput, chains: readonly ChainConfig[]): boolean {
  if (input.pasted_blocks.length > 0 || input.attachments.length > 0 || input.urls.length > 0) return false;
  let text = input.text
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
  text = text.replace(/^(?:(?:ok(?:ay)?|alright|no worries|no problem|actually|then|well|please)[,.!]?\s+)+/i, '');
  const command = /^(?:send|pay|transfer)\s+(?:just\s+)?(.+)$/i.exec(text);
  if (!command?.[1]) return false;
  text = command[1].replace(/(?:\s+(?:instead|please|then))+$/i, '').trim();
  const aliases = [...new Set(chains.flatMap((chain) => [chain.name, ...chain.aliases]))]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe);
  text = text.replace(new RegExp(`\\s+(?:on|via)\\s+(?:${aliases.join('|')})$`, 'i'), '').trim();
  text = text.replace(/(?:\s+(?:instead|please|then))+$/i, '').trim();
  // The amount parser strips currency labels anywhere. A correction must instead name at most one currency,
  // before or after its amount: conflicting tokens must go through ordinary clarification without a prior payee.
  const currencies = [...text.matchAll(CURRENCY_RE)];
  if (currencies.length > 1) return false;
  const currency = currencies[0];
  if (currency !== undefined && currency.index !== 0 && currency.index + currency[0].length !== text.length) {
    return false;
  }
  return parseAmountText(text, null).ok;
}

/** §17.2 / SQ-S-02: interpret a failed request as the nearest context, using S2's existing reference detection. */
export function selectFailedPaymentContext(req: AgentRequest, chains: readonly ChainConfig[]): void {
  const previous = req.failed_payment_candidate;
  delete req.failed_payment_candidate;
  if (previous === undefined) return;
  const { scan } = req;
  const kinds = new Set(scan.tokens.map((token) => (token.kind === 'FIAT_USD' ? 'USDC' : token.kind)));
  const backReference =
    scan.back_reference.length > 0 &&
    scan.recurrence.length === 0 &&
    scan.cancel.length === 0 &&
    scan.distributive.length === 0 &&
    scan.split.length === 0 &&
    kinds.size <= 1;
  if (
    backReference ||
    isAmountCorrection({ text: req.typed_text, pasted_blocks: [], attachments: [], urls: [] }, chains)
  ) {
    req.retry_context = previous;
  }
}
