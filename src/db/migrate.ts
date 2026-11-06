// Implements: §7.1 DDL applied from src/db/schema.sql (migrations), §21 db/migrate.ts.
// Owner: Lane A.

import { readFileSync } from 'node:fs';
import type { Database } from './database.js';

/** Schema version written to `PRAGMA user_version` after schema.sql has been applied. */
export const SCHEMA_VERSION = 2;

export function readSchemaSql(): string {
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
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  })();
}
