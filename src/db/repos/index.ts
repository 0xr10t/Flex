// Implements: §7.1 repositories for DB1–DB8 (the only code that touches SQL, §21), §7.4 session clearing (one
// transaction deleting every row of DB1, DB3, db8_prompts, db8_history, db8_sessions, then VACUUM; DB2, DB4–DB7
// untouched), §16.4 secure_delete + VACUUM after session clears. Owner: Lane A.

import type { Repos } from '../../contracts/repos.js';
import type { ChainId } from '../../contracts/types.js';
import { newPlaceholder } from '../../util/ids.js';
import type { Database } from '../database.js';
import type { RepoOptions } from './common.js';
import { createDb1 } from './db1.js';
import { createDb2 } from './db2.js';
import { createDb3 } from './db3.js';
import { createDb4 } from './db4.js';
import { createDb5 } from './db5.js';
import { createDb6 } from './db6.js';
import { createDb7 } from './db7.js';
import { createDb8 } from './db8.js';
import { createHandoffs } from './handoffs.js';

export { PlaceholderCollisionError, MAX_PLACEHOLDER_DRAWS, type RepoOptions } from './common.js';

/** §6.1 example chain display names; main() passes the configured names instead. */
const DEFAULT_CHAIN_NAMES: Record<ChainId, string> = {
  11155111: 'Sepolia',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
};

/** §7.4 statements, in the order the spec lists them. */
const SESSION_CLEAR_SQL: readonly string[] = [
  'DELETE FROM db1_amount_placeholders',
  'DELETE FROM db3_address_placeholders',
  'DELETE FROM db8_prompts',
  'DELETE FROM db8_history',
  'DELETE FROM db8_sessions',
];

export function createRepos(db: Database, options: Partial<RepoOptions> = {}): Repos {
  const opts: RepoOptions = {
    newPlaceholder: options.newPlaceholder ?? newPlaceholder,
    now: options.now ?? (() => new Date().toISOString()),
    chainName: options.chainName ?? ((id) => DEFAULT_CHAIN_NAMES[id]),
  };
  const clearStmts = SESSION_CLEAR_SQL.map((sql) => db.prepare(sql));
  const clearTx = db.transaction(() => {
    for (const s of clearStmts) s.run();
    db.prepare('UPDATE handoff_journal SET history_json = NULL WHERE history_json IS NOT NULL').run();
  });

  return {
    db1: createDb1(db, opts),
    db2: createDb2(db, opts),
    db3: createDb3(db, opts),
    db4: createDb4(db),
    db5: createDb5(db),
    db6: createDb6(db),
    db7: createDb7(db),
    db8: createDb8(db),
    handoffs: createHandoffs(db),
    clearSessionStores() {
      // secure_delete is ON for the connection (§7), so deleted content is overwritten; VACUUM then rebuilds the file.
      // With journal_mode=WAL, deleted pages can linger in the -wal file, so checkpoint and truncate it (§16.4).
      clearTx();
      db.exec('VACUUM');
      db.pragma('wal_checkpoint(TRUNCATE)');
    },
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },
  };
}
