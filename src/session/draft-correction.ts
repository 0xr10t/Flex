// SQ-CV-02: resolve a bounded edit against the current unsubmitted payment, never generic chat history.
// Code copies unchanged fields from validated draft rows; the complete revised request reruns S0–S11.
import { amountCurrencyKinds, parseAmountText } from '../amounts/parse.js';
import type { StepContext } from '../contracts/step.js';
import type { ChainConfig, ChainId, MessageInput, Token } from '../contracts/types.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls } from '../guard/urls.js';
import { simpleRecipient } from './conversation.js';

export interface PaymentDraft {
  amount: string;
  token: Token;
  recipient: string;
  chain_id: ChainId;
}

export type DraftEdit = { kind: 'edit'; draft: PaymentDraft } | { kind: 'clarify' } | { kind: 'new_request' };
const CLARIFY = { kind: 'clarify' } as const;
const NEW_REQUEST = { kind: 'new_request' } as const;
const SAME_AMOUNT = /^(?:the\s+)?same(?:\s+amount)?$/i;
const EDIT_CUE =
  /\b(?:instead|same|change|switch|replace|correction|rather\s+than|make\s+it|not)\b|^(?:no|actually|wait|sorry)[,\s]/i;
const NAME_INSTRUCTION =
  /\b(?:and|or|but|except|each|everyone|all|half|max|under|same|it|this|that|him|her|them|someone|anyone|on|via|every|after|before|if|unless|only|also|token|usdc|eth|usd)\b/i;

function chainFor(text: string, chains: readonly ChainConfig[]): ChainId | null {
  const normalized = text.trim().toLowerCase();
  const matches = chains.filter((chain) =>
    [chain.name, ...chain.aliases].some((alias) => alias.toLowerCase() === normalized),
  );
  return matches.length === 1 ? matches[0]!.chain_id : null;
}

function recipientValue(text: string): string | null {
  const value = text.trim();
  if (
    !simpleRecipient(value) ||
    NAME_INSTRUCTION.test(value) ||
    /^[\d\s.,+-]+$/.test(value) ||
    parseAmountText(value, null).ok
  )
    return null;
  return value;
}

function amountValue(text: string, fallback: Token): { amount: string; token: Token } | null {
  if (/\bmore\b/i.test(text)) return null;
  const kinds = [...amountCurrencyKinds(text)];
  if (kinds.length > 1 || kinds.includes('FIAT_OTHER')) return null;
  const kind = kinds[0];
  const token = kind === 'FIAT_USD' ? 'USDC' : (kind ?? fallback);
  if (token !== 'USDC' && token !== 'ETH') return null;
  const parsed = parseAmountText(text, token);
  return parsed.ok ? { amount: parsed.value, token } : null;
}

/** Whole-message grammar: no convenient substring may discard another instruction, target or condition. */
export function editPaymentDraft(original: PaymentDraft, text: string, chains: readonly ChainConfig[]): DraftEdit {
  if (!text.trim() || text.length > 4000) return CLARIFY;
  let body = text
    .trim()
    .replace(/[.!]+$/, '')
    .trim();
  body = body.replace(/^(?:(?:no|actually|please|okay|ok|wait|sorry)[,:]?\s+)+/i, '');
  body = body.replace(/(?:\s+(?:instead|please))+$/i, '').trim();
  const draft = { ...original };
  let changedChain = false;
  const chainSuffix = /\s+(?:on|via)\s+(.+)$/i.exec(body);
  if (chainSuffix) {
    const chain = chainFor(chainSuffix[1]!, chains);
    if (chain === null) return EDIT_CUE.test(text) || /^(?:send|pay|transfer)\b/i.test(body) ? CLARIFY : NEW_REQUEST;
    draft.chain_id = chain;
    changedChain = true;
    body = body.slice(0, chainSuffix.index).trim();
  }

  const network = /^(?:(?:change|switch)(?:\s+the)?\s+(?:network|chain)\s+to|(?:use|on|via))\s+(.+)$/i.exec(body);
  if (network) {
    const chain = chainFor(network[1]!, chains);
    if (chain !== null) return { kind: 'edit', draft: { ...draft, chain_id: chain } };
  }

  const token = /^(?:(?:change|switch)(?:\s+the)?\s+(?:token|currency)\s+to|use)\s+(USDC|USD|ETH)$/i.exec(body);
  if (token) {
    const value: Token = token[1]!.toUpperCase() === 'ETH' ? 'ETH' : 'USDC';
    if (!parseAmountText(draft.amount, value).ok) return CLARIFY;
    return { kind: 'edit', draft: { ...draft, token: value } };
  }

  const recipient =
    /^(?:(?:change|switch|replace)(?:\s+the)?\s+(?:recipient|payee)\s+(?:to|with)|send\s+(?:it|that|this)\s+to|(?:pay|send|transfer)\s+to|use)\s+(.+)$/i.exec(
      body,
    );
  if (recipient) {
    const value = recipientValue(recipient[1]!);
    return value === null ? CLARIFY : { kind: 'edit', draft: { ...draft, recipient: value } };
  }

  const command = /^(?:send|pay|transfer|make(?:\s+it)?|(?:change|set)(?:\s+the)?\s+amount\s+to)\s+(.+)$/i.exec(body);
  if (command) body = command[1]!.trim();
  else if (!amountValue(body, draft.token)) return EDIT_CUE.test(text) ? CLARIFY : NEW_REQUEST;

  const target = /\s+to\s+(.+)$/i.exec(body);
  if (target) {
    const value = recipientValue(target[1]!);
    if (value === null) return CLARIFY;
    draft.recipient = value;
    body = body.slice(0, target.index).trim();
  }

  if (SAME_AMOUNT.test(body)) {
    return target || changedChain ? { kind: 'edit', draft } : CLARIFY;
  }
  const comparison = /^(.+?)(?:,\s*|\s+)(?:not|instead\s+of|rather\s+than)\s+(.+)$/i.exec(body);
  if (comparison) {
    const desired = amountValue(comparison[1]!, draft.token);
    const excluded = amountValue(comparison[2]!, draft.token);
    if (!desired || !excluded || desired.token !== excluded.token || desired.amount === excluded.amount) return CLARIFY;
    return { kind: 'edit', draft: { ...draft, ...desired } };
  }
  const amount = amountValue(body, draft.token);
  if (amount) return { kind: 'edit', draft: { ...draft, ...amount } };
  // "pay Riya instead" is recipient-only; "send it" or a compound command must not become a name.
  if (command && /^pay\s/i.test(text.trim().replace(/^(?:(?:no|actually|please|okay|ok|wait|sorry)[,:]?\s+)+/i, ''))) {
    const value = target ? null : recipientValue(body);
    if (value !== null) return { kind: 'edit', draft: { ...draft, recipient: value } };
  }
  return command || EDIT_CUE.test(text) ? CLARIFY : NEW_REQUEST;
}

