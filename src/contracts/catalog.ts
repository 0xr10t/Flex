// Implements: §13.4 question texts + fixed chips, §15 error messages, §13.1 notes, §13.3 fixed replies,
// re-ask / variant wordings quoted in §8.4, §9.1–§9.6. Verbatim from the spec.
// SQ-S-01: summary note for a correction to an insufficient-funds request.
// SQ-UI-01: recipient questions explicitly request a wallet address and explain the accepted alternatives.
// SQ-UI-02: new-recipient confirmation wording, retaining the full address and ENS chain context.
// Owned by the Orchestrator (frozen contract). No lane writes user-facing text inline; use these.
// Items marked SQ-nn have an open entry in SPEC_QUESTIONS.md.

import type { Answer, Chip, ErrorCode, QuestionCode, QuestionId, QuestionInput, Question, Token } from './types.js';

type P = Record<string, string>;

function req(p: P, key: string): string {
  const v = p[key];
  if (v === undefined) throw new Error(`catalog: missing param ${key}`);
  return v;
}

/** "A", "A and B", "A, B and C": the one join for user-facing lists (SQ-06 / SQB-01, F-10, SQ-O-10). */
export function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// ───────────────────────────── §13.4 question texts ─────────────────────────────

const NEW_RECIPIENT_CONFIRMATION = 'You have not paid this recipient before. Do you want to proceed?';

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
  Q_NO_PAYEE: () => 'Who should receive this? Enter their wallet address, ENS name or saved contact name.',
  Q_FOLLOWUP_WHO: (p) => `Who should get this: ${req(p, 'names')}?`,
  Q_WHO_IS: (p) => `What is the wallet address for "${req(p, 'name')}"? You can also enter an ENS name.`,
  Q_ADDRESS_CORRECT: (p) => `${NEW_RECIPIENT_CONFIRMATION}\nWallet address: ${req(p, 'addr')}`,
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
  // SQ-D-16, F-1…F-6: `lead` from limitOverrideLead(); `repeating` = 'true' picks "Set it up anyway?".
  // Build it with LIMIT_OVERRIDE.text() / LIMIT_OVERRIDE.chips().
  Q_LIMIT_OVERRIDE: (p) => `${req(p, 'lead')} ${p.repeating === 'true' ? 'Set it up anyway?' : 'Go ahead this once?'}`,
  // SQ-O-03, F-11: one question per affected amount; chips = the possible recipients (PAIR_AMOUNT.chips()).
  Q_PAIR_AMOUNT: (p) => `Who should get ${req(p, 'amount')} ${req(p, 'token')}?`,
  // SQ-O-01, F-12: a name labelled both payee and mentioned (NAME_ROLE.text() / NAME_ROLE.chips()).
  Q_NAME_ROLE: (p) => `Should I pay ${req(p, 'name')}?`,
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
  Q_LIMIT_OVERRIDE: 'chips',
  Q_PAIR_AMOUNT: 'chips',
  Q_NAME_ROLE: 'chips',
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
  WHO_IS_INVALID_ENS: () => "That isn't a valid ENS name. Paste the recipient's wallet address or a valid ENS name.",
  /** §9.3 step 4: ENS has no address on any queried chain → Q_ADDRESS_REENTER. */
  REENTER_ENS_NO_ADDRESS: (p: P) => `${req(p, 'ens')} has no address for these chains. Paste an address instead?`,
  /** §9.3 step 7: Q_ADDRESS_CORRECT for an ENS-resolved address. SQ-06: `chains` join format when several match. */
  ADDRESS_CORRECT_ENS: (p: P) =>
    `${NEW_RECIPIENT_CONFIRMATION}\n${req(p, 'ens')} → ${req(p, 'addr')} on ${req(p, 'chains')}.`,
  /** §9.2 step 5: suffix for untrusted addresses (appended after a space). */
  ADDRESS_CORRECT_UNTRUSTED_SUFFIX: () => 'This address comes from the attached content, not from you.',
  /** §9.4 "No address now" variant of Q_ENS_CHANGED. */
  ENS_CHANGED_NO_ADDRESS: (p: P) => `${req(p, 'ens')} no longer has an address. Keep the saved one?`,
  /** Privacy fix 4: an ENS name found in attached content is looked up only after the user says so. */
  WHO_IS_UNTRUSTED_ENS: (p: P) =>
    `The attached content names ${req(p, 'ens')}. Should I look it up? You can also paste the wallet address.`,
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
  /** SQ-O-03 / F-11: Q_PAIR_AMOUNT choices that leave a payee unpaid (P3). The answers give no wording; interim. */
  PAIR_UNPAID: (p: P) => `That would leave ${req(p, 'name')} with nothing.`,
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
  /** Privacy fix 4: look up an ENS name that came from attached content. */
  ENS_LOOKUP: chip('ens_lookup', 'Look it up'),
  USDC: chip('USDC', 'USDC'),
  ETH: chip('ETH', 'ETH'),
  USE_AMOUNT: chip('use_amount', 'Use this amount'),
  TYPE_AMOUNT: chip('type_amount', 'Type a different amount'),
  REPEAT_YES: chip('repeat', 'Yes, repeat it'),
  REPEAT_NO: chip('once', 'No, just once'),
  ENS_USE_NEW: chip('use_new', 'Use new address'),
  ENS_KEEP: chip('keep_saved', 'Keep saved address'),
  CANCEL: chip('cancel', 'Cancel'),
  /** Q_LIMIT_OVERRIDE "Yes" (one-time payments). */
  OVER_LIMIT_YES: chip('override', 'Yes, this once'),
  /** Q_LIMIT_OVERRIDE "Yes" when a broken limit belongs to a repeating payment (same id as OVER_LIMIT_YES). */
  OVER_LIMIT_SET_UP: chip('override', 'Yes, set it up'),
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

