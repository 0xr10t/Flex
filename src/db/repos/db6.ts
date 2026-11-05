// Implements: §7.1 DB6 spend log (counts_toward_limit = 1 exactly for payment, bridge_buffer, autopay_payment),
// §10.1 / I-10 pending rows of the last 10 minutes, §11.3 V-15 / I-38 spent today (pending by created_at,
// executed by executed_at, local calendar date in the session timezone), §14.3 intent_result updates.
// Owner: Lane A.

import { DateTime } from 'luxon';
import type { Db6Insert, Db6Kind, Db6Row, Db6SpendLog } from '../../contracts/repos.js';
import type { Address, AutopayId, ChainId, Token } from '../../contracts/types.js';
import type { Database } from '../database.js';
import { toBool, toInt } from './common.js';

/** §7.1: kinds whose rows count toward the daily limit. */
export const COUNTING_KINDS: ReadonlySet<Db6Kind> = new Set<Db6Kind>(['payment', 'bridge_buffer', 'autopay_payment']);
/** §10.1: pending kinds subtracted from spendable. */
export const PENDING_SUBTRACT_KINDS: readonly Db6Kind[] = ['payment', 'bridge_out', 'autopay_prefund'];
/** §10.1 / I-10 window. */
export const PENDING_WINDOW_MINUTES = 10;

interface Raw {
  id: number;
  request_id: string;
  step: number | null;
  kind: string;
  counts_toward_limit: number;
  chain_id: number;
  token: string;
  amount: string;
  recipient_address: string | null;
  intent_id: string | null;
  autopay_id: string | null;
  status: string;
  tx_hash: string | null;
  created_at: string;
  executed_at: string | null;
}

const fromRaw = (r: Raw): Db6Row => ({
  id: r.id,
  request_id: r.request_id,
  step: r.step,
  kind: r.kind as Db6Kind,
  counts_toward_limit: toBool(r.counts_toward_limit),
  chain_id: r.chain_id as ChainId,
  token: r.token as Token,
  amount: r.amount,
  recipient_address: r.recipient_address as Address | null,
  intent_id: r.intent_id as Db6Row['intent_id'],
  autopay_id: r.autopay_id as AutopayId | null,
  status: r.status as Db6Row['status'],
  tx_hash: r.tx_hash,
  created_at: r.created_at,
  executed_at: r.executed_at,
});

const parseUtc = (iso: string): DateTime => DateTime.fromISO(iso, { zone: 'utc', setZone: false });

export function createDb6(db: Database): Db6SpendLog {
  const insert = db.prepare(
    `INSERT INTO db6_spend_log
       (request_id, step, kind, counts_toward_limit, chain_id, token, amount, recipient_address, intent_id,
        autopay_id, status, tx_hash, created_at, executed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const hasReq = db.prepare('SELECT 1 FROM db6_spend_log WHERE request_id = ? LIMIT 1');
  const apply = db.prepare(
    'UPDATE db6_spend_log SET status = ?, tx_hash = ?, executed_at = ? WHERE request_id = ? AND step = ?',
  );
  const pendingCandidates = db.prepare(
    `SELECT * FROM db6_spend_log
     WHERE status = 'pending' AND chain_id = ? AND token = ? AND kind IN ('payment','bridge_out','autopay_prefund')
     ORDER BY id`,
  );
  const spentCandidates = db.prepare(
    `SELECT * FROM db6_spend_log
     WHERE counts_toward_limit = 1 AND token = ? AND status IN ('pending','executed')
     ORDER BY id`,
  );

  const insertManyTx = db.transaction((rows: Db6Insert[]) => {
    for (const r of rows) {
      if (typeof r.amount !== 'string') throw new Error('db6: amount must be a decimal string');
      // §7.1: counts_toward_limit = 1 for kind IN ('payment','bridge_buffer','autopay_payment'), else 0.
      if (r.counts_toward_limit !== COUNTING_KINDS.has(r.kind)) {
        throw new Error('db6: counts_toward_limit does not match kind');
      }
      insert.run(
        r.request_id,
        r.step,
        r.kind,
        toInt(r.counts_toward_limit),
        r.chain_id,
        r.token,
        r.amount,
        r.recipient_address,
        r.intent_id,
        r.autopay_id,
        r.status,
        r.tx_hash,
        r.created_at,
        r.executed_at,
      );
    }
  });

  return {
    insertMany: (rows) => insertManyTx(rows),
    hasRequest: (request_id) => hasReq.get(request_id) !== undefined,
    applyIntentResult({ request_id, step, status, tx_hash, executed_at }) {
      return apply.run(status, tx_hash, executed_at, request_id, step).changes;
    },
    pendingRecent(chain_id, token, now_utc) {
      const cutoff = parseUtc(now_utc).minus({ minutes: PENDING_WINDOW_MINUTES });
      return (pendingCandidates.all(chain_id, token) as Raw[])
        .filter((r) => {
          const t = parseUtc(r.created_at);
          return t.isValid && t > cutoff;
        })
        .map(fromRaw);
    },
    spentToday(token, timezone, now_utc) {
      const today = parseUtc(now_utc).setZone(timezone).toISODate();
      const localDate = (iso: string | null): string | null => {
        if (iso === null) return null;
        const t = parseUtc(iso);
        return t.isValid ? t.setZone(timezone).toISODate() : null;
      };
      return (spentCandidates.all(token) as Raw[])
        .filter(
          (r) =>
            (r.status === 'pending' && localDate(r.created_at) === today) ||
            (r.status === 'executed' && localDate(r.executed_at) === today),
        )
        .map(fromRaw);
    },
  };
}
