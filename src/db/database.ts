// Implements: §5 database driver (`better-sqlite3-multiple-ciphers`, SQLCipher). Type alias shared by src/db/.
// Owner: Lane A.

import type BetterSqlite3 from 'better-sqlite3-multiple-ciphers';

export type Database = BetterSqlite3.Database;
