// Implements: §7.1 tables as repository interfaces, §7.2 read/write rights, §7.3 placeholder minting with
// collision retry, §7.4 session clearing, §9.2 step 7 add_contact transaction + DB2 invariant,
// §10.1 pending-recent window, §11.3 V-15 spent-today rule.
// Owned by the Orchestrator (frozen contract). Lane A implements against SQLCipher; everyone else uses
// test/fakes/repos.ts. All methods are synchronous (better-sqlite3 is synchronous).

import type {
  Address,
  AddressPh,
  AmountOrigin,
  AmountPh,
  AmountSource,
  AutopayId,
  ChainId,
  DecimalString,
  GroupPh,
  HandoffEnvelope,
  Limits,
  RecipientPh,
  RecipientSource,
  Token,
} from './types.js';

// ───────────────────────────── DB1 ─────────────────────────────

export interface Db1Row {
  placeholder: AmountPh;
  session_id: string;
  request_id: string;
  amount: DecimalString;
  token: Token;
  source: AmountSource;
  origin: AmountOrigin;
  confirmed: boolean;
  created_at: string;
}

export interface Db1AmountPlaceholders {
  /** Draws a fresh `amount_<8hex>` (retry ≤ 5 on PK collision, §7.3) and inserts the row. */
  mint(row: Omit<Db1Row, 'placeholder' | 'created_at'>): AmountPh;
  get(placeholder: AmountPh): Db1Row | undefined;
  listByRequest(request_id: string): Db1Row[];
  /** Used by Q_UNTRUSTED_AMOUNT / answer handlers (confirm, or replace with a user value). */
  update(placeholder: AmountPh, patch: Partial<Pick<Db1Row, 'amount' | 'token' | 'source' | 'confirmed'>>): void;
}

// ───────────────────────────── DB2 ─────────────────────────────

export interface Db2Row {
  id: number;
  name: string;
  name_key: string;
  chain_id: ChainId;
  chain: string;
  address: Address;
  ens_name: string | null;
  added_at: string;
  added_by: 'user_confirmed';
}

export type AddContactResult =
  | { ok: true; rows: Db2Row[] }
  /** name_key already used for another address, or address already saved under another name (§7.1 invariant). */
  | { ok: false; reason: 'name_taken' | 'address_has_other_name' };

export interface Db2AddressBook {
  findByNameKey(name_key: string): Db2Row[];
  findByAddress(address: Address): Db2Row[];
  findByEnsName(ens_name: string): Db2Row[];
  /** All rows (for Levenshtein close-contact chips, §9.1 step 4). */
  listAll(): Db2Row[];
  /**
   * add_contact (§9.2 step 7, §9.3 step 7): one transaction inserting one row per chain in `chain_ids`,
   * `added_by='user_confirmed'`, enforcing the §7.1 invariant. The only DB2 insert path.
   */
  addContact(args: { name: string; address: Address; chain_ids: ChainId[]; ens_name: string | null }): AddContactResult;
  /** Q_ENS_CHANGED "Use new address" (§9.4): update the address on every row of this name_key, invariant enforced. */
  updateAddressForName(name_key: string, address: Address): AddContactResult;
}

// ───────────────────────────── DB3 ─────────────────────────────

export interface Db3Row {
  placeholder: RecipientPh;
  session_id: string;
  request_id: string;
  kind: 'single' | 'group' | 'member';
  name: string | null;
  address: Address | null;
  ens_name: string | null;
  chain_id: ChainId | null;
  group_placeholder: GroupPh | null;
  source: RecipientSource;
  reused_from_chain_id: ChainId | null;
  created_at: string;
}