// ───────────────────────────── contracts-v4 question builders ─────────────────────────────

/**
 * One broken DB5 limit (SQ-D-16, F-1…F-6), in S10's check order. Figures are display values (no trailing zeros).
 * `token` is shown after a figure only when the broken limits span two tokens. `repeating` is true when the limit
 * belongs to a repeating payment (`k`); any such limit picks the "Set it up anyway?" closing.
 */
export type BrokenLimit =
  | { kind: 'per_payment'; max: string; token: Token; repeating: boolean }
  | { kind: 'daily'; daily_max: string; remaining: string; token: Token; repeating: false }
  | { kind: 'autopay_period'; max: string; token: Token; repeating: true }
  | { kind: 'autopay_duration'; weeks: string; repeating: true }
  | { kind: 'bridges'; n: string; max: string; repeating: boolean };

type OverLimit = Exclude<BrokenLimit, { kind: 'bridges' }>;

export interface LimitOverrideArgs {
  /** At least one. */
  broken: BrokenLimit[];
  /** "This is {value} {token}, …": the request's total of that token; omitted when not meaningful. */
  amount?: { value: string; token: Token };
}

function overFragment(b: OverLimit, withToken: boolean): string {
  const unit = (figure: string, token: Token): string => (withToken ? `${figure} ${token}` : figure);
  switch (b.kind) {
    case 'per_payment':
      return `your per-payment limit of ${unit(b.max, b.token)}`;
    case 'daily':
      return `today's limit of ${unit(b.daily_max, b.token)} (only ${b.remaining} is left)`;
    case 'autopay_period':
      return `your weekly autopay limit of ${unit(b.max, b.token)}`;
    case 'autopay_duration':
      return `the ${b.weeks}-week limit for repeating payments`;
  }
}

/**
 * Lead sentence of Q_LIMIT_OVERRIDE: one fragment per broken limit, joined with joinList; the "over …" fragments
 * share one "over", as in F-1.
 *  - "This is 150 USDC, over your per-payment limit of 100 and today's limit of 300 (only 40 is left)." (F-1)
 *  - "This repeating payment is over your weekly autopay limit of 100." (F-3)
 *  - "This needs 4 transfers between chains; your limit is 3." (F-4)
 */
export function limitOverrideLead(a: LimitOverrideArgs): string {
  const over = a.broken.filter((b): b is OverLimit => b.kind !== 'bridges');
  const bridges = a.broken.find((b) => b.kind === 'bridges');
  const mixed = new Set(over.flatMap((b) => ('token' in b ? [b.token] : []))).size > 1;
  const parts: string[] = [];
  if (over.length > 0) parts.push(`over ${joinList(over.map((b) => overFragment(b, mixed)))}`);
  if (bridges) parts.push(`needs ${bridges.n} transfers between chains; your limit is ${bridges.max}`);
  const body = joinList(parts);
  if (over.length === 0) return `This ${body}.`;
  if (over.every((b) => b.repeating)) return `This repeating payment is ${body}.`;
  if (a.amount !== undefined && !mixed) return `This is ${a.amount.value} ${a.amount.token}, ${body}.`;
  return `This is ${body}.`;
}

