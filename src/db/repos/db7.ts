// Implements: §7.1 DB7 autopay registry (persistent), §8.14 step 4 / I-11 pending row per `k`, §10.7 find_autopays,
// §14.3 report-driven status updates. Owner: Lane A.

import type { Db7Autopays, Db7Row, Db7Status } from '../../contracts/repos.js';
import type { Address, AutopayId, ChainId, Token } from '../../contracts/types.js';
import type { Database } from '../database.js';

interface Raw {
  autopay_id: string;
  request_id: string;
  recipient_name: string;
  recipient_address: string;
  chain_id: number;
  token: string;
  amount_per_payment: string;
  schedule_json: string;
  delegate_address: string | null;
  cre_job_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

const fromRaw = (r: Raw): Db7Row => ({
  autopay_id: r.autopay_id as AutopayId,
  request_id: r.request_id,
  recipient_name: r.recipient_name,
  recipient_address: r.recipient_address as Address,
  chain_id: r.chain_id as ChainId,
  token: r.token as Token,
  amount_per_payment: r.amount_per_payment,
  schedule_json: r.schedule_json,
  delegate_address: r.delegate_address as Address | null,
  cre_job_id: r.cre_job_id,
  status: r.status as Db7Status,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

export function createDb7(db: Database): Db7Autopays {
  const insert = db.prepare(
    `INSERT INTO db7_autopays
       (autopay_id, request_id, recipient_name, recipient_address, chain_id, token, amount_per_payment, schedule_json,
        delegate_address, cre_job_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending', ?, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM db7_autopays WHERE autopay_id = ?');
  const byRecipient = db.prepare('SELECT * FROM db7_autopays WHERE recipient_address = ? ORDER BY rowid');
  const byRecipientStatus = db.prepare(
    'SELECT * FROM db7_autopays WHERE recipient_address = ? AND status = ? ORDER BY rowid',
  );
  const byRequest = db.prepare('SELECT * FROM db7_autopays WHERE request_id = ? ORDER BY rowid');

  return {
    insertPending(row, now) {
      if (typeof row.amount_per_payment !== 'string') throw new Error('db7: amount must be a decimal string');
      insert.run(
        row.autopay_id,
        row.request_id,
        row.recipient_name,
        row.recipient_address,
        row.chain_id,
        row.token,
        row.amount_per_payment,
        row.schedule_json,
        now,
        now,
      );
    },
    get(autopay_id) {
      const r = getStmt.get(autopay_id) as Raw | undefined;
      return r ? fromRaw(r) : undefined;
    },
    findByRecipient(address, status) {
      const rows = (status === undefined ? byRecipient.all(address) : byRecipientStatus.all(address, status)) as Raw[];
      return rows.map(fromRaw);
    },
    listByRequest: (request_id) => (byRequest.all(request_id) as Raw[]).map(fromRaw),
    update(autopay_id, patch, now) {
      const sets: string[] = [];
      const vals: Array<string | null> = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        vals.push(patch.status);
      }
      if (patch.delegate_address !== undefined) {
        sets.push('delegate_address = ?');
        vals.push(patch.delegate_address);
      }
      if (patch.cre_job_id !== undefined) {
        sets.push('cre_job_id = ?');
        vals.push(patch.cre_job_id);
      }
      sets.push('updated_at = ?');
      vals.push(now);
      const res = db
        .prepare(`UPDATE db7_autopays SET ${sets.join(', ')} WHERE autopay_id = ?`)
        .run(...vals, autopay_id);
      if (res.changes === 0) throw new Error('db7 row not found');
    },
  };
}
