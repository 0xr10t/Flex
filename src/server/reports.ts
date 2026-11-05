// Implements: §14.3 execution reports → DB6/DB7 (intent_result: DB6 rows of request+step get status, tx_hash,
// executed_at; `k` step → DB7 active with delegate_address + cre_job_id, or failed; `l` step → DB7 cancelled;
// autopay_payment → DB6 `autopay_payment` row, status executed, counts 1; autopay_status → DB7 status),
// unknown request_id/autopay_id → 404, malformed → 400, success → 204. §11.4 last row. §7 addresses EIP-55.
// Owner: Lane A.
//
// Which DB7 row an intent_result concerns is given by `autopay.autopay_id` (the id the envelope carried for the `k`
// or `l` intent, §12.5): the row created by this request_id is the `k` step; a row created by an earlier request is
// the autopay this request's `l` step stops.

import { getAddress } from 'viem';
import { fractionDigits } from '../contracts/money.js';
import type { Repos } from '../contracts/repos.js';
import { TOKEN_DECIMALS, type Address, type AutopayId, type ExecutionReport } from '../contracts/types.js';

export type ReportOutcome = 204 | 400 | 404;

const checksum = (a: string): Address => getAddress(a.toLowerCase());

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
  const autopayId = r.autopay?.autopay_id;
  const ap = autopayId !== undefined ? repos.db7.get(autopayId) : undefined;
  if (autopayId !== undefined && ap === undefined) return 404;
  const isKStep = ap !== undefined && ap.request_id === request_id;
  if (isKStep && status === 'executed' && r.autopay?.delegate_address === undefined) return 400;
  const known = repos.db6.hasRequest(request_id) || repos.db7.listByRequest(request_id).length > 0 || ap !== undefined;
  if (!known) return 404;

  repos.transaction(() => {
    repos.db6.applyIntentResult({
      request_id,
      step,
      status,
      tx_hash: r.tx_hash ?? null,
      executed_at: r.executed_at ?? null,
    });
    if (ap === undefined) return;
    if (isKStep) {
      if (status === 'executed') {
        repos.db7.update(
          ap.autopay_id,
          {
            status: 'active',
            delegate_address: checksum(r.autopay?.delegate_address as string),
            cre_job_id: r.autopay?.cre_job_id ?? null,
          },
          nowIso,
        );
      } else {
        repos.db7.update(ap.autopay_id, { status: 'failed' }, nowIso);
      }
    } else if (status === 'executed') {
      repos.db7.update(ap.autopay_id, { status: 'cancelled' }, nowIso);
    }
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
  if (repos.db7.get(ap.autopay_id) === undefined) return 404;
  repos.db7.update(ap.autopay_id, { status: ap.status }, nowIso);
  return 204;
}