/** Q_LIMIT_OVERRIDE (SQ-D-16, F-1…F-6): text, and chips "Yes, this once" (or "Yes, set it up") / "No". */
export const LIMIT_OVERRIDE = {
  repeating: (a: LimitOverrideArgs): boolean => a.broken.some((b) => b.repeating),
  text: (a: LimitOverrideArgs): string =>
    QUESTION_TEXT.Q_LIMIT_OVERRIDE({ lead: limitOverrideLead(a), repeating: String(LIMIT_OVERRIDE.repeating(a)) }),
  chips: (a: LimitOverrideArgs): Chip[] => [
    LIMIT_OVERRIDE.repeating(a) ? CHIPS.OVER_LIMIT_SET_UP : CHIPS.OVER_LIMIT_YES,
    CHIPS.NO,
  ],
} as const;

/** Q_LIMIT_OVERRIDE: matchChip(q, answer, LIMIT_OVERRIDE_YES_NO) maps a typed "yes" / "no" to its chips. */
export const LIMIT_OVERRIDE_YES_NO = { yes: CHIPS.OVER_LIMIT_YES.id, no: CHIPS.NO.id } as const;

/** Q_PAIR_AMOUNT (SQ-O-03, F-11): "Who should get {amount} {token}?", one chip per possible recipient. */
export const PAIR_AMOUNT = {
  text: (p: { amount: string; token: Token }): string => QUESTION_TEXT.Q_PAIR_AMOUNT(p),
  /** `id` = the recipient placeholder, `label` = its display name (or short address). */
  chips: (recipients: ReadonlyArray<{ id: string; label: string }>): Chip[] =>
    recipients.map((r) => chip(r.id, r.label)),
} as const;

/** Chip ids of Q_NAME_ROLE. */
export const NAME_ROLE_CHIP = { PAY: 'pay', MENTIONED: 'only_mentioned' } as const;

/** Q_NAME_ROLE (SQ-O-01, F-12): "Should I pay {name}?", chips "Yes, pay {name}" / "No, they're only mentioned". */
export const NAME_ROLE = {
  text: (p: { name: string }): string => QUESTION_TEXT.Q_NAME_ROLE(p),
  chips: (p: { name: string }): Chip[] => [
    chip(NAME_ROLE_CHIP.PAY, `Yes, pay ${p.name}`),
    chip(NAME_ROLE_CHIP.MENTIONED, "No, they're only mentioned"),
  ],
} as const;

/** Q_NAME_ROLE: matchChip(q, answer, NAME_ROLE_YES_NO) maps a typed "yes" / "no" to its chips. */
export const NAME_ROLE_YES_NO = { yes: NAME_ROLE_CHIP.PAY, no: NAME_ROLE_CHIP.MENTIONED } as const;

/**
 * §15 INSUFFICIENT_FUNDS params (SQ-08, F-10). `chains`: the chains with a positive spendable amount of the token,
 * in configured chain order, unreadable chains left out (entries with a zero amount are dropped here as well).
 * All figures are display values without trailing zeros. Renders
 * "You don't have enough USDC: you need 150, and can use 140 across Base Sepolia (80) and Arbitrum Sepolia (60)."
 * and, with no chain left, "You don't have enough USDC: you need 150, and can use 0."
 */
export interface InsufficientFundsArgs {
  token: Token;
  need: string;
  have: string;
  chains: ReadonlyArray<{ name: string; spendable: string }>;
}

export function insufficientFundsParams(a: InsufficientFundsArgs): Record<string, string> {
  const positive = a.chains.filter((c) => /[1-9]/.test(c.spendable));
  return {
    token: a.token,
    need: a.need,
    have: a.have,
    chains: joinList(positive.map((c) => `${c.name} (${c.spendable})`)),
  };
}

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
  // Privacy fix 5: links can't be fetched through anon-rpc, so reading them is off unless `fetch.enabled` is set.
  LINKS_OFF: (p) =>
    `Opening links is turned off for privacy, so link ${req(p, 'n')} wasn't read and nothing was done. Paste its text instead.`,
  DOCUMENT_TOO_LARGE: (p) => `${req(p, 'item')} is too long for me to read safely.`,
  BALANCES_UNAVAILABLE: (p) => `I can't read your balances on ${req(p, 'chains')} right now. Try again in a moment.`,
  MAINNET_NOT_SUPPORTED: () => 'I only work on test networks for now: Sepolia, Base Sepolia and Arbitrum Sepolia.',
  UNSUPPORTED_CHAIN: (p) => `I can't use ${req(p, 'word')}. I support Sepolia, Base Sepolia and Arbitrum Sepolia.`,
  UNSUPPORTED_TOKEN: () => 'I can only send USDC and ETH.',
  // SQ-01, F-7: human-approved difference from §15 and §8.5 rule 1 (no short reason is generated).
  UNSUPPORTED_REQUEST: () =>
    "I can send USDC or ETH, bridge funds between chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part.",
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
  // SQ-08, F-10: `chains` per chain, "Base Sepolia (80) and Arbitrum Sepolia (60)" (insufficientFundsParams);
  // empty or absent → "…, and can use 0." with no "across" part.
  INSUFFICIENT_FUNDS: (p) => {
    const across = p.chains !== undefined && p.chains !== '' ? ` across ${p.chains}` : '';
    return `You don't have enough ${req(p, 'token')}: you need ${req(p, 'need')}, and can use ${req(p, 'have')}${across}.`;
  },
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
  // SQ-A-06, F-9: attempts 1–2 keep the §15 text; on the 3rd failed attempt `final` is that attempt's cause.
  EXECUTION_UNAVAILABLE: (p) => {
    if (p.final === 'timeout') {
      return "I couldn't confirm your wallet received this after 3 tries. Check your wallet before trying again.";
    }
    if (p.final === 'server_error') {
      return "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again later.";
    }
    return "I couldn't reach your wallet. Confirm again to retry.";
  },
  INTERNAL_ERROR: () => 'Something went wrong preparing this. Nothing was sent.',
  CANCELLED: () => 'Cancelled. Nothing was sent.',
};

