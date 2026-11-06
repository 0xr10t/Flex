// Implements: §8.0 request object, §12.3 internal plan types, §12.5 hand-off envelope types,
// §13.4 question shape + codes, §14.1 AgentResponse, §14.3 ExecutionReport, §15 error codes, §6.1 Config, §6.3 Limits.
// SQ-S-01 / SQ-S-02: in-memory failed-payment context for a fresh amount correction or back-reference.
// Owned by the Orchestrator (frozen contract). Lanes must not edit; send a CCR (ORCHESTRATOR_PROMPT §7).
//
// Fields marked "internal addition" are not named in the spec text but are needed to carry state between
// steps that the spec describes. They never leave the agent process.

// ───────────────────────────── Primitives ─────────────────────────────

export type ChainId = 11155111 | 84532 | 421614;
export const CHAIN_IDS: readonly ChainId[] = [11155111, 84532, 421614];

export type Token = 'USDC' | 'ETH';
export const TOKEN_DECIMALS: Readonly<Record<Token, 6 | 18>> = { USDC: 6, ETH: 18 };

/** §7.3 `amount_` + 8 lowercase hex. */
export type AmountPh = `amount_${string}`;
/** §7.3 `address_` + 8 lowercase hex. */
export type AddressPh = `address_${string}`;
/** §7.3 `group_` + 8 lowercase hex. */
export type GroupPh = `group_${string}`;
export type RecipientPh = AddressPh | GroupPh;

export type RequestId = `req_${string}`;
export type SessionId = `ses_${string}`;
export type AutopayId = `ap_${string}`;
export type QuestionId = `q_${string}`;

/** Hex address string. Stored/handed off EIP-55 checksummed (§7, §12.5). */
export type Address = `0x${string}`;

/** Decimal string, e.g. "40", "10.2". Never a JS number (NFR-06). */
export type DecimalString = string;
/** Integer string of token base units. */
export type BaseUnitsString = string;

export type ActionKind = 'i' | 'k' | 'l';
export type Weekday = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
export type Frequency = 'daily' | 'weekly' | 'monthly';

// ───────────────────────────── Config (§6.1) and limits (§6.3) ─────────────────────────────

export interface ChainConfig {
  chain_id: ChainId;
  name: string;
  is_l2: boolean;
  aliases: string[];
  rpc_url: string;
  usdc_address: Address;
}

export interface Config {
  wallet: { address: Address };
  server: { host: '127.0.0.1'; port: number };
  auth: { ui_token_file: string; execution_report_token_file: string };
  db: { path: string };
  llm: {
    ollama_url: string;
    model: string;
    temperature: number;
    seed: number;
    num_ctx: number;
    timeout_ms: number;
  };
  chains: ChainConfig[];
  ens: {
    rpc_chain_id: ChainId;
    universal_resolver_address: Address;
    /** Null turns group sends off (privacy fix 6). Through Tor when `network.socks_proxy` is set. */
    indexer_url: string | null;
    indexer_kind: 'ens-subgraph' | 'ensnode-omnigraph';
  };
  execution: { url: string; outbound_token_file: string; timeout_ms: number };
  /**
   * anon-rpc over Tor: `socks5h://127.0.0.1:<port>` sends every request to a host that isn't this machine through Tor, one
   * circuit per kind of query; null means direct connections.
   */
  network: { socks_proxy: string | null };
  /** `enabled: false` turns link reading off (privacy fix 5). Through Tor when `network.socks_proxy` is set. */
  fetch: { enabled: boolean; max_bytes: number; timeout_ms: number; max_redirects: number };
  defaults: { timezone: string; autopay_time_of_day: string };
}