/** Only a single trusted, absolute, unsubmitted payment can supply omitted fields automatically. */
export function currentPaymentDraft(ctx: StepContext): PaymentDraft | null {
  const { req, repos } = ctx;
  if (
    req.state !== 'AWAITING_CONFIRMATION' ||
    req.handoff_attempts !== 0 ||
    repos.handoffs.get(req.request_id) ||
    req.untrusted.length !== 0 ||
    req.payments?.length !== 1 ||
    req.recipients.length !== 1 ||
    req.resolved.length !== 1
  )
    return null;
  const payment = req.payments[0]!;
  const actions = req.plan?.filter((intent) => intent.intent_id !== 'j');
  const planned = actions?.[0];
  if (payment.kind !== 'i' || payment.amount === null || actions?.length !== 1 || planned?.intent_id !== 'i')
    return null;
  const amount = repos.db1.get(payment.amount);
  const source = req.amounts.find((item) => item.placeholder === payment.amount);
  const recipient = repos.db3.get(payment.recipient);
  if (
    !amount?.confirmed ||
    amount.source !== 'user' ||
    amount.session_id !== req.session_id ||
    source?.relative !== null ||
    !recipient ||
    recipient.kind !== 'single' ||
    recipient.address === null ||
    recipient.source === 'untrusted' ||
    recipient.session_id !== req.session_id ||
    planned.amount !== payment.amount ||
    planned.recipient !== payment.recipient ||
    !parseAmountText(amount.amount, amount.token).ok
  )
    return null;
  return {
    amount: amount.amount,
    token: amount.token,
    recipient: recipient.ens_name ?? recipient.address,
    chain_id: planned.chain_id,
  };
}

export type DraftCorrection = { kind: 'replace'; input: MessageInput } | { kind: 'clarify'; message: string };

/** No model-authored rewrite, inferred consent, contact mutation or transaction submission happens here. */
export function prepareDraftCorrection(ctx: StepContext, input: MessageInput): DraftCorrection | null {
  if (
    input.attachments.length ||
    input.pasted_blocks.length ||
    input.urls.length ||
    detectSecret(input.text) !== null ||
    extractUrls(input.text, []).links.length
  )
    return null;
  // Explanations about a draft are still read-only chat, even when they mention changes or negation.
  if (/^(?:what|why|how|who|where|when|which|explain|tell me|(?:can|could) you explain)\b/i.test(input.text.trim()))
    return null;
  const current = currentPaymentDraft(ctx);
  if (!current) {
    return EDIT_CUE.test(input.text)
      ? {
          kind: 'clarify',
          message:
            'Your draft is still open. Please give the full updated request for a group, recurring or multi-payment change.',
        }
      : null;
  }
  const edit = editPaymentDraft(current, input.text, ctx.config.chains);
  if (edit.kind === 'new_request') return null;
  if (edit.kind === 'clarify')
    return {
      kind: 'clarify',
      message:
        'Your draft is still open. Tell me the new amount, recipient, token or network. For a different kind of payment, cancel this draft and start a new request.',
    };
  const chain = ctx.config.chains.find((item) => item.chain_id === edit.draft.chain_id);
  if (!chain) return null;
  const { amount, token, recipient } = edit.draft;
  return {
    kind: 'replace',
    input: {
      text: `send ${amount} ${token.toLowerCase()} to ${recipient} on ${chain.name}`,
      pasted_blocks: [],
      attachments: [],
      urls: [],
    },
  };
}
