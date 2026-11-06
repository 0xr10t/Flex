// Implements: §14.2 rule 7 (a repeated key executes nothing twice, across restarts) and rule 8 (every outcome reported).
// OQ-04 (provisional): SQLCipher, opened like the agent's database. Envelopes hold amounts and addresses, so the file is
// encrypted. A step's result and its report are written in one transaction, so neither can exist without the other.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import type { Database } from 'better-sqlite3';
import type { HandoffEnvelope, Hex } from '@flex/protocol/schemas/envelope';
import type { WalletBatchRow, WalletBatchPayload } from '../browser/types.js';

export type StepStatus = 'pending' | 'approved' | 'signed' | 'waiting' | 'executed' | 'failed';
export type ReportStatus = 'pending' | 'delivered' | 'abandoned';

export interface StepRow {
  request_id: string;
  step: number;
  status: StepStatus;
  raw_tx: Hex | null;
  tx_hash: Hex | null;
  nonce: number | null;
  error_code: string | null;
  executed_at: string | null;
  data_json: string | null;
}

export type AutopayStatus = 'draft' | 'active' | 'cancelled' | 'ended';

/** Part 7's record of one plan. The chain's `Executed` event carries no amounts, so Part 10 joins on this. */
export interface AutopayRow {
  plan_id: Hex;
  request_id: string;
  step: number;
  autopay_id: string;
  chain_id: number;
  executor: Hex;
  token: string;
  amount: string;
  fee: string;
  delegation_json: string;
  redeem: Hex;
  end_at: number;
  status: AutopayStatus;
  registered_block: number | null;
}

export interface ReportRow {
  id: number;
  request_id: string;
  step: number | null;
  body_json: string;
  status: ReportStatus;
  attempts: number;
  next_attempt_at: number;
}

