// Implements: §7.1 DB4 balances (persistent, overwritten each message), §8.1 steps 3–4 (upsert 'ok';
// unavailable keeps the old values). Owner: Lane A.

import type { Db4Balances, Db4Row } from '../../contracts/repos.js';
import type { ChainId, Token } from '../../contracts/types.js';
import type { Database } from '../database.js';

interface Raw {
  chain_id: number;
  chain: string;
  token: string;
  balance: string;
  base_units: string;
  status: string;
  updated_at: string;
}

const fromRaw = (r: Raw): Db4Row => ({
  chain_id: r.chain_id as ChainId,
  chain: r.chain,
  token: r.token as Token,
  balance: r.balance,
  base_units: r.base_units,
  status: r.status as Db4Row['status'],
  updated_at: r.updated_at,
});

export function createDb4(db: Database): Db4Balances {
  const upsert = db.prepare(
    `INSERT INTO db4_balances (chain_id, chain, token, balance, base_units, status, updated_at)
     VALUES (?, ?, ?, ?, ?, 'ok', ?)
     ON CONFLICT (chain_id, token) DO UPDATE SET
       chain = excluded.chain, balance = excluded.balance, base_units = excluded.base_units,
       status = 'ok', updated_at = excluded.updated_at`,
  );
  const markUnavail = db.prepare(
    `INSERT INTO db4_balances (chain_id, chain, token, balance, base_units, status, updated_at)
     VALUES (?, ?, ?, '0', '0', 'unavailable', ?)
     ON CONFLICT (chain_id, token) DO UPDATE SET status = 'unavailable', updated_at = excluded.updated_at`,
  );
  const getStmt = db.prepare('SELECT * FROM db4_balances WHERE chain_id = ? AND token = ?');
  const all = db.prepare('SELECT * FROM db4_balances ORDER BY chain_id, token');
  const markTx = db.transaction((chain_id: ChainId, chain: string, updated_at: string) => {
    for (const token of ['ETH', 'USDC'] as const) markUnavail.run(chain_id, chain, token, updated_at);
  });

  return {
    upsertOk(row, updated_at) {
      if (typeof row.balance !== 'string' || typeof row.base_units !== 'string') {
        throw new Error('db4: balance and base_units must be strings');
      }
      upsert.run(row.chain_id, row.chain, row.token, row.balance, row.base_units, updated_at);
    },
    markUnavailable(chain_id, chain, updated_at) {
      markTx(chain_id, chain, updated_at);
    },
    get(chain_id, token) {
      const r = getStmt.get(chain_id, token) as Raw | undefined;
      return r ? fromRaw(r) : undefined;
    },
    listAll: () => (all.all() as Raw[]).map(fromRaw),
  };
}
