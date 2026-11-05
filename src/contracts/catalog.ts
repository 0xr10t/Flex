// Implements: §13.4 question texts + fixed chips, §15 error messages, §13.1 notes, §13.3 fixed replies,
// re-ask / variant wordings quoted in §8.4, §9.1–§9.6. Verbatim from the spec.
// Owned by the Orchestrator (frozen contract). No lane writes user-facing text inline; use these.
// Items marked SQ-nn have an open entry in SPEC_QUESTIONS.md.

import type { Answer, Chip, ErrorCode, QuestionCode, QuestionId, QuestionInput, Question } from './types.js';

type P = Record<string, string>;

function req(p: P, key: string): string {
  const v = p[key];
  if (v === undefined) throw new Error(`catalog: missing param ${key}`);
  return v;
}

// ───────────────────────────── §13.4 question texts ─────────────────────────────

/** Default text per code. Variants below. Params named after the spec's `{…}` slots. */
export const QUESTION_TEXT: Record<QuestionCode, (p: P) => string> = {
  // "How much should I send{ to Name}?" — `name` optional.
  Q_AMOUNT_MISSING: (p) => `How much should I send${p.name !== undefined ? ` to ${p.name}` : ''}?`,
  Q_AMOUNT_MISMATCH: (p) => `Did you mean ${req(p, 'a')} or ${req(p, 'b')}?`,
  Q_AMOUNT_UNCOVERED: (p) => `Should ${req(p, 'n')} be paid?`,
  Q_AMOUNT_PRECISION: (p) => `${req(p, 'token')} supports up to ${req(p, 'd')} decimal places. How much exactly?`,
  Q_TOKEN: (p) => `Is ${req(p, 'amount')} in USDC or ETH?`,
  // `{USDC or ETH}` is the literal "USDC or ETH" unless the token is known (then pass it).
  Q_FIAT_OTHER: (p) => `I can't convert ${req(p, 'phrase')}. How much in ${p.token ?? 'USDC or ETH'}?`,
  Q_UNTRUSTED_AMOUNT: (p) => `The attached content says ${req(p, 'amount')} ${req(p, 'token')}. Use this amount?`,
  Q_RECURRING: () => 'Should this payment repeat?',
  Q_NO_PAYEE: () => 'Who should receive this?',
  Q_FOLLOWUP_WHO: (p) => `Who should get this: ${req(p, 'names')}?`,
  Q_WHO_IS: (p) => `Who is "${req(p, 'name')}"?`,
  Q_ADDRESS_CORRECT: (p) => `Is ${req(p, 'addr')} correct?`,
  // "Paste the address{ for name}." — `name` optional.
  Q_ADDRESS_REENTER: (p) => `Paste the address${p.name !== undefined ? ` for ${p.name}` : ''}.`,
  Q_NAME_FOR_ADDRESS: () => 'Save this address as?',
  Q_ENS_CHAIN: (p) => `${req(p, 'ens')} has different addresses on different chains. Which one?`,
  Q_ENS_CHANGED: (p) =>
    `${req(p, 'ens')} now points to ${req(p, 'new')} (saved: ${req(p, 'old')}). Use the new address?`,
  Q_GROUP_PARENT: () => "Which ENS name's members should I pay?",
  Q_GROUP_CHAIN: () => 'Which chain should the group be paid on?',
  // SQ-05: the spec says the text also shows the total when the amount is known, but gives no wording.
  Q_GROUP_MEMBERS: (p) => `Pay these ${req(p, 'n')} members of ${req(p, 'parent')}? Untick anyone to leave out.`,
  Q_GROUP_OVER_LIMIT: (p) =>
    `This sends ${req(p, 'total')} ${req(p, 'token')}, but only ${req(p, 'remaining')} is left of today's ${req(p, 'daily_max')} limit. Go ahead this once?`,
  Q_AUTOPAY_FREQUENCY: () => 'How often should this repeat?',
  Q_AUTOPAY_START: () => 'When should this start?',
  Q_AUTOPAY_END: () => 'When should these payments stop?',
  Q_AUTOPAY_COUNT: () => 'How many payments?',
  Q_AUTOPAY_DATE: () => 'Pay until which date?',
  Q_AUTOPAY_PICK: () => 'Which repeating payment should I stop?',
};

