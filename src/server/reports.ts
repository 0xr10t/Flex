// Implements: §14.3 execution reports → DB6/DB7 (intent_result: DB6 rows of request+step get status, tx_hash,
// executed_at; `k` step → DB7 active with delegate_address + cre_job_id, or failed; `l` step → DB7 cancelled;
// autopay_payment → DB6 `autopay_payment` row, status executed, counts 1 (SQ-R-04: a tx_hash already in DB6 → 204,
// nothing inserted); autopay_status → DB7 status),
// unknown request_id/autopay_id → 404, malformed → 400, success → 204. §11.4 last row. §7 addresses EIP-55.
// Owner: Lane A.
//
// Which DB7 row an intent_result concerns is given by `autopay.autopay_id` (the id the envelope carried for the `k`
// or `l` intent, §12.5): the row created by this request_id is the `k` step; a row created by an earlier request is
// the autopay this request's `l` step stops (SQ-A-04: an `l` step leaves no row of its own, so
// its request_id cannot be looked up, and a failed `l` step leaves the DB7 row as it is).

import { getAddress } from 'viem';
import { fractionDigits } from '../contracts/money.js';
import type { Repos } from '../contracts/repos.js';
import { TOKEN_DECIMALS, type Address, type AutopayId, type ExecutionReport } from '../contracts/types.js';
import { acceptHandoff } from '../handoff/journal.js';

export type ReportOutcome = 204 | 400 | 404;

const checksum = (a: string): Address => getAddress(a.toLowerCase());

/** A request the agent handed off: it has DB6 rows or created a DB7 row. */
const isKnownRequest = (repos: Repos, request_id: string): boolean =>
  repos.handoffs.get(request_id) !== undefined ||
  repos.db6.hasRequest(request_id) ||
  repos.db7.listByRequest(request_id).length > 0;

export function applyReport(repos: Repos, report: ExecutionReport, nowIso: string): ReportOutcome {
  switch (report.kind) {
    case 'intent_result':
      return intentResult(repos, report, nowIso);
    case 'autopay_payment':
      return autopayPayment(repos, report, nowIso);
    case 'autopay_status':
      return autopayStatus(repos, report, nowIso);
  }
}

function intentResult(repos: Repos, r: ExecutionReport, nowIso: string): ReportOutcome {
  const { request_id, step, status } = r;
  if (request_id === undefined || step === undefined || status === undefined) return 400;
  if (status === 'executed' && r.executed_at === undefined) return 400;
  // A callback is authorized for exactly the submitted request, step, intent kind and autopay.
  // Legacy v1 i/j/k records are also provable from DB6; an l callback always needs the durable journal.
  const submitted = repos.handoffs.get(request_id)?.envelope.intents.find((it) => it.step === step);
  const legacy = repos.db6.listByRequest(request_id).find((row) => row.step === step);
  const intent = submitted?.intent_id ?? legacy?.intent_id;
  if (intent === undefined || intent === null) return 404;
  const expectedAutopay =
    submitted && (submitted.intent_id === 'k' || submitted.intent_id === 'l')
      ? submitted.autopay_id
      : legacy?.autopay_id;
  const autopayId = r.autopay?.autopay_id;
  const ap = autopayId !== undefined ? repos.db7.get(autopayId) : undefined;
  if (intent === 'k' || intent === 'l') {
    if (autopayId === undefined) return 400;
    if (expectedAutopay !== autopayId || ap === undefined) return 404;
  } else if (autopayId !== undefined) return 404;

  let db7Patch: Parameters<Repos['db7']['update']>[1] | null = null;
  if (ap !== undefined && intent === 'k') {
    const delegate = r.autopay?.delegate_address;
    if (status === 'executed' && delegate === undefined) return 400;
    if (status === 'failed' && ap.status === 'pending') db7Patch = { status: 'failed' };
    else if (status === 'executed' && delegate !== undefined && (ap.status === 'pending' || ap.status === 'failed')) {
      db7Patch = { status: 'active', delegate_address: checksum(delegate), cre_job_id: r.autopay?.cre_job_id ?? null };
    }
  } else if (ap !== undefined && intent === 'l' && status === 'executed' && ap.status !== 'ended') {
    db7Patch = { status: 'cancelled' };
  }

  repos.transaction(() => {
    repos.db6.applyIntentResult({
      request_id,
      step,
      status,
      tx_hash: r.tx_hash ?? null,
      executed_at: r.executed_at ?? null,
    });
    if (ap !== undefined && db7Patch !== null) repos.db7.update(ap.autopay_id, db7Patch, nowIso);
    acceptHandoff(repos, request_id);
  });
  return 204;
}

function autopayPayment(repos: Repos, r: ExecutionReport, nowIso: string): ReportOutcome {
  const ap = r.autopay;
  if (
    ap === undefined ||
    ap.amount === undefined ||
    ap.chain_id === undefined ||
    ap.token === undefined ||
    r.executed_at === undefined
  ) {
    return 400;
  }
  if (fractionDigits(ap.amount) > TOKEN_DECIMALS[ap.token]) return 400;
  const row = repos.db7.get(ap.autopay_id);
  if (row === undefined) return 404;
  if (r.request_id !== undefined && !isKnownRequest(repos, r.request_id)) return 404;
  // SQ-R-04: a repeated report of a payment already logged is accepted but never counted twice.
  if (r.tx_hash !== undefined && r.tx_hash !== null && repos.db6.hasTxHash(r.tx_hash)) return 204;
  repos.db6.insertMany([
    {
      request_id: r.request_id ?? row.request_id,
      step: null,
      kind: 'autopay_payment',
      counts_toward_limit: true,
      chain_id: ap.chain_id,
      token: ap.token,
      amount: ap.amount,
      recipient_address: null,
      intent_id: null,
      autopay_id: row.autopay_id as AutopayId,
      status: 'executed',
      tx_hash: r.tx_hash ?? null,
      created_at: nowIso,
      executed_at: r.executed_at,
    },
  ]);
  return 204;
}

function autopayStatus(repos: Repos, r: ExecutionReport, nowIso: string): ReportOutcome {
  const ap = r.autopay;
  if (ap === undefined || ap.status === undefined) return 400;
  const current = repos.db7.get(ap.autopay_id);
  if (current === undefined) return 404;
  if (r.request_id !== undefined && !isKnownRequest(repos, r.request_id)) return 404;
  if (current.status === 'cancelled' || current.status === 'ended') return 204;
  repos.db7.update(ap.autopay_id, { status: ap.status }, nowIso);
  return 204;
}
