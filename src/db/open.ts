// Implements: §7 "On open, run" the five pragmas (cipher, key, secure_delete, foreign_keys, journal_mode=WAL),
// §7.1 migrations, NFR-05 one SQLCipher file with the key from the keychain.
// Owner: Lane A.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import BetterSqlite3 from 'better-sqlite3-multiple-ciphers';
import type { Database } from './database.js';
import { migrate } from './migrate.js';

export type { Database } from './database.js';

const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Opens (creating if needed) the SQLCipher file at `path` with the §7 pragmas, in this order:
 * `cipher = 'sqlcipher'`, `key = '<hex key>'`, `secure_delete = ON`, `foreign_keys = ON`, `journal_mode = WAL`,
 * then runs the migrations. Throws if the key is wrong (the first read fails with SQLITE_NOTADB).
 */
export function openDatabase(path: string, keyHex: string): Database {
  // The key is interpolated into a PRAGMA, so it must be exactly 64 lowercase hex characters.
  if (!KEY_RE.test(keyHex)) throw new Error('database key must be 32 bytes of lowercase hex');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new BetterSqlite3(path);
  try {
    db.pragma(`cipher = 'sqlcipher'`);
    db.pragma(`key = '${keyHex}'`);
    db.pragma('secure_delete = ON');
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