/** DB5 parsed (§6.3). Amount values are decimal strings. */
export interface Limits {
  per_tx_max: Record<Token, DecimalString>;
  daily_max: Record<Token, DecimalString>;
  autopay_max_per_period: Record<Token, DecimalString>;
  autopay_max_weeks: number;
  max_bridges_per_request: number;
  allowed_chain_ids: ChainId[];
  /** Keyed by chain id as a string, e.g. "11155111". */
  eth_gas_reserve: Record<string, DecimalString>;
  bridge_buffer_pct: DecimalString;
}
export type LimitKey = keyof Limits;

// ───────────────────────────── S1 input and untrusted content ─────────────────────────────

export interface Attachment {
  filename: string;
  mime: string;
  base64: string;
}

/** Body of POST /v1/sessions/{id}/messages (§14.1). */
export interface MessageInput {
  text: string;
  pasted_blocks: string[];
  attachments: Attachment[];
  urls: string[];
}

/** §8.2 step 5 Q-LLM result entry. */
export interface QItem {
  /** Index of the content item (pasted block / attachment / URL) this came from. */
  item_index: number;
  address: Address | null;
  ens_name: string | null;
  amount: DecimalString | null;
  token: Token | null;
}

// ───────────────────────────── S2 lexical scan (§8.3) ─────────────────────────────

export interface Span {
  text: string;
  /** Character offsets into typed_text (end exclusive). */
  start: number;
  end: number;
  clause_index: number;
}