export interface StepResult {
  status: 'executed' | 'failed';
  tx_hash?: Hex;
  executed_at?: string;
  error_code?: string;
  /** Extra §14.3 fields: `autopay`, `bridge_fee_eth`. */
  report?: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE requests (
  request_id    TEXT PRIMARY KEY,
  envelope_json TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE TABLE steps (
  request_id  TEXT NOT NULL REFERENCES requests(request_id),
  step        INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','signed','waiting','executed','failed')),
  raw_tx      TEXT,
  tx_hash     TEXT,
  nonce       INTEGER,
  error_code  TEXT,
  executed_at TEXT,
  data_json   TEXT,
  PRIMARY KEY (request_id, step)
);
CREATE TABLE reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id      TEXT NOT NULL REFERENCES requests(request_id),
  step            INTEGER,
  dedupe_key      TEXT NOT NULL UNIQUE,
  body_json       TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','delivered','abandoned')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL
);
CREATE TABLE autopays (
  plan_id          TEXT PRIMARY KEY,
  request_id       TEXT NOT NULL REFERENCES requests(request_id),
  step             INTEGER NOT NULL,
  autopay_id       TEXT NOT NULL,
  chain_id         INTEGER NOT NULL,
  executor         TEXT NOT NULL,
  token            TEXT NOT NULL,
  amount           TEXT NOT NULL,
  fee              TEXT NOT NULL,
  delegation_json  TEXT NOT NULL,
  redeem           TEXT NOT NULL,
  end_at           INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft','active','cancelled','ended')),
  registered_block INTEGER,
  UNIQUE (request_id, step)
);
CREATE TABLE watch_cursors (
  chain_id   INTEGER PRIMARY KEY,
  last_block INTEGER NOT NULL
);
`;

const BROWSER_SCHEMA = `
CREATE TABLE wallet_batches (
  request_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  chain_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','dispatched','received','rejected')),
  created_ms INTEGER NOT NULL,
  tx_hash TEXT,
  PRIMARY KEY (request_id, step),
  UNIQUE (chain_id, tx_hash),
  FOREIGN KEY (request_id, step) REFERENCES steps(request_id, step)
);`;

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
        )
      : value;

/** Same content gives the same hash, whatever the key order. */
export const envelopeHash = (envelope: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(envelope)))
    .digest('hex');

export function openDatabase(path: string, keyHex: string): Database {
  // The key goes into a PRAGMA, which takes no bound parameters, so its format is checked first.
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('database key must be 32 bytes of lowercase hex');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new BetterSqlite3(path);
  try {
    db.pragma(`cipher = 'sqlcipher'`);
    db.pragma(`key = '${keyHex}'`);
    db.pragma('secure_delete = ON');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    if (db.pragma('user_version', { simple: true }) === 0) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.pragma('user_version = 1');
      })();
    }
    if (db.pragma('user_version', { simple: true }) === 1) {
      db.transaction(() => {
        db.exec(BROWSER_SCHEMA);
        db.pragma('user_version = 2');
      })();
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export class Store {
  constructor(private readonly db: Database) {}

  /** The hash stored for this request, or null when the key is new. */
  storedHash(requestId: string): string | null {
    const row = this.db.prepare('SELECT envelope_hash FROM requests WHERE request_id = ?').get(requestId) as
      { envelope_hash: string } | undefined;
    return row?.envelope_hash ?? null;
  }

  envelope(requestId: string): HandoffEnvelope | null {
    const row = this.db.prepare('SELECT envelope_json FROM requests WHERE request_id = ?').get(requestId) as
      { envelope_json: string } | undefined;
    return row ? (JSON.parse(row.envelope_json) as HandoffEnvelope) : null;
  }

  walletBatch(requestId: string, step: number): WalletBatchRow | null {
    return (
      (this.db.prepare('SELECT * FROM wallet_batches WHERE request_id = ? AND step = ?').get(requestId, step) as
        WalletBatchRow | undefined) ?? null
    );
  }

  walletBatchById(id: string): WalletBatchRow | null {
    return (
      (this.db.prepare('SELECT * FROM wallet_batches WHERE batch_id = ?').get(id) as WalletBatchRow | undefined) ?? null
    );
  }

  walletBatches(): WalletBatchRow[] {
    return this.db.prepare('SELECT * FROM wallet_batches ORDER BY created_ms DESC LIMIT 100').all() as WalletBatchRow[];
  }

  rememberWalletBatchId(id: string, providerId: string): boolean {
    return this.db.transaction(() => {
      const row = this.walletBatchById(id);
      if (!row || !['dispatched', 'received'].includes(row.status)) return false;
      const payload = JSON.parse(row.payload_json) as WalletBatchPayload;
      if (payload.providerBatchId && payload.providerBatchId !== providerId) return false;
      payload.providerBatchId = providerId;
      this.db.prepare('UPDATE wallet_batches SET payload_json=? WHERE batch_id=?').run(JSON.stringify(payload), id);
      return true;
    })();
  }

  saveWalletBatch(requestId: string, step: number, chainId: number, payload: WalletBatchPayload, now: number): void {
    this.db
      .prepare(
        `INSERT INTO wallet_batches (request_id, step, batch_id, chain_id, payload_json, status, created_ms)
      VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
      )
      .run(requestId, step, payload.calls.id, chainId, JSON.stringify(payload), now);
  }

  /** Commit dispatch before returning any executable payload to the browser. A second tab cannot dispatch again. */
  claimWalletBatch(id: string, now: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE wallet_batches SET status = 'dispatched'
      WHERE batch_id = ? AND status = 'draft' AND created_ms >= ? AND NOT EXISTS (
        SELECT 1 FROM wallet_batches b JOIN steps s ON s.request_id=b.request_id AND s.step=b.step
        WHERE b.chain_id=wallet_batches.chain_id AND b.batch_id<>wallet_batches.batch_id
          AND b.status IN ('dispatched','received') AND s.status='approved')`,
        )
        .run(id, now - 60_000).changes === 1
    );
  }

  deleteDraftWalletBatch(id: string): boolean {
    return this.db.prepare("DELETE FROM wallet_batches WHERE batch_id = ? AND status = 'draft'").run(id).changes === 1;
  }

  rejectWalletBatch(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE wallet_batches SET status='rejected' WHERE batch_id=? AND status IN ('draft','dispatched') AND tx_hash IS NULL",
        )
        .run(id).changes === 1
    );
  }

  receiveWalletBatch(id: string, hash: Hex): boolean {
    return this.db.transaction(() => {
      const row = this.walletBatchById(id);
      if (!row || !['dispatched', 'received'].includes(row.status) || (row.tx_hash && row.tx_hash !== hash))
        return false;
      this.db.prepare("UPDATE wallet_batches SET status='received', tx_hash=? WHERE batch_id=?").run(hash, id);
      this.db
        .prepare("UPDATE steps SET tx_hash=? WHERE request_id=? AND step=? AND status='approved'")
        .run(hash, row.request_id, row.step);
      return true;
    })();
  }

  markWalletWaiting(requestId: string, step: number, data: unknown): void {
    this.db
      .prepare(
        "UPDATE steps SET status='waiting', data_json=? WHERE request_id=? AND step=? AND status='approved' AND tx_hash IS NOT NULL",
      )
      .run(JSON.stringify(data), requestId, step);
  }

  insertRequest(envelope: HandoffEnvelope, now: string): void {
    const insertRequest = this.db.prepare(
      'INSERT INTO requests (request_id, envelope_json, envelope_hash, created_at) VALUES (?, ?, ?, ?)',
    );
    const insertStep = this.db.prepare(`INSERT INTO steps (request_id, step, status) VALUES (?, ?, 'pending')`);
    this.db.transaction(() => {
      insertRequest.run(envelope.request_id, JSON.stringify(envelope), envelopeHash(envelope), now);
      for (const intent of envelope.intents) insertStep.run(envelope.request_id, intent.step);
    })();
  }

  /** The oldest request that isn't finished. Requests run one at a time, in the order they arrived. */
  nextUnfinished(): HandoffEnvelope | null {
    const row = this.db
      .prepare('SELECT envelope_json FROM requests WHERE finished_at IS NULL ORDER BY rowid LIMIT 1')
      .get() as { envelope_json: string } | undefined;
    return row ? (JSON.parse(row.envelope_json) as HandoffEnvelope) : null;
  }

  /** A stable pass through pending requests; a settled bridge must not monopolize execution. */
  unfinishedRequests(): HandoffEnvelope[] {
    const rows = this.db
      .prepare('SELECT envelope_json FROM requests WHERE finished_at IS NULL ORDER BY rowid')
      .all() as { envelope_json: string }[];
    return rows.map((row) => JSON.parse(row.envelope_json) as HandoffEnvelope);
  }

  recentRequests(): HandoffEnvelope[] {
    const rows = this.db.prepare('SELECT envelope_json FROM requests ORDER BY rowid DESC LIMIT 100').all() as {
      envelope_json: string;
    }[];
    return rows.map((row) => JSON.parse(row.envelope_json) as HandoffEnvelope);
  }

  step(requestId: string, step: number): StepRow {
    const row = this.db.prepare('SELECT * FROM steps WHERE request_id = ? AND step = ?').get(requestId, step) as
      StepRow | undefined;
    if (!row) throw new Error('step not found');
    return row;
  }

  stepsOf(requestId: string): StepRow[] {
    return this.db.prepare('SELECT * FROM steps WHERE request_id = ? ORDER BY step').all(requestId) as StepRow[];
  }

  markApproved(requestId: string, step: number): void {
    this.db
      .prepare(`UPDATE steps SET status = 'approved' WHERE request_id = ? AND step = ? AND status = 'pending'`)
      .run(requestId, step);
  }

  /** Saved before the transaction is sent, so a crash can never lead to signing a second one. */
  saveSigned(requestId: string, step: number, tx: { raw: Hex; hash: Hex; nonce: number }): void {
    this.db
      .prepare(
        `UPDATE steps SET status = 'signed', raw_tx = ?, tx_hash = ?, nonce = ?
         WHERE request_id = ? AND step = ? AND status = 'approved'`,
      )
      .run(tx.raw, tx.hash, tx.nonce, requestId, step);
  }

  /** Runs `work` so that everything in it is saved together, or nothing is. */
  transaction(work: () => void): void {
    this.db.transaction(work)();
  }

  saveStepData(requestId: string, step: number, data: unknown): void {
    this.db
      .prepare('UPDATE steps SET data_json = ? WHERE request_id = ? AND step = ?')
      .run(JSON.stringify(data), requestId, step);
  }

  stepData<T>(requestId: string, step: number): T | null {
    const raw = this.step(requestId, step).data_json;
    return raw === null ? null : (JSON.parse(raw) as T);
  }

  /** A step that has sent its transaction and waits for something else, such as a bridge arriving. */
  markWaiting(requestId: string, step: number, data: unknown): void {
    this.db
      .prepare(
        `UPDATE steps SET status = 'waiting', data_json = ? WHERE request_id = ? AND step = ? AND status = 'signed'`,
      )
      .run(JSON.stringify(data), requestId, step);
  }

  autopayByStep(requestId: string, step: number): AutopayRow | null {
    return (
      (this.db.prepare('SELECT * FROM autopays WHERE request_id = ? AND step = ?').get(requestId, step) as
        AutopayRow | undefined) ?? null
    );
  }

  autopayByPlan(planId: Hex): AutopayRow | null {
    return (this.db.prepare('SELECT * FROM autopays WHERE plan_id = ?').get(planId) as AutopayRow | undefined) ?? null;
  }

  /** Saved before `register` is sent, so a crash reuses this signature and can't create a second live plan (OQ-09). */
  saveAutopayDraft(row: Omit<AutopayRow, 'status' | 'registered_block'>): void {
    this.db
      .prepare(
        `INSERT INTO autopays (plan_id, request_id, step, autopay_id, chain_id, executor, token, amount, fee,
           delegation_json, redeem, end_at, status)
         VALUES (@plan_id, @request_id, @step, @autopay_id, @chain_id, @executor, @token, @amount, @fee,
           @delegation_json, @redeem, @end_at, 'draft')`,
      )
      .run(row);
  }

  /** Marks a plan live. The cursor moves back if needed, so a run in the same block range can't be missed. */
  activateAutopay(planId: Hex, registeredBlock: number): void {
    this.db
      .prepare(`UPDATE autopays SET status = 'active', registered_block = ? WHERE plan_id = ?`)
      .run(registeredBlock, planId);
    const row = this.autopayByPlan(planId);
    if (row) {
      this.db
        .prepare(`UPDATE watch_cursors SET last_block = MIN(last_block, ?) WHERE chain_id = ?`)
        .run(registeredBlock - 1, row.chain_id);
    }
  }

  setAutopayStatus(planId: Hex, status: 'cancelled' | 'ended'): void {
    this.db.prepare('UPDATE autopays SET status = ? WHERE plan_id = ?').run(status, planId);
  }

  /** Every plan that has been live on this chain. A cancelled plan still counts, for runs paid before the cancel. */
  watchedPlans(chainId: number): AutopayRow[] {
    return this.db
      .prepare(`SELECT * FROM autopays WHERE chain_id = ? AND status <> 'draft' ORDER BY rowid`)
      .all(chainId) as AutopayRow[];
  }

  watchCursor(chainId: number): number | null {
    const row = this.db.prepare('SELECT last_block FROM watch_cursors WHERE chain_id = ?').get(chainId) as
      { last_block: number } | undefined;
    return row?.last_block ?? null;
  }

  setWatchCursor(chainId: number, block: number): void {
    this.db
      .prepare(
        `INSERT INTO watch_cursors (chain_id, last_block) VALUES (?, ?)
         ON CONFLICT (chain_id) DO UPDATE SET last_block = excluded.last_block`,
      )
      .run(chainId, block);
  }

  /** Queues a report unless one with this key exists. So a rescan of the chain can't report a run twice. */
  queueReport(requestId: string, step: number | null, dedupeKey: string, body: unknown, nowMs: number): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO reports (request_id, step, dedupe_key, body_json, status, next_attempt_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(requestId, step, dedupeKey, JSON.stringify(body), nowMs);
    return result.changes === 1;
  }

  /** Stores a step's outcome and its report together, and closes the request when this was its last open step. */
  finishStep(requestId: string, step: number, outcome: StepResult, now: string, nowMs: number): void {
    const report = {
      kind: 'intent_result',
      request_id: requestId,
      step,
      status: outcome.status,
      ...(outcome.tx_hash ? { tx_hash: outcome.tx_hash } : {}),
      ...(outcome.executed_at ? { executed_at: outcome.executed_at } : {}),
      ...outcome.report,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE steps SET status = ?, tx_hash = COALESCE(?, tx_hash), error_code = ?, executed_at = ?
           WHERE request_id = ? AND step = ?`,
        )
        .run(
          outcome.status,
          outcome.tx_hash ?? null,
          outcome.error_code ?? null,
          outcome.executed_at ?? null,
          requestId,
          step,
        );
      this.db
        .prepare(
          `INSERT INTO reports (request_id, step, dedupe_key, body_json, status, next_attempt_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        )
        .run(requestId, step, `step:${requestId}:${step}`, JSON.stringify(report), nowMs);
      this.db
        .prepare(
          `UPDATE requests SET finished_at = ? WHERE request_id = ? AND NOT EXISTS (
             SELECT 1 FROM steps WHERE request_id = ? AND status NOT IN ('executed','failed'))`,
        )
        .run(now, requestId, requestId);
    })();
  }

  dueReports(nowMs: number): ReportRow[] {
    return this.db
      .prepare(`SELECT * FROM reports WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id`)
      .all(nowMs) as ReportRow[];
  }

  /** When the next waiting report is due, or null when none are waiting. */
  nextReportTime(): number | null {
    const row = this.db.prepare(`SELECT MIN(next_attempt_at) AS at FROM reports WHERE status = 'pending'`).get() as {
      at: number | null;
    };
    return row.at;
  }

  allReports(): ReportRow[] {
    return this.db.prepare('SELECT * FROM reports ORDER BY id').all() as ReportRow[];
  }

  closeReport(id: number, status: 'delivered' | 'abandoned'): void {
    this.db.prepare('UPDATE reports SET status = ?, attempts = attempts + 1 WHERE id = ?').run(status, id);
  }

  retryReport(id: number, nextAttemptAt: number): void {
    this.db
      .prepare('UPDATE reports SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?')
      .run(nextAttemptAt, id);
  }
}
