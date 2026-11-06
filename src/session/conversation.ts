// SQ-CV-01: interpret conversational replies before applying a pending field validator.
// Only guarded user-typed text enters this prompt. No document values, question text, contact book or DB rows.
import { parseAmountText } from '../amounts/parse.js';
import { matchChip } from '../contracts/catalog.js';
import type { StepContext } from '../contracts/step.js';
import type { Question, QuestionCode } from '../contracts/types.js';
import { chronoSpans } from '../lexical/chrono.js';
import { ADDRESS_FULL_RE } from '../lexical/patterns.js';
import { fillSlots, loadPromptTemplate } from '../llm/prompt-builder/amounts.js';
import { normalizeEns } from '../recipients/ens.js';
import { compileEphemeral } from '../schemas/index.js';

export interface ConversationTurn {
  question: QuestionCode;
  reply: string;
}

export interface ConversationDecision {
  intent: 'answer' | 'recipient' | 'new_request' | 'clarify' | 'cancel';
  value: string | null;
}

const TEMPLATE = loadPromptTemplate('conversation.txt');
const CONVERSATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'value'],
  properties: {
    intent: { type: 'string', enum: ['answer', 'recipient', 'new_request', 'clarify', 'cancel'] },
    value: { type: ['string', 'null'], maxLength: 512 },
  },
};
const validate = compileEphemeral(CONVERSATION_SCHEMA);
const SELF = /^(?:i|me|my|mine|myself|my wallet|my address)$/i;
const CONVERSATIONAL =
  /\b(?:i|you|we|my|myself|your|want|need|have|should|could|would|please|actually|instead|change|replace|use|pay|send|transfer|set\s*up|create|cancel|stop|abort|explain|help|why|what|how|which|who|don't|dont|not|never)\b/i;

export function simpleRecipient(text: string): boolean {
  const t = text.trim();
  if (SELF.test(t) || CONVERSATIONAL.test(t) || /[?!]/.test(t)) return false;
  return (
    ADDRESS_FULL_RE.test(t) ||
    (t.includes('.') && !/\s/.test(t) && normalizeEns(t) !== null) ||
    (/^[\p{L}\p{M}\p{N} ._'’-]{1,64}$/u.test(t) && t.split(/\s+/).length <= 3)
  );
}

/** Literal values are already interpretable; conversational text needs the model, not a permissive regex. */
export function needsConversation(ctx: StepContext, q: Question, text: string): boolean {
  const t = text.trim();
  if (!t || matchChip(q, { kind: 'text', text: t }) !== null) return false;
  // Before the ENS test: "0.123456" also normalizes as an ENS name.
  if (q.input === 'number' && parseAmountText(t, null).ok) return false;
  // Questions whose literal answer is an address or ENS name (Q_GROUP_PARENT asks for the ENS parent).
  const recipientQuestion = ['Q_NO_PAYEE', 'Q_WHO_IS', 'Q_ADDRESS_REENTER', 'Q_GROUP_PARENT'].includes(q.code);
  if (ADDRESS_FULL_RE.test(t) || (t.includes('.') && !/\s/.test(t) && normalizeEns(t) !== null))
    return !recipientQuestion;
  if (q.input === 'date') {
    const dates = chronoSpans(t, ctx.now());
    if (dates.some((d) => d.start === 0 && d.end === t.length)) return false;
  }
  if ((q.code === 'Q_NO_PAYEE' || q.code === 'Q_NAME_FOR_ADDRESS') && simpleRecipient(t)) return false;
  if (['Q_WHO_IS', 'Q_ADDRESS_REENTER'].includes(q.code) && simpleRecipient(t)) return true;
  return CONVERSATIONAL.test(t) || /[?!]/.test(t) || t.split(/\s+/).length > 1;
}

const PURPOSE: Partial<Record<QuestionCode, string>> = {
  Q_NO_PAYEE: 'Identify the intended recipient, using a name, ENS name or wallet address.',
  Q_WHO_IS: 'Supply the wallet address or ENS for the pending unknown recipient, or explicitly change that recipient.',
  Q_ADDRESS_REENTER: 'Supply a replacement wallet address or ENS for the pending recipient.',
  Q_NAME_FOR_ADDRESS: 'Give a short label for the address the user already confirmed.',
  Q_AMOUNT_MISSING: 'Supply a positive payment amount and, if known, its currency.',
  Q_TOKEN: 'Choose USDC or ETH for the amount already supplied.',
  Q_AUTOPAY_FREQUENCY: 'Specify how often the repeating payment should run.',
  Q_AUTOPAY_START: 'Specify when the repeating payment should begin.',
  Q_AUTOPAY_END: 'Specify when the repeating payment should end.',
};

export async function interpretReply(
  ctx: StepContext,
  q: Question,
  text: string,
  turns: readonly ConversationTurn[],
): Promise<ConversationDecision> {
  // Refuse overlong conversational turns without truncating and then acting on a different meaning.
  if (text.length > 4000 || ctx.req.typed_text.length > 6000) return { intent: 'clarify', value: null };
  const recent: ConversationTurn[] = [];
  let size = 0;
  for (const turn of turns.slice(-6).reverse()) {
    if (size + turn.reply.length > 4000) break;
    recent.unshift(turn);
    size += turn.reply.length;
  }
  const context = {
    original_user_request: ctx.req.typed_text,
    action_kinds: ctx.req.actions ?? [],
    pending_question: { code: q.code, purpose: PURPOSE[q.code] ?? 'Answer the current field or ask for help.' },
    recent_user_replies: recent,
    older_replies_omitted: recent.length !== turns.length,
    latest_reply: text,
  };
  const out = await ctx.llm.call<ConversationDecision>({
    name: 'conversation',
    system: TEMPLATE.system,
    user: fillSlots(TEMPLATE.user, { context_json: JSON.stringify(context) }),
    schema: CONVERSATION_SCHEMA,
  });
  // Validate even injected clients; data cannot become executable instructions or model-authored values.
  if (!validate(out)) return { intent: 'clarify', value: null };
  if (out.intent === 'answer' || out.intent === 'recipient') {
    if (!out.value?.trim() || !text.includes(out.value)) return { intent: 'clarify', value: null };
    return { intent: out.intent, value: out.value.trim() };
  }
  return out.value === null ? out : { intent: 'clarify', value: null };
}

/** A recipient-only correction must not silently drop an amount, schedule, negation or another target. */
export function recipientOnlyReply(text: string, value: string): boolean {
  if (!simpleRecipient(value)) return false;
  const at = text.indexOf(value);
  if (at < 0 || text.indexOf(value, at + value.length) !== -1) return false;
  const rest = `${text.slice(0, at)} ${text.slice(at + value.length)}`.toLowerCase();
  const words = rest.replace(/[,.!]/g, ' ').trim().split(/\s+/).filter(Boolean);
  const allowed = new Set([
    'actually',
    'instead',
    'please',
    'pay',
    'send',
    'to',
    'use',
    'change',
    'replace',
    'the',
    'recipient',
    'payee',
    'with',
    'i',
    'want',
    'would',
    'like',
    'okay',
    'ok',
  ]);
  return words.every((word) => allowed.has(word));
}

/** Copy a value only when the remaining reply is harmless wording, never another financial instruction. */
export function answerOnlyReply(text: string, value: string): boolean {
  const at = text.indexOf(value);
  if (at < 0 || text.indexOf(value, at + value.length) !== -1) return false;
  const rest = `${text.slice(0, at)} ${text.slice(at + value.length)}`.toLowerCase();
  const words = rest
    .replace(/[,.!:]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const allowed = new Set([
    'please',
    'send',
    'pay',
    'it',
    'is',
    'its',
    'the',
    'amount',
    'address',
    'wallet',
    'her',
    'his',
    'their',
    'name',
    'recipient',
    'payee',
    'to',
    'use',
    'i',
    'mean',
    'that',
    'would',
    'be',
  ]);
  return words.every((word) => allowed.has(word));
}

/** Code-owned explanations avoid unconstrained generated claims about payments or wallet activity. */
export function replyGuidance(ctx: StepContext, q: Question): string {
  if ((ctx.req.actions ?? []).includes('l') && ['Q_NO_PAYEE', 'Q_WHO_IS', 'Q_AUTOPAY_PICK'].includes(q.code))
    return 'Cancelling an autopay returns its remaining funds to your wallet. I need to know whose repeating payment you want to stop.';
  switch (q.code) {
    case 'Q_WHO_IS':
    case 'Q_ADDRESS_REENTER':
      return 'I need a wallet address or ENS name for this recipient. To change the recipient, say “pay Riya instead”, using the name you want.';
    case 'Q_NO_PAYEE':
      return 'Tell me the recipient’s saved contact name, ENS name or wallet address. You can also give a new payment request.';
    case 'Q_TOKEN':
      return 'Choose the token to send: USDC or ETH. USD amounts use USDC in this app; it does not convert ETH using a dollar exchange rate.';
    case 'Q_AMOUNT_MISSING':
    case 'Q_AMOUNT_PRECISION':
    case 'Q_FIAT_OTHER':
      return 'Tell me the payment amount and token, for example “10 USDC”. For an autopay, this is the amount of each payment.';
    case 'Q_LIMIT_OVERRIDE':
    case 'Q_UNTRUSTED_AMOUNT':
    case 'Q_ADDRESS_CORRECT':
    case 'Q_ENS_CHANGED':
      return 'Please choose one of the displayed options to confirm that decision. You can also cancel or describe a new request.';
    default:
      return 'You can answer the question, ask for clarification, or describe a new request. Nothing will be sent without your final confirmation.';
  }
}
