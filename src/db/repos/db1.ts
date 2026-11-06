// Implements: §7.1 DB1 amount placeholders (session-scoped), §7.3 placeholder minting with collision retry,
// §7 amounts stored as decimal strings. Owner: Lane A.

import type { Db1AmountPlaceholders, Db1Row } from '../../contracts/repos.js';
import type { AmountOrigin, AmountPh, AmountSource, Token } from '../../contracts/types.js';
import type { Database } from '../database.js';
import { mintWithRetry, toBool, toInt, type RepoOptions } from './common.js';

interface Raw {
  placeholder: string;
  session_id: string;
  request_id: string;
  amount: string;
  token: string;
  source: string;
  origin: string;
  confirmed: number;
  created_at: string;
}

const fromRaw = (r: Raw): Db1Row => ({
  placeholder: r.placeholder as AmountPh,
  session_id: r.session_id,
  request_id: r.request_id,
  amount: r.amount,
  token: r.token as Token,
  source: r.source as AmountSource,
  origin: r.origin as AmountOrigin,
  confirmed: toBool(r.confirmed),
  created_at: r.created_at,
});

export function createDb1(db: Database, opts: RepoOptions): Db1AmountPlaceholders {
  const insert = db.prepare(
    `INSERT INTO db1_amount_placeholders
       (placeholder, session_id, request_id, amount, token, source, origin, confirmed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM db1_amount_placeholders WHERE placeholder = ?');
  const byRequest = db.prepare('SELECT * FROM db1_amount_placeholders WHERE request_id = ? ORDER BY rowid');

  return {
    mint(row) {
      if (typeof row.amount !== 'string') throw new Error('db1: amount must be a decimal string');
      return mintWithRetry(
        () => opts.newPlaceholder('amount') as AmountPh,
        (ph) =>
          insert.run(
            ph,
            row.session_id,
            row.request_id,
            row.amount,
            row.token,
            row.source,
            row.origin,
            toInt(row.confirmed),
            opts.now(),
          ),
      );
    },
    get(placeholder) {
      const r = getStmt.get(placeholder) as Raw | undefined;
      return r ? fromRaw(r) : undefined;
    },
    listByRequest(request_id) {
      return (byRequest.all(request_id) as Raw[]).map(fromRaw);
    },
    update(placeholder, patch) {
      const sets: string[] = [];
      const vals: Array<string | number> = [];
      if (patch.amount !== undefined) {
        if (typeof patch.amount !== 'string') throw new Error('db1: amount must be a decimal string');
        sets.push('amount = ?');
        vals.push(patch.amount);
      }
      if (patch.token !== undefined) {
        sets.push('token = ?');
        vals.push(patch.token);
      }
      if (patch.source !== undefined) {
        sets.push('source = ?');
        vals.push(patch.source);
      }
      if (patch.confirmed !== undefined) {
        sets.push('confirmed = ?');
        vals.push(toInt(patch.confirmed));
      }
      if (sets.length === 0) return;
      const res = db
        .prepare(`UPDATE db1_amount_placeholders SET ${sets.join(', ')} WHERE placeholder = ?`)
        .run(...vals, placeholder);
      if (res.changes === 0) throw new Error('db1 row not found');
    },
  };
}