// ───────────────────────────── §13.1 notes ─────────────────────────────

export const NOTES = {
  /** SQ-O-10: `chains` = joinList of every chain whose DB2 row for the contact holds the reused address. */
  SILENT_REUSE: (p: P) => `Same address as on ${req(p, 'chains')}.`,
  FOLLOWUP: () => 'Recipient and chain from your last payment.',
  /** SQ-S-01: an insufficient-funds failure is not a previous payment. */
  PAYMENT_CORRECTION: () => 'Continuing your previous request with a new amount.',
  YOU_WROTE: (p: P) => `You wrote '${req(p, 'phrase')}' → ${req(p, 'amount')} ${req(p, 'token')}.`,
  FROM_CONTENT: (p: P) => `From attached content: ${req(p, 'what')}. You confirmed it.`,
  CHAIN_UNREADABLE: (p: P) => `${req(p, 'chain')} balance couldn't be read right now, so it wasn't used.`,
  ENS_RECHECK_FAILED: (p: P) => `Couldn't re-check ${req(p, 'ens')}; used the saved address.`,
  DAY_28: () => 'Paid on the 28th, since months differ in length.',
  /** §9.6 step 7 / E4: `reason` e.g. "that's your own address", "no address on Base Sepolia". */
  SKIPPED: (p: P) => `Skipped ${req(p, 'name')}: ${req(p, 'reason')}.`,
  /** SQ-D-16, F-2: shown when a "Yes" to Q_LIMIT_OVERRIDE lifted a limit. */
  LIMIT_LIFTED: () => 'A limit was lifted once for this request.',
  CONTENT_AMOUNTS_UNUSED: () => "Amounts in the attached content weren't used.",
  CONTENT_UNREADABLE: (p: P) => `Couldn't read anything usable from ${req(p, 'item')}.`,
  /** Privacy fix 5: links typed in the message are never opened. */
  LINKS_NOT_OPENED: () => "Links in your message weren't opened. Paste their text if I should read it.",
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
  /** SQ-A-01, F-8: cancel of a HANDED_OFF request (HTTP 200, state unchanged). */
  CANCEL_AFTER_HANDOFF: () => "That was already sent to your wallet for signing, so it can't be cancelled here.",
  /** SQ-R-06: cancel of a HANDOFF_FAILED request whose last attempt timed out (the wallet may have received it). */
  CANCEL_AFTER_TIMEOUT: () => 'Cancelled here, but your wallet may already have received it. Check your wallet.',
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
export function matchChip(q: Question, answer: Answer, yesNo?: { yes: string; no: string }): Chip | null {
  const enabled = q.chips.filter((c) => !c.disabled);
  if (answer.kind === 'chip') return enabled.find((c) => c.id === answer.chip_id) ?? null;
  if (answer.kind !== 'text') return null;
  const t = answer.text.trim().toLowerCase();
  const byLabel = enabled.find((c) => c.label.toLowerCase() === t);
  if (byLabel) return byLabel;
  // contracts-v4: `yesNo` names the chips a typed "yes" / "no" stands for when they are not labelled Yes / No.
  if (t === 'yes') return enabled.find((c) => (yesNo ? c.id === yesNo.yes : c.label === 'Yes')) ?? null;
  if (t === 'no') return enabled.find((c) => (yesNo ? c.id === yesNo.no : c.label === 'No')) ?? null;
  return null;
}