/** Default input kind per code (§13.4 "Input / chips" column). */
export const QUESTION_INPUT: Record<QuestionCode, QuestionInput> = {
  Q_AMOUNT_MISSING: 'number',
  Q_AMOUNT_MISMATCH: 'chips',
  Q_AMOUNT_UNCOVERED: 'chips',
  Q_AMOUNT_PRECISION: 'number',
  Q_TOKEN: 'chips',
  Q_FIAT_OTHER: 'number',
  Q_UNTRUSTED_AMOUNT: 'chips',
  Q_RECURRING: 'chips',
  Q_NO_PAYEE: 'text',
  Q_FOLLOWUP_WHO: 'chips',
  Q_WHO_IS: 'chips',
  Q_ADDRESS_CORRECT: 'chips',
  Q_ADDRESS_REENTER: 'address',
  Q_NAME_FOR_ADDRESS: 'text',
  Q_ENS_CHAIN: 'chips',
  Q_ENS_CHANGED: 'chips',
  Q_GROUP_PARENT: 'text',
  Q_GROUP_CHAIN: 'chips',
  Q_GROUP_MEMBERS: 'multiselect',
  Q_GROUP_OVER_LIMIT: 'chips',
  Q_AUTOPAY_FREQUENCY: 'chips',
  Q_AUTOPAY_START: 'date',
  Q_AUTOPAY_END: 'chips',
  Q_AUTOPAY_COUNT: 'number',
  Q_AUTOPAY_DATE: 'date',
  Q_AUTOPAY_PICK: 'chips',
};

/** Variant wordings quoted in §8.4 / §9. */
export const QUESTION_VARIANT = {
  /** §9.3 step 1: ENS normalize failure → Q_WHO_IS. */
  WHO_IS_INVALID_ENS: () => "That isn't a valid ENS name. Who is it?",
  /** §9.3 step 4: ENS has no address on any queried chain → Q_ADDRESS_REENTER. */
  REENTER_ENS_NO_ADDRESS: (p: P) => `${req(p, 'ens')} has no address for these chains. Paste an address instead?`,
  /** §9.3 step 7: Q_ADDRESS_CORRECT for an ENS-resolved address. SQ-06: `chains` join format when several match. */
  ADDRESS_CORRECT_ENS: (p: P) => `${req(p, 'ens')} → ${req(p, 'addr')} on ${req(p, 'chains')}. Correct?`,
  /** §9.2 step 5: suffix for untrusted addresses (appended after a space). */
  ADDRESS_CORRECT_UNTRUSTED_SUFFIX: () => 'This address comes from the attached content, not from you.',
  /** §9.4 "No address now" variant of Q_ENS_CHANGED. */
  ENS_CHANGED_NO_ADDRESS: (p: P) => `${req(p, 'ens')} no longer has an address. Keep the saved one?`,
  /** §9.6 step 4: parent unknown to ENS → Q_GROUP_PARENT. */
  GROUP_PARENT_NOT_IN_ENS: (p: P) => `${req(p, 'parent')} isn't in ENS. Which .eth name should I use instead?`,
} as const;

/**
 * Re-ask hints quoted in the spec for answers that fail validation. SQ-04: the spec does not say how a hint
 * combines with the question; contracts-v1 uses `withHint` (hint, one space, the question text).
 */
export const REASK_HINT = {
  /** §9.2 step 1 */
  CHECKSUM_TYPO: () => "That address has a typo: its checksum doesn't match.",
  /** §9.2 step 2 */
  ZERO_ADDRESS: () => "That's not a usable address.",
  /** §9.2 step 6 */
  NAME_TAKEN: () => 'That name is already saved for another address. Pick another name.',
  /** §8.4 step 3 "Zero → Q_AMOUNT_MISSING ("amount must be more than 0")" — SQ-04 for casing/placement. */
  AMOUNT_ZERO: () => 'amount must be more than 0',
} as const;