export interface Db3AddressPlaceholders {
  /** kind 'group' → `group_<8hex>`, else `address_<8hex>` (retry ≤ 5 on collision, §7.3). */
  mint(row: Omit<Db3Row, 'placeholder' | 'created_at' | 'reused_from_chain_id'>): RecipientPh;
  get(placeholder: RecipientPh): Db3Row | undefined;
  /** Member rows of a group, in insertion order. */
  listMembers(group_placeholder: GroupPh): Db3Row[];
  /** §9.5 silent reuse marking (S9). */
  setReusedFromChain(placeholder: AddressPh, chain_id: ChainId): void;
}

// ───────────────────────────── DB4 ─────────────────────────────

export interface Db4Row {
  chain_id: ChainId;
  chain: string;
  token: Token;
  balance: DecimalString;
  base_units: string;
  status: 'ok' | 'unavailable';
  updated_at: string;
}

export interface Db4Balances {
  /** Upsert with status 'ok' (§8.1 step 3). */
  upsertOk(row: Omit<Db4Row, 'status' | 'updated_at'>, updated_at: string): void;
  /** Both token rows of the chain → 'unavailable', old values kept (§8.1 step 4). Creates rows if missing. */
  markUnavailable(chain_id: ChainId, chain: string, updated_at: string): void;
  get(chain_id: ChainId, token: Token): Db4Row | undefined;
  listAll(): Db4Row[];
}

// ───────────────────────────── DB5 ─────────────────────────────

export interface Db5Limits {
  /** §6.3: insert any missing key with its default (first run). */
  insertDefaultsIfMissing(now: string): void;
  getAll(): Limits;
  /** Only caller: PUT /v1/settings/limits (§7.2, §16.4). */
  putAll(limits: Limits, now: string): void;
}

// ───────────────────────────── DB6 ─────────────────────────────

/** autopay_prefund is retained only for historical v1 records. */
export type Db6Kind = 'payment' | 'bridge_out' | 'bridge_buffer' | 'bridge_fee' | 'autopay_prefund' | 'autopay_payment' | 'autopay_fee';

export interface Db6Row {
  id: number;
  request_id: string;
  step: number | null;
  kind: Db6Kind;
  counts_toward_limit: boolean;
  chain_id: ChainId;
  token: Token;
  amount: DecimalString;
  recipient_address: Address | null;
  intent_id: 'i' | 'j' | 'k' | null;
  autopay_id: AutopayId | null;
  autopay_slot?: number | null;
  status: 'pending' | 'executed' | 'failed';
  tx_hash: string | null;
  created_at: string;
  executed_at: string | null;
}

export type Db6Insert = Omit<Db6Row, 'id'>;

export interface Db6SpendLog {
  insertMany(rows: Db6Insert[]): void;
  hasRequest(request_id: string): boolean;
  listByRequest(request_id: string): Db6Row[];
  /** SQ-R-04: a row with this tx_hash exists (compared case-insensitively). */
  hasTxHash(tx_hash: string): boolean;
  /** §14.3 intent_result: update rows with this request_id and step. Returns rows changed. */
  applyIntentResult(args: {
    request_id: string;
    step: number;
    status: 'executed' | 'failed';
    tx_hash: string | null;
    executed_at: string | null;
    bridge_fee_eth?: string;
  }): number;
  /**
   * §10.1: rows with status 'pending', created_at > now − 10 min, this chain and token,
   * kind IN ('payment','bridge_out','autopay_prefund'). Caller sums with bigint.
   */
  pendingRecent(chain_id: ChainId, token: Token, now_utc: string): Db6Row[];
  /**
   * §11.3 V-15: rows with counts_toward_limit=1, this token, and
   * (status='pending' AND local date of created_at = today) OR (status='executed' AND local date of executed_at = today),
   * "today" = the calendar date of `now_utc` in `timezone`. Caller sums with bigint.
   */
  spentToday(token: Token, timezone: string, now_utc: string): Db6Row[];
}

// ───────────────────────────── DB7 ─────────────────────────────

export type Db7Status = 'pending' | 'active' | 'cancelled' | 'ended' | 'failed';