export interface Clause {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface EnsCandidate extends Span {
  /** ENSIP-15 normalized form. */
  normalized: string;
}

export interface GroupCandidate extends Span {
  /** The parent name text: `<domain>` for `@<domain>`, X for "everyone under X". */
  parent: string;
}

export interface ChainMention extends Span {
  word: string;
  chain_id: ChainId;
}

export type TokenWordKind = 'USDC' | 'ETH' | 'FIAT_USD' | 'FIAT_OTHER';
export interface TokenMention extends Span {
  word: string;
  kind: TokenWordKind;
}

export type ChronoKind = 'time' | 'date' | 'start' | 'end';
export interface ChronoSpan extends Span {
  kind: ChronoKind;
  /** yyyy-MM-dd in the session timezone, when chrono gave a date component. */
  date: string | null;
  /** HH:mm (24h), when chrono gave a time component. */
  time: string | null;
}

export interface WordFlag extends Span {
  word: string;
}

export interface LexicalScan {
  clauses: Clause[];
  addresses: Span[];
  ens: EnsCandidate[];
  groups: GroupCandidate[];
  chains: ChainMention[];
  tokens: TokenMention[];
  dates: ChronoSpan[];
  recurrence: WordFlag[];
  cancel: WordFlag[];
  back_reference: WordFlag[];
  distributive: WordFlag[];
  split: WordFlag[];
  numeric_candidates: Span[];
}

// ───────────────────────────── S3 amounts ─────────────────────────────

export type AmountSource = 'user' | 'derived' | 'untrusted';
export type AmountOrigin =
  'phrase' | 'relative' | 'bridge_padded' | 'autopay_per_period_cap' | 'autopay_total_cap' | 'document';

/** One pay amount of this request (S3), mirrored by a DB1 row. */
export interface AmountItem {
  placeholder: AmountPh;
  /** The phrase as written; null for document amounts and answers to Q_AMOUNT_MISSING. */
  phrase: string | null;
  /** Span in typed_text; null when not from typed text. */
  span: Span | null;
  amount: DecimalString;
  token: Token;
  source: AmountSource;
  origin: AmountOrigin;
  confirmed: boolean;
  relative: 'all' | 'half' | 'max' | null;
  fiat: 'USD' | 'OTHER' | null;
  /** Chain this amount is pinned to (relative amounts, §8.4 step 6). */
  pinned_chain_id: ChainId | null;
  /** True when the code parser verified the LLM number (else the §13.1 "You wrote …" note applies). */
  code_verified: boolean;
  /** Index into AgentRequest.untrusted for document amounts. */
  untrusted_item_index: number | null;
}

// ───────────────────────────── S5 spans / S6 resolution / S7 masking ─────────────────────────────

export type SpanKind = 'name' | 'ens' | 'address' | 'group';

/** A payee (S5, after filtering). `mentioned` spans are dropped and never stored. */
export interface RecipientSpan {
  text: string;
  kind: SpanKind;
  role: 'payee';
  /** Offsets in masked_text_s3; null for document payees and follow-up payees. */
  span: Span | null;
  /** 'untrusted' for §8.6 step 8 document payees. */
  source: 'user' | 'untrusted';
  /** Follow-up reference to an earlier payee (§17.2); then `followup_placeholder` is set. */
  followup_placeholder: AddressPh | null;
  /** Index into AgentRequest.untrusted for document payees. */
  untrusted_item_index: number | null;
}

export type RecipientSource = 'user' | 'contact' | 'ens' | 'untrusted' | 'session';

export interface GroupMember {
  subname: string;
  address: Address | null;
  /** False → shown disabled ("no address on <chain>") in Q_GROUP_MEMBERS. */
  payable: boolean;
  selected: boolean;
}

/** S6 output per payee (internal addition: carried from S6 to S7/S9/S11). */
export interface ResolvedRecipient {
  span_index: number;
  kind: 'single' | 'group';
  /** {Name} for the summary: contact name, else ENS name, else subname (§13.1). */
  display_name: string;
  address: Address | null;
  ens_name: string | null;
  source: RecipientSource;
  /** True when this resolved to an existing (or newly added) DB2 contact. */
  is_contact: boolean;
  /** Chains with DB2 rows for this contact (contacts). */
  contact_chain_ids: ChainId[];
  /** ENS-sourced: chains whose record returned this address. */
  ens_chain_ids: ChainId[];
  /** Pinned by Q_ENS_CHAIN (§9.3 step 6). */
  pinned_chain_id: ChainId | null;
  /** Groups only. */
  group?: { parent: string; chain_id: ChainId; members: GroupMember[] };
}

/** S7 output: one placeholder per payee span (or follow-up reference). */
export interface RecipientRef {
  placeholder: RecipientPh;
  span_index: number;
  type: 'person' | 'group';
  source: RecipientSource;
  /** Reused from session history (§17.2 step 4); no new DB3 row. */
  followup: boolean;
  /** For follow-ups: the payee's previous chain (S9 uses it when S8 says "unstated"). */
  last_chain_id: ChainId | null;
}

// ───────────────────────────── S8 payments ─────────────────────────────

/** One S8 item (§12.2) plus the token filled from DB1 (I-06). `token` is null only for `l`. */
export interface Payment {
  kind: ActionKind;
  amount: AmountPh | null;
  recipient: RecipientPh;
  chain: ChainId | 'unstated';
  frequency: Frequency | null;
  interval: number | null;
  times_per_week: number | null;
  days_of_week: Weekday[] | null;
  day_of_month: number | null;
  token: Token | null;
}

// ───────────────────────────── §12.5 schedule / CRE job ─────────────────────────────

export type ScheduleEnd =
  { type: 'after_count'; count: number } | { type: 'on_date'; date: string } | { type: 'until_cancelled' };

export interface Schedule {
  frequency: Frequency;
  interval: number;
  days_of_week: Weekday[] | null;
  day_of_month: number | null;
  /** HH:MM */
  time_of_day: string;
  timezone: string;
  /** yyyy-MM-dd */
  start_date: string;
  /** ISO-8601 date-time */
  first_occurrence: string;
  end: ScheduleEnd;
}

export interface CreJob {
  trigger: 'cron';
  cron: string;
  timezone: string;
  interval: number;
}

// ───────────────────────────── §12.3 internal plan (placeholders) ─────────────────────────────

export interface PlanI {
  intent_id: 'i';
  step: number;
  depends_on: number[];
  token: Token;
  chain_id: ChainId;
  amount: AmountPh;
  recipient: AddressPh;
  reused_from_chain_id: ChainId | null;
}
export interface PlanJ {
  intent_id: 'j';
  step: number;
  token: Token;
  source_chain_id: ChainId;
  dest_chain_id: ChainId;
  amount: AmountPh;
  deliverable_base_units: string;
  receiver: 'self';
  funds_steps: number[];
}
export interface PlanK {
  intent_id: 'k';
  step: number;
  depends_on: number[];
  autopay_id: string;
  token: Token;
  chain_id: ChainId;
  recipient: AddressPh;
  amount_per_payment: AmountPh;
  schedule: Schedule;
  limits: { per_period_cap: AmountPh; total_cap: AmountPh; expires_at: string };
  cre_job: CreJob;
}
export interface PlanL {
  intent_id: 'l';
  step: number;
  autopay_id: string;
  chain_id: ChainId;
  delegate_address: string;
  recipient: AddressPh;
  refund_remaining: true;
}
export type InternalIntent = PlanI | PlanJ | PlanK | PlanL;
/** The S9 output validated by V-01 against src/schemas/internal-plan.schema.json. */
export type InternalPlan = InternalIntent[];

// ───────────────────────────── §12.5 hand-off envelope ─────────────────────────────

export interface EnvelopeAmount {
  value: DecimalString;
  base_units: BaseUnitsString;
  decimals: 6 | 18;
}
export interface EnvelopeI {
  intent_id: 'i';
  step: number;
  depends_on: number[];
  token: Token;
  token_address: Address | null;
  chain_id: ChainId;
  amount: EnvelopeAmount;
  recipient: Address;
}
export interface EnvelopeJ {
  intent_id: 'j';
  step: number;
  token: Token;
  source_token_address: Address | null;
  dest_token_address: Address | null;
  source_chain_id: ChainId;
  dest_chain_id: ChainId;
  amount: EnvelopeAmount;
  receiver: 'self';
  funds_steps: number[];
}
export interface EnvelopeK {
  intent_id: 'k';
  step: number;
  depends_on: number[];
  autopay_id: string;
  token: Token;
  token_address: Address | null;
  chain_id: ChainId;
  recipient: Address;
  amount_per_payment: EnvelopeAmount;
  prefund: EnvelopeAmount;
  schedule: Schedule;
  limits: { per_period_cap: EnvelopeAmount; total_cap: EnvelopeAmount; expires_at: string };
  cre_job: CreJob;
}
export interface EnvelopeL {
  intent_id: 'l';
  step: number;
  autopay_id: string;
  chain_id: ChainId;
  delegate_address: Address;
  recipient: Address;
  refund_remaining: true;
}
export type EnvelopeIntent = EnvelopeI | EnvelopeJ | EnvelopeK | EnvelopeL;

export interface HandoffEnvelope {
  version: '1';
  request_id: string;
  wallet_address: Address;
  created_at: string;
  intents: EnvelopeIntent[];
}

// ───────────────────────────── §13.4 questions ─────────────────────────────

export type QuestionCode =
  | 'Q_AMOUNT_MISSING'
  | 'Q_AMOUNT_MISMATCH'
  | 'Q_AMOUNT_UNCOVERED'
  | 'Q_AMOUNT_PRECISION'
  | 'Q_TOKEN'
  | 'Q_FIAT_OTHER'
  | 'Q_UNTRUSTED_AMOUNT'
  | 'Q_RECURRING'
  | 'Q_NO_PAYEE'
  | 'Q_FOLLOWUP_WHO'
  | 'Q_WHO_IS'
  | 'Q_ADDRESS_CORRECT'
  | 'Q_ADDRESS_REENTER'
  | 'Q_NAME_FOR_ADDRESS'
  | 'Q_ENS_CHAIN'
  | 'Q_ENS_CHANGED'
  | 'Q_GROUP_PARENT'
  | 'Q_GROUP_CHAIN'
  | 'Q_GROUP_MEMBERS'
  | 'Q_LIMIT_OVERRIDE'
  | 'Q_PAIR_AMOUNT'
  | 'Q_NAME_ROLE'
  | 'Q_AUTOPAY_FREQUENCY'
  | 'Q_AUTOPAY_START'
  | 'Q_AUTOPAY_END'
  | 'Q_AUTOPAY_COUNT'
  | 'Q_AUTOPAY_DATE'
  | 'Q_AUTOPAY_PICK';

export const QUESTION_CODES: readonly QuestionCode[] = [
  'Q_AMOUNT_MISSING',
  'Q_AMOUNT_MISMATCH',
  'Q_AMOUNT_UNCOVERED',
  'Q_AMOUNT_PRECISION',
  'Q_TOKEN',
  'Q_FIAT_OTHER',
  'Q_UNTRUSTED_AMOUNT',
  'Q_RECURRING',
  'Q_NO_PAYEE',
  'Q_FOLLOWUP_WHO',
  'Q_WHO_IS',
  'Q_ADDRESS_CORRECT',
  'Q_ADDRESS_REENTER',
  'Q_NAME_FOR_ADDRESS',
  'Q_ENS_CHAIN',
  'Q_ENS_CHANGED',
  'Q_GROUP_PARENT',
  'Q_GROUP_CHAIN',
  'Q_GROUP_MEMBERS',
  'Q_LIMIT_OVERRIDE',
  'Q_PAIR_AMOUNT',
  'Q_NAME_ROLE',
  'Q_AUTOPAY_FREQUENCY',
  'Q_AUTOPAY_START',
  'Q_AUTOPAY_END',
  'Q_AUTOPAY_COUNT',
  'Q_AUTOPAY_DATE',
  'Q_AUTOPAY_PICK',
];

export type QuestionInput = 'chips' | 'text' | 'address' | 'number' | 'date' | 'multiselect';

export interface Chip {
  id: string;
  label: string;
  disabled: boolean;
  detail: string;
}

/** Sent to the UI exactly in this shape (§13.4). `prefill` — see SPEC_QUESTIONS SQ-03. */
export interface Question {
  question_id: QuestionId;
  code: QuestionCode;
  text: string;
  input: QuestionInput;
  chips: Chip[];
  attempt: number;
  max_attempts: 4;
  /** Prefilled value for text inputs (Q_NAME_FOR_ADDRESS, §9.2 step 5). Omitted when none. */
  prefill?: string;
}

/** A user's answer to the pending question (§14.1 /answers, or free text via /messages §17.3). */
export type Answer =
  { kind: 'chip'; chip_id: string } | { kind: 'text'; text: string } | { kind: 'selected'; selected_ids: string[] };

// ───────────────────────────── §15 errors ─────────────────────────────

export type ErrorCode =
  | 'SECRET_DETECTED'
  | 'ATTACHMENT_UNSUPPORTED'
  | 'URL_FETCH_FAILED'
  | 'LINKS_OFF'
  | 'DOCUMENT_TOO_LARGE'
  | 'BALANCES_UNAVAILABLE'
  | 'MAINNET_NOT_SUPPORTED'
  | 'UNSUPPORTED_CHAIN'
  | 'UNSUPPORTED_TOKEN'
  | 'UNSUPPORTED_REQUEST'
  | 'SPLIT_UNSUPPORTED'
  | 'RELATIVE_AMOUNT_NOT_ALLOWED'
  | 'GROUP_AUTOPAY_UNSUPPORTED'
  | 'UNTRUSTED_IN_AUTOPAY'
  | 'CHAIN_CONFLICT'
  | 'PAIRING_FAILED'
  | 'SELF_PAYMENT'
  | 'ENS_INDEXER_UNAVAILABLE'
  | 'GROUP_SENDS_OFF'
  | 'GROUP_EMPTY'
  | 'NO_ACTIVE_AUTOPAY'
  | 'AUTOPAY_NOT_READY'
  | 'AUTOPAY_NO_OCCURRENCES'
  | 'INSUFFICIENT_FUNDS'
  | 'NO_GAS'
  | 'CHAIN_NOT_ALLOWED'
  | 'LIMIT_PER_TX'
  | 'LIMIT_DAILY'
  | 'LIMIT_AUTOPAY_PERIOD'
  | 'LIMIT_AUTOPAY_DURATION'
  | 'LIMIT_BRIDGES'
  | 'TOO_MANY_RETRIES'
  | 'MODEL_FAILED'
  | 'EXECUTION_REJECTED'
  | 'EXECUTION_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'CANCELLED';

export const ERROR_CODES: readonly ErrorCode[] = [
  'SECRET_DETECTED',
  'ATTACHMENT_UNSUPPORTED',
  'URL_FETCH_FAILED',
  'LINKS_OFF',
  'DOCUMENT_TOO_LARGE',
  'BALANCES_UNAVAILABLE',
  'MAINNET_NOT_SUPPORTED',
  'UNSUPPORTED_CHAIN',
  'UNSUPPORTED_TOKEN',
  'UNSUPPORTED_REQUEST',
  'SPLIT_UNSUPPORTED',
  'RELATIVE_AMOUNT_NOT_ALLOWED',
  'GROUP_AUTOPAY_UNSUPPORTED',
  'UNTRUSTED_IN_AUTOPAY',
  'CHAIN_CONFLICT',
  'PAIRING_FAILED',
  'SELF_PAYMENT',
  'ENS_INDEXER_UNAVAILABLE',
  'GROUP_SENDS_OFF',
  'GROUP_EMPTY',
  'NO_ACTIVE_AUTOPAY',
  'AUTOPAY_NOT_READY',
  'AUTOPAY_NO_OCCURRENCES',
  'INSUFFICIENT_FUNDS',
  'NO_GAS',
  'CHAIN_NOT_ALLOWED',
  'LIMIT_PER_TX',
  'LIMIT_DAILY',
  'LIMIT_AUTOPAY_PERIOD',
  'LIMIT_AUTOPAY_DURATION',
  'LIMIT_BRIDGES',
  'TOO_MANY_RETRIES',
  'MODEL_FAILED',
  'EXECUTION_REJECTED',
  'EXECUTION_UNAVAILABLE',
  'INTERNAL_ERROR',
  'CANCELLED',
];

// ───────────────────────────── §8.0 request object ─────────────────────────────

export type RequestState =
  | 'RECEIVED'
  | 'BALANCES_REFRESHED'
  | 'GUARDED'
  | 'SCANNED'
  | 'AMOUNTS_MASKED'
  | 'TYPED'
  | 'SPANS_TAGGED'
  | 'RECIPIENTS_RESOLVED'
  | 'RECIPIENTS_MASKED'
  | 'PAIRED'
  | 'PLANNED'
  | 'VALIDATED'
  | 'AWAITING_CONFIRMATION'
  | 'HANDED_OFF'
  | 'HANDOFF_FAILED'
  | 'ANSWERED'
  | 'DISCARDED'
  | 'FAILED';

export type StepNameRef = 's0' | 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9' | 's10' | 's11' | 's12';

/** SQ-S-01: in-memory context for an amount correction after a pre-submission funding failure. */
export interface FailedPaymentContext {
  request_id: RequestId;
  recipient: AddressPh;
  token: Token;
  chain_id: ChainId | null;
  /** Preserve the original ENS chain restrictions when reusing a resolved recipient. */
  ens_chain_ids: ChainId[];
}

export interface AgentRequest {
  request_id: RequestId;
  session_id: SessionId;
  state: RequestState;
  /** Set while waiting for an answer. `step` is a StepName. */
  paused_at?: { step: StepNameRef; question: Question };
  /** After URL removal (S1). */
  typed_text: string;
  /** Q-LLM results (S1). */
  untrusted: QItem[];
  /** S2. Empty scan until S2 has run. */
  scan: LexicalScan;
  /** S3 (pay amounts only, with placeholders). */
  amounts: AmountItem[];
  request_type?: 'actions' | 'balance' | 'unsupported';
  actions?: ActionKind[];
  also_balance?: boolean;
  /** S5 (payees only after filtering). */
  spans: RecipientSpan[];
  /** S6/S7 (placeholders). */
  recipients: RecipientRef[];
  masked_text_s8?: string;
  /** S8 */
  payments?: Payment[];
  /** S9 */
  plan?: InternalIntent[];
  /** Summary notes collected along the way (texts from catalog NOTES). */
  notes: string[];
  /**
   * Set only by a "Yes" to Q_LIMIT_OVERRIDE (SQ-D-16, F-1…F-6): every broken DB5 limit is lifted for this request
   * only; DB5 is never written.
   */
  limit_override: boolean;
  /** Max 3. */
  handoff_attempts: number;