export function withHint(hint: string, text: string): string {
  return `${hint} ${text}`;
}

// ───────────────────────────── Fixed chips (§13.4, §9) ─────────────────────────────

function chip(id: string, label: string): Chip {
  return { id, label, disabled: false, detail: '' };
}

export const CHIPS = {
  YES: chip('yes', 'Yes'),
  NO: chip('no', 'No'),
  NO_REENTER: chip('no_reenter', 'No, re-enter'),
  DONT_PAY: chip('dont_pay', "Don't pay this one"),
  USDC: chip('USDC', 'USDC'),
  ETH: chip('ETH', 'ETH'),
  USE_AMOUNT: chip('use_amount', 'Use this amount'),
  TYPE_AMOUNT: chip('type_amount', 'Type a different amount'),
  REPEAT_YES: chip('repeat', 'Yes, repeat it'),
  REPEAT_NO: chip('once', 'No, just once'),
  ENS_USE_NEW: chip('use_new', 'Use new address'),
  ENS_KEEP: chip('keep_saved', 'Keep saved address'),
  CANCEL: chip('cancel', 'Cancel'),
  OVER_LIMIT_YES: chip('override', 'Yes, this once'),
  DAILY: chip('daily', 'Daily'),
  WEEKLY: chip('weekly', 'Weekly'),
  MONTHLY: chip('monthly', 'Monthly'),
  END_COUNT: chip('end_count', 'After a number of payments'),
  END_DATE: chip('end_date', 'Until a date'),
  END_CANCEL: chip('end_cancel', 'Until I cancel'),
} as const;

/** §9.6 step 9: detail for an unpayable member chip (disabled). */
export const MEMBER_UNPAYABLE_DETAIL = (p: P): string => `no address on ${req(p, 'chain')}`;

/** §9.3 step 6 chip label "Base Sepolia (0x3fA9…c21E)". */
export const ENS_CHAIN_CHIP_LABEL = (p: P): string => `${req(p, 'chain')} (${req(p, 'addr')})`;

// ───────────────────────────── Question builder ─────────────────────────────

export interface BuildQuestionArgs {
  question_id: QuestionId;
  code: QuestionCode;
  /** Defaults to QUESTION_TEXT[code](params). */
  text?: string;
  params?: P;
  input?: QuestionInput;
  chips?: Chip[];
  attempt?: number;
  prefill?: string;
}

export function buildQuestion(a: BuildQuestionArgs): Question {
  const q: Question = {
    question_id: a.question_id,
    code: a.code,
    text: a.text ?? QUESTION_TEXT[a.code](a.params ?? {}),
    input: a.input ?? QUESTION_INPUT[a.code],
    chips: a.chips ?? [],
    attempt: a.attempt ?? 1,
    max_attempts: 4,
  };
  if (a.prefill !== undefined) q.prefill = a.prefill;
  return q;
}

/** Same question asked again (§9.7): same code/text/chips, new id, attempt + 1, optional hint. */
export function reask(q: Question, question_id: QuestionId, hint?: string): Question {
  return { ...q, question_id, attempt: q.attempt + 1, text: hint !== undefined ? withHint(hint, q.text) : q.text };
}

// ───────────────────────────── §15 error messages ─────────────────────────────