export interface Db7Row {
  autopay_id: AutopayId;
  request_id: string;
  recipient_name: string;
  recipient_address: Address;
  chain_id: ChainId;
  token: Token;
  amount_per_payment: DecimalString;
  /** JSON of the §12.5 schedule object. */
  schedule_json: string;
  delegate_address: Address | null;
  cre_job_id: string | null;
  /** Nullable for historical v1 registrations; never invent a v2 identity for those rows. */
  plan_id?: Address | null;
  executor_address?: Address | null;
  fee?: DecimalString | null;
  recipients_json?: string | null;
  display_json?: string | null;
  status: Db7Status;
  created_at: string;
  updated_at: string;
}

export interface Db7Autopays {
  insertPending(
    row: Omit<Db7Row, 'status' | 'created_at' | 'updated_at' | 'delegate_address' | 'cre_job_id'>,
    now: string,
  ): void;
  get(autopay_id: string): Db7Row | undefined;
  /** find_autopays (§10.7): rows for this recipient address, optionally filtered by status. */
  findByRecipient(address: Address, status?: Db7Status): Db7Row[];
  /** Rows created by this request (for §14.3 intent_result on a k/l step). */
  listByRequest(request_id: string): Db7Row[];
  update(
    autopay_id: string,
    patch: Partial<Pick<Db7Row, 'status' | 'delegate_address' | 'cre_job_id' | 'plan_id' | 'executor_address'>>,
    now: string,
  ): void;
}

// ───────────────────────────── DB8 ─────────────────────────────

export interface Db8SessionRow {
  session_id: string;
  timezone: string;
  opened_at: string;
}

export interface Db8HistoryRow {
  id: number;
  session_id: string;
  request_id: string;
  /** JSON of the S8 payments (placeholders only). */
  payments_json: string;
  handed_off_at: string;
}

export interface Db8Session {
  insertSession(row: Db8SessionRow): void;
  getSession(session_id: string): Db8SessionRow | undefined;
  insertPrompt(row: {
    session_id: string;
    request_id: string;
    kind: 'typed' | 'pasted' | 'answer';
    text: string;
    created_at: string;
  }): void;
  appendHistory(row: Omit<Db8HistoryRow, 'id'>): void;
  /** R1-F3: this request was handed off in this session (it has a db8_history row). */
  hasHistory(session_id: string, request_id: string): boolean;
  /** §17.2 step 1: last `limit` (5) handed-off requests in this session, most recent first. */
  recentHistory(session_id: string, limit: number): Db8HistoryRow[];
}

// ───────────────────────────── Aggregate ─────────────────────────────

/** Confirmed submissions survive session clearing and ambiguous transport failures. */
export interface HandoffJournalRow {
  request_id: string;
  envelope: HandoffEnvelope;
  status: 'submitted' | 'accepted' | 'rejected';
  /** Session-only follow-up data: cleared on acceptance or session close. */
  history: Omit<Db8HistoryRow, 'id'> | null;
}

export interface HandoffJournal {
  insert(row: HandoffJournalRow): void;
  get(request_id: string): HandoffJournalRow | undefined;
  update(request_id: string, patch: Partial<Pick<HandoffJournalRow, 'status' | 'history'>>): void;
}

export interface Repos {
  db1: Db1AmountPlaceholders;
  db2: Db2AddressBook;
  db3: Db3AddressPlaceholders;
  db4: Db4Balances;
  db5: Db5Limits;
  db6: Db6SpendLog;
  db7: Db7Autopays;
  db8: Db8Session;
  handoffs: HandoffJournal;
  /**
   * §7.4: in one transaction delete every row of DB1, DB3, db8_prompts, db8_history, db8_sessions; then VACUUM.
   * DB2, DB4–DB7 untouched.
   */
  clearSessionStores(): void;
  /** Run `fn` in one SQL transaction. */
  transaction<T>(fn: () => T): T;
}