  // ── internal additions ──
  /** SQ-S-02: S2 decides whether this plain typed message refers to the immediately previous failed payment. */
  failed_payment_candidate?: FailedPaymentContext;
  /** SQ-S-01: only the immediately previous failed payment; never appended to DB8 history. */
  retry_context?: FailedPaymentContext;
  /** Raw message as received; S1 consumes it and sets it to undefined (dropped on SECRET_DETECTED). */
  input?: MessageInput;
  /** S3 output text (pay phrases → placeholders, context phrases → [amount]). */
  masked_text_s3?: string;
  /** S6 output aligned with `spans`. */
  resolved: ResolvedRecipient[];
  /**
   * S5 output (contracts-v3, CCR B-2 / C-1): the `role = 'mentioned'` spans (§8.6 rule 6), offsets in masked_text_s3.
   * Never looked up, never stored in any DB, never sent to a model; S7 replaces their text with `[person]` in
   * masked_text_s8 (§8.8).
   */
  mentioned_spans: Span[];
  /** S11 output, kept for confirmation. */
  summary?: Summary;
  /** S12: the envelope built on first "yes", reused on retries (§8.14 step 6). */
  envelope?: HandoffEnvelope;
  /** Messages to prepend to the next response (e.g. §13.3 "I dropped the previous plan…", also_balance answer). */
  prepend_messages: string[];
  /**
   * Per-step resumable progress (e.g. S6: which payee is being resolved, sub-flow, counters).
   * Each step owns its own slot and its own shape; the runner never reads it. `s9_answers` (SQ-R-05): S9's answers kept
   * after planning, so a re-plan at confirm time does not ask them again.
   */
  step_state: Partial<Record<StepNameRef | 's9_answers', unknown>>;
}

// ───────────────────────────── §13.1 summary, §14.1 AgentResponse ─────────────────────────────

export interface Summary {
  text: string;
  lines: string[];
  notes: string[];
  footer: string[];
}

export type ResponseState = 'awaiting_answer' | 'awaiting_confirmation' | 'done' | 'error';

export interface AgentResponse {
  session_id: string;
  request_id: string;
  state: ResponseState;
  messages: Array<{ type: 'text'; text: string }>;
  question?: Question;
  summary?: Summary;
  error?: { code: ErrorCode; message: string };
}

// ───────────────────────────── §14.3 execution reports ─────────────────────────────

export interface ExecutionReport {
  kind: 'intent_result' | 'autopay_payment' | 'autopay_status';
  request_id?: string;
  step?: number;
  status?: 'executed' | 'failed';
  tx_hash?: string;
  executed_at?: string;
  autopay?: {
    autopay_id: string;
    delegate_address?: string;
    cre_job_id?: string;
    status?: 'active' | 'cancelled' | 'ended' | 'failed';
    amount?: DecimalString;
    chain_id?: ChainId;
    token?: Token;
  };
}