export const ERROR_MESSAGE: Record<ErrorCode, (p: P) => string> = {
  SECRET_DETECTED: () =>
    "This looks like a private key or recovery phrase. I didn't send or save it anywhere. Never share it; if you pasted it elsewhere, move your funds to a new wallet.",
  ATTACHMENT_UNSUPPORTED: (p) =>
    `I can only read text and PDF files. ${req(p, 'filename')} wasn't read, so nothing was done.`,
  URL_FETCH_FAILED: (p) => `I couldn't open link ${req(p, 'n')}, so nothing was done.`,
  DOCUMENT_TOO_LARGE: (p) => `${req(p, 'item')} is too long for me to read safely.`,
  BALANCES_UNAVAILABLE: (p) => `I can't read your balances on ${req(p, 'chains')} right now. Try again in a moment.`,
  MAINNET_NOT_SUPPORTED: () => 'I only work on test networks for now: Sepolia, Base Sepolia and Arbitrum Sepolia.',
  UNSUPPORTED_CHAIN: (p) => `I can't use ${req(p, 'word')}. I support Sepolia, Base Sepolia and Arbitrum Sepolia.`,
  UNSUPPORTED_TOKEN: () => 'I can only send USDC and ETH.',
  // SQ-01: §8.5 rule 1 quotes a different wording with "<short reason>"; §15 wording used until resolved.
  UNSUPPORTED_REQUEST: () =>
    "I can send USDC or ETH, set up or stop repeating payments, and show balances. I can't help with that part.",
  SPLIT_UNSUPPORTED: () => 'Tell me how much each person should get, e.g. "15 to A and 15 to B".',
  RELATIVE_AMOUNT_NOT_ALLOWED: () => "I can use 'all' or 'half' only for a one-time payment to one person.",
  GROUP_AUTOPAY_UNSUPPORTED: () => "Repeating payments to a whole group aren't supported yet.",
  UNTRUSTED_IN_AUTOPAY: () => 'Repeating payments can only use amounts and addresses you typed or saved yourself.',
  CHAIN_CONFLICT: (p) =>
    `${req(p, 'name')} can only be paid on ${req(p, 'chain')}, but you asked for ${req(p, 'other')}.`,
  PAIRING_FAILED: () => "I couldn't tell which amount goes to whom. Could you rephrase, one payment per line?",
  SELF_PAYMENT: () => "That's your own address. Moving funds between your own chains isn't a payment I can make.",
  ENS_INDEXER_UNAVAILABLE: (p) => `I can't list the members of ${req(p, 'parent')} right now.`,
  GROUP_EMPTY: (p) => `${req(p, 'parent')} has no members I can pay on ${req(p, 'chain')}.`,
  NO_ACTIVE_AUTOPAY: (p) => `There's no active repeating payment to ${req(p, 'name')}.`,
  AUTOPAY_NOT_READY: () => 'That repeating payment is still being set up. Try again shortly.',
  AUTOPAY_NO_OCCURRENCES: () => 'That schedule has no payment dates. Check the start and end.',
  // SQ-08: §10.4 also says the message lists per-chain spendable vs needed; §15 wording used until resolved.
  INSUFFICIENT_FUNDS: (p) =>
    `You don't have enough ${req(p, 'token')}: you need ${req(p, 'need')}, and can use ${req(p, 'have')} across ${req(p, 'chains')}.`,
  NO_GAS: (p) => `You need at least ${req(p, 'reserve')} ETH on ${req(p, 'chain')} for network fees.`,
  CHAIN_NOT_ALLOWED: (p) => `${req(p, 'chain')} isn't in your allowed chains (Settings).`,
  LIMIT_PER_TX: (p) => `${req(p, 'amount')} ${req(p, 'token')} is over your per-payment limit of ${req(p, 'max')}.`,
  LIMIT_DAILY: (p) =>
    `This would go over today's ${req(p, 'token')} limit. You can still send ${req(p, 'remaining')} today.`,
  LIMIT_AUTOPAY_PERIOD: (p) =>
    `This pays ${req(p, 'cap')} ${req(p, 'token')} a week, over your autopay limit of ${req(p, 'max')} a week.`,
  LIMIT_AUTOPAY_DURATION: (p) => `Repeating payments can run for at most ${req(p, 'weeks')} weeks.`,
  LIMIT_BRIDGES: (p) => `This needs ${req(p, 'n')} transfers between chains; your limit is ${req(p, 'max')}.`,
  TOO_MANY_RETRIES: () => "Let's start over. Nothing was sent.",
  MODEL_FAILED: () => "I couldn't understand that right now. Please try again.",
  EXECUTION_REJECTED: (p) => `Your wallet couldn't accept this: ${req(p, 'message')}`,
  EXECUTION_UNAVAILABLE: () => "I couldn't reach your wallet. Confirm again to retry.",
  INTERNAL_ERROR: () => 'Something went wrong preparing this. Nothing was sent.',
  CANCELLED: () => 'Cancelled. Nothing was sent.',
};

