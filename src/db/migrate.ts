// Implements: §7.1 DDL applied from src/db/schema.sql (migrations), §21 db/migrate.ts.
// Owner: Lane A.

import { readFileSync } from 'node:fs';
import type { Database } from './database.js';

/** Schema version written to `PRAGMA user_version` after schema.sql has been applied. */
export const SCHEMA_VERSION = 3;

function readSchemaSql(): string {
  return readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
}

/** Applies schema.sql once (tracked with `PRAGMA user_version`). Idempotent. */
export function migrate(db: Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= SCHEMA_VERSION) return;
  db.transaction(() => {
    if (version < 1) db.exec(readSchemaSql());
    if (version < 2)
      db.exec(`CREATE TABLE handoff_journal (
      request_id TEXT PRIMARY KEY,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'accepted', 'rejected')),
      history_json TEXT
    )`);
    if (version < 3) {
      // Preserve v1 history, including prefunds and delegate metadata. Only new submissions use v2 semantics.
      db.exec(`
        ALTER TABLE db7_autopays ADD COLUMN plan_id TEXT;
        ALTER TABLE db7_autopays ADD COLUMN executor_address TEXT;
        ALTER TABLE db7_autopays ADD COLUMN fee TEXT;
        ALTER TABLE db7_autopays ADD COLUMN recipients_json TEXT;
        ALTER TABLE db7_autopays ADD COLUMN display_json TEXT;
        ALTER TABLE db6_spend_log RENAME TO db6_spend_log_v1;
        CREATE TABLE db6_spend_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, step INTEGER,
          kind TEXT NOT NULL CHECK (kind IN ('payment','bridge_out','bridge_buffer','bridge_fee','autopay_prefund','autopay_payment','autopay_fee')),
          counts_toward_limit INTEGER NOT NULL CHECK (counts_toward_limit IN (0,1)),
          chain_id INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, recipient_address TEXT,
          intent_id TEXT, autopay_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending','executed','failed')),
          tx_hash TEXT, created_at TEXT NOT NULL, executed_at TEXT, autopay_slot INTEGER
        );
        INSERT INTO db6_spend_log SELECT *, NULL FROM db6_spend_log_v1;
        DROP TABLE db6_spend_log_v1;
        CREATE UNIQUE INDEX db6_autopay_run ON db6_spend_log(autopay_id, autopay_slot, kind)
          WHERE autopay_slot IS NOT NULL;
      `);
    }
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
