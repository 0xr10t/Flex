// Implements: §5 database driver (`better-sqlite3-multiple-ciphers`, SQLCipher). Type alias shared by src/db/.
// Owner: Lane A.

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

export type Database = BetterSqlite3.Database;

/** §7: the database key, 32 bytes as lowercase hex. */
export const DB_KEY_RE = /^[0-9a-f]{64}$/;
