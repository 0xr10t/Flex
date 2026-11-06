// Shared v2 callbacks are bound to the durable submitted step and registered on-chain identity.
// Autopay events are deduplicated by (autopay_id, slot), including transactions containing multiple events.
import { getAddress } from 'viem';
import { fractionDigits, toBaseUnits } from '../contracts/money.js';
import type { Db7Row, Repos } from '../contracts/repos.js';
import { TOKEN_DECIMALS, type Address, type AutopayId, type ExecutionReport } from '../contracts/types.js';
import type {
  AutopayIdentity,
  AutopayPaymentReport,
  AutopayStatusReport,
  IntentResultReport,
  Schedule,
} from '@flex/protocol';
import { acceptHandoff } from '../handoff/journal.js';

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

function intentResult(repos: Repos, r: IntentResultReport, nowIso: string): ReportOutcome {
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
    const identity = r.autopay;
    if (
      status === 'executed' &&
      (!identity?.plan_id ||
        !identity.executor_address ||
        identity.chain_id !== ap.chain_id ||
        identity.token !== ap.token)
    )
      return 400;
    if (
      status === 'executed' &&
      ap.plan_id &&
      (identity!.plan_id !== ap.plan_id || checksum(identity!.executor_address!) !== ap.executor_address)
    )
      return 400;
    if (status === 'failed' && ap.status === 'pending') db7Patch = { status: 'failed' };
    else if (
      status === 'executed' &&
      identity?.plan_id &&
      identity.executor_address &&
      (ap.status === 'pending' || ap.status === 'failed')
    ) {
      db7Patch = { status: 'active', plan_id: identity.plan_id, executor_address: checksum(identity.executor_address) };
    }
  } else if (ap !== undefined && intent === 'l' && status === 'executed' && ap.status !== 'ended') {
    db7Patch = { status: 'cancelled' };
  }
  if (r.bridge_fee_eth !== undefined && intent !== 'j') return 400;
  if (submitted?.intent_id === 'j' && status === 'executed') {
    if (
      r.bridge_fee_eth === undefined ||
      fractionDigits(r.bridge_fee_eth) > 18 ||
      toBaseUnits(r.bridge_fee_eth, 18) > toBaseUnits(submitted.fee_max_eth, 18)
    )
      return 400;
  }

  repos.transaction(() => {
    repos.db6.applyIntentResult({
      request_id,
      step,
      status,
      tx_hash: r.tx_hash ?? null,
      executed_at: r.executed_at ?? null,
      bridge_fee_eth: r.bridge_fee_eth,
    });
    if (ap !== undefined && db7Patch !== null) repos.db7.update(ap.autopay_id, db7Patch, nowIso);
    acceptHandoff(repos, request_id);
  });
  return 204;
}

function matchesIdentity(row: Db7Row, requestId: string, identity: AutopayIdentity): boolean {
  return (
    row.request_id === requestId &&
    row.plan_id === identity.plan_id &&
    row.executor_address?.toLowerCase() === identity.executor_address.toLowerCase() &&
    row.chain_id === identity.chain_id &&
    row.token === identity.token
  );
}

function autopayPayment(repos: Repos, r: AutopayPaymentReport, nowIso: string): ReportOutcome {
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
  if (fractionDigits(ap.amount) > TOKEN_DECIMALS[ap.token] || fractionDigits(ap.fee) > TOKEN_DECIMALS[ap.token])
    return 400;
  const row = repos.db7.get(ap.autopay_id);
  if (row === undefined) return 404;
  if (!matchesIdentity(row, r.request_id, ap)) return 404;
  const schedule = JSON.parse(row.schedule_json) as Schedule;
  if (
    !Number.isInteger(ap.slot) ||
    ap.slot < 0 ||
    ap.slot >= schedule.max_runs ||
    ap.amount !== row.amount_per_payment ||
    ap.fee !== row.fee
  )
    return 400;
  // A transaction may contain more than one plan's event. Dedupe by this plan's scheduled slot, not globally by hash.
  const previous = repos.db6
    .listByRequest(row.request_id)
    .find((entry) => entry.autopay_id === row.autopay_id && entry.autopay_slot === ap.slot);
  if (previous) return previous.tx_hash?.toLowerCase() === r.tx_hash.toLowerCase() ? 204 : 400;
  repos.transaction(() =>
    repos.db6.insertMany(
      (['autopay_payment', 'autopay_fee'] as const).map((kind) => ({
        request_id: row.request_id,
        step: null,
        kind,
        counts_toward_limit: true,
        chain_id: ap.chain_id,
        token: ap.token,
        amount: kind === 'autopay_payment' ? ap.amount : ap.fee,
        recipient_address: null,
        intent_id: null,
        autopay_id: row.autopay_id as AutopayId,
        autopay_slot: ap.slot,
        status: 'executed',
        tx_hash: r.tx_hash ?? null,
        created_at: nowIso,
        executed_at: r.executed_at,
      })),
    ),
  );
  return 204;
}

function autopayStatus(repos: Repos, r: AutopayStatusReport, nowIso: string): ReportOutcome {
  const ap = r.autopay;
  if (ap === undefined || ap.status === undefined) return 400;
  const current = repos.db7.get(ap.autopay_id);
  if (current === undefined) return 404;
  if (!matchesIdentity(current, r.request_id, ap)) return 404;
  if (current.status === 'cancelled' || current.status === 'ended') return 204;
  repos.db7.update(ap.autopay_id, { status: ap.status }, nowIso);
  return 204;
}