// ───────────────────────────── §13.1 notes ─────────────────────────────

export const NOTES = {
  SILENT_REUSE: (p: P) => `Same address as on ${req(p, 'chain')}.`,
  FOLLOWUP: () => 'Recipient and chain from your last payment.',
  YOU_WROTE: (p: P) => `You wrote '${req(p, 'phrase')}' → ${req(p, 'amount')} ${req(p, 'token')}.`,
  FROM_CONTENT: (p: P) => `From attached content: ${req(p, 'what')}. You confirmed it.`,
  CHAIN_UNREADABLE: (p: P) => `${req(p, 'chain')} balance couldn't be read right now, so it wasn't used.`,
  ENS_RECHECK_FAILED: (p: P) => `Couldn't re-check ${req(p, 'ens')}; used the saved address.`,
  DAY_28: () => 'Paid on the 28th, since months differ in length.',
  /** §9.6 step 7 / E4: `reason` e.g. "that's your own address", "no address on Base Sepolia". */
  SKIPPED: (p: P) => `Skipped ${req(p, 'name')}: ${req(p, 'reason')}.`,
  LIMIT_LIFTED: () => "Today's limit was lifted once for this group payment.",
  CONTENT_AMOUNTS_UNUSED: () => "Amounts in the attached content weren't used.",
  CONTENT_UNREADABLE: (p: P) => `Couldn't read anything usable from ${req(p, 'item')}.`,
} as const;

/** §9.6 step 7 / E4 skip reasons. SQ-07: duplicate-address reason wording not given by the spec. */
/**
 * §8.2 steps 4–5 / §15 `DOCUMENT_TOO_LARGE` and §13.1 note: the `{item}` slot naming a content item
 * (contracts-v3, CCR B-1). SQ-22: the spec gives no wording; interim labels until the human answers.
 */
export const ITEM_LABEL = {
  attachment: (p: { filename: string }): string => p.filename,
  url: (p: { n: number }): string => `link ${p.n}`,
  pasted: (p: { n: number }): string => `pasted text ${p.n}`,
} as const;

export const SKIP_REASON = {
  OWN_ADDRESS: () => "that's your own address",
  NO_ADDRESS_ON: (p: P) => `no address on ${req(p, 'chain')}`,
} as const;

// ───────────────────────────── §13.3 fixed replies, §8.14, §13.1 framing ─────────────────────────────

export const REPLY = {
  HANDED_OFF: () => 'Sent to your wallet for signing.',
  USER_SAID_NO: () => "OK, I've dropped that. Tell me what you'd like instead.",
  CANCELLED: () => 'Cancelled. Nothing was sent.',
  PENDING_REPLACED: () => 'I dropped the previous plan and started on your new request.',
} as const;

export const SUMMARY_FRAME = {
  HEADER: () => 'Please confirm:',
  FOOTER_SPENT: (p: P) => `Spent today after this: ${req(p, 'spent')} of ${req(p, 'daily_max')} ${req(p, 'token')}.`,
  CONFIRM: () => 'Confirm?',
} as const;

// ───────────────────────────── §13.4 answer parsing (chips) ─────────────────────────────

/**
 * §13.4 "Answer parsing": a chip answer is matched by `chip_id`; a free-text answer to a chips question matches a
 * chip if it equals a chip label case-insensitively (also "yes"/"no" for Yes/No chips); otherwise invalid.
 * Disabled chips never match. Returns the matched chip or null.
 */
export function matchChip(q: Question, answer: Answer): Chip | null {
  const enabled = q.chips.filter((c) => !c.disabled);
  if (answer.kind === 'chip') return enabled.find((c) => c.id === answer.chip_id) ?? null;
  if (answer.kind !== 'text') return null;
  const t = answer.text.trim().toLowerCase();
  const byLabel = enabled.find((c) => c.label.toLowerCase() === t);
  if (byLabel) return byLabel;
  if (t === 'yes') return enabled.find((c) => c.label === 'Yes') ?? null;
  if (t === 'no') return enabled.find((c) => c.label === 'No') ?? null;
  return null;
}
