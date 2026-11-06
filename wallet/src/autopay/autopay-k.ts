// Implements: §14.2 rule 5, Appendix A.3 `k` steps 1-3, A.5 rules 1-3 and 5. Creating an autopay moves no money: the user signs one
// delegation, then registers it on chain from their own account.
//
// The check runs twice. Before anything is signed: would this batch pay the right people? After the delegation is signed, before
// `register`: would registering work, and would the first run pay, simulated at its start time?
//
// OQ-09 (provisional): the delegation is saved before `register` is sent, and the intent id is derived from the request.
// OQ-11 (provisional): if `start_at` has passed before registering, the step fails, so a promised run is never silently lost.

import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAbiItem,
  parseEventLogs,
  type Hex,
} from 'viem';
import { executionsOf } from '../chain/redeem.v2.js';
import { asUpgraded, runCheck, type Check } from '../guard/check.js';
import {
  ETH,
  decodeCall,
  decodeExecuteBatch,
  decodeRedeemBatch,
  movementsOfCalls,
  type Movement,
} from '../guard/decode.js';
import { placeholderHashes, toPlan } from '@flex/protocol/mapping/to-plan';
import { encodeExecuteBatch, summaryOf } from '../payments/payment-i.js';
import { finished, type HandlerContext, type StepHandler, type StepOutcome } from '../runner/handler.js';
import type { AutopayK, HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import type { Intent } from '@flex/protocol/schemas/intent.v2';
import type { AutopayRow } from '../store/store.js';
import { EXECUTOR_ABI } from './abi.js';
import {
  delegationFromRedeem,
  planIdOf,
  redeemFor,
  signAutopayDelegation,
  type SignedDelegation,
} from './delegation.js';
import { reportCall } from './report-call.js';
import { scanLogs } from './scan.js';

const DECIMALS = { USDC: 6, ETH: 18 } as const;

export const REGISTERED_EVENT = getAbiItem({ abi: EXECUTOR_ABI, name: 'Registered' });

/** The verified intent for a step. Not parsed again, because a time check that passed at intake would fail on a restart. */
export function verifiedIntent(envelope: HandoffEnvelope, step: number): Intent {
  const found = toPlan(envelope, { delegationHashes: placeholderHashes(envelope) }).steps.find((s) => s.step === step);
  return found?.intent as unknown as Intent;
}

const runTotal = (intent: AutopayK): string =>
  formatUnits(
    intent.recipients.reduce((sum, r) => sum + BigInt(r.amount.base_units), 0n),
    DECIMALS[intent.token],
  );

function registerData(intent: AutopayK, redeem: Hex): Hex {
  const s = intent.schedule;
  return encodeFunctionData({
    abi: EXECUTOR_ABI,
    functionName: 'register',
    args: [BigInt(s.start_at), BigInt(s.interval_seconds), BigInt(s.late_window_seconds), BigInt(s.max_runs), redeem],
  });
}

export async function readPlan(ctx: HandlerContext, executor: Hex, planId: Hex) {
  const data = await ctx.gateway.call(
    executor,
    encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'plans', args: [planId] }),
  );
  const [delegator, , , , maxRuns, , , cancelled] = decodeFunctionResult({
    abi: EXECUTOR_ABI,
    functionName: 'plans',
    data,
  });
  return { exists: maxRuns !== 0n, delegator, cancelled };
}

const autopayReport = (intent: AutopayK, planId: Hex, executor: Hex) => ({
  autopay: {
    autopay_id: intent.autopay_id,
    plan_id: planId,
    executor_address: executor,
    chain_id: intent.chain_id,
    token: intent.token,
  },
});

/** What a run must move out of the wallet: each person, then the fee. */
const runMovements = (intent: AutopayK, wallet: Hex): Movement[] => {
  const token = intent.token === 'ETH' ? ETH : (intent.token_address as Hex);
  return [
    ...intent.recipients.map((r) => ({ token, from: wallet, to: r.recipient, value: BigInt(r.amount.base_units) })),
    { token, from: wallet, to: intent.fee.to, value: BigInt(intent.fee.amount.base_units) },
  ];
};

/** Reasons there's nothing to sign: the plan is on chain already, or it's too late to promise its first run. */
async function earlyOutcome(
  ctx: HandlerContext,
  intent: AutopayK,
  row: AutopayRow | null,
): Promise<StepOutcome | null> {
  const deployment = ctx.deploymentFor(intent.chain_id);
  if (!deployment) return { status: 'failed', error_code: 'NOT_DEPLOYED' };
  if (row) {
    // The plan can already exist if a send got through while its record didn't. Then there's nothing to send (W7-10).
    const plan = await readPlan(ctx, row.executor, row.plan_id);
    if (plan.exists) {
      if (plan.delegator.toLowerCase() !== ctx.walletAddress.toLowerCase()) {
        return { status: 'failed', error_code: 'PLAN_NOT_OURS' };
      }
      const latest = await ctx.gateway.latestBlock();
      const [log] = await scanLogs(ctx.gateway, {
        address: row.executor,
        event: REGISTERED_EVENT,
        args: { intentId: row.plan_id },
        fromBlock: deployment.deploymentBlock,
        toBlock: latest.number,
      });
      if (!log) return { status: 'failed', error_code: 'PLAN_LOG_MISSING' };
      const planId = row.plan_id;
      return {
        status: 'executed',
        tx_hash: log.transactionHash,
        executed_at: new Date((await ctx.gateway.blockTime(log.blockNumber)) * 1000).toISOString(),
        report: autopayReport(intent, planId, row.executor),
        commit: (store) => store.activateAutopay(planId, log.blockNumber),
      };
    }
  }
  if ((await ctx.gateway.latestBlock()).timestamp >= intent.schedule.start_at) {
    return { status: 'failed', error_code: 'START_PASSED' };
  }
  return null;
}

/** Reads what `register` would really send. A changed schedule, or a permission for someone else, returns null. */
export function decodeRegister(data: Hex, intent: AutopayK, wallet: Hex, executor: Hex): Movement[] | null {
  const s = intent.schedule;
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data });
  } catch {
    return null;
  }
  if (decoded.functionName !== 'register') return null;
  const [start, interval, late, runs, sent] = decoded.args;
  const delegation = delegationFromRedeem(sent);
  const batch = decodeRedeemBatch(sent);
  const scheduleMatches =
    start === BigInt(s.start_at) &&
    interval === BigInt(s.interval_seconds) &&
    late === BigInt(s.late_window_seconds) &&
    runs === BigInt(s.max_runs);
  if (
    !scheduleMatches ||
    !batch ||
    delegation?.delegator.toLowerCase() !== wallet.toLowerCase() ||
    delegation.delegate.toLowerCase() !== executor.toLowerCase()
  ) {
    return null;
  }
  return movementsOfCalls(batch.map(decodeCall), wallet);
}

export const autopayHandler: StepHandler<AutopayK> = {
  chainOf: (intent) => intent.chain_id,
  // Without the id, the agent couldn't move its DB7 row out of `pending` after a failure.
  baseReport: (intent) => ({ autopay: { autopay_id: intent.autopay_id } }),

  async plan(ctx, intent) {
    const row = ctx.store.autopayByStep(ctx.envelope.request_id, intent.step);
    const early = await earlyOutcome(ctx, intent, row);
    if (early) return finished(early);
    const wallet = ctx.walletAddress;
    const executions = executionsOf(verifiedIntent(ctx.envelope, intent.step));
    const data = encodeExecuteBatch(executions);
    const check: Check = {
      blocks: [{ calls: [{ from: wallet, to: wallet, data }], stateOverrides: asUpgraded(wallet) }],
      decode: () => {
        const calls = decodeExecuteBatch(data);
        return calls && movementsOfCalls(calls.map(decodeCall), wallet);
      },
      movements: runMovements(intent, wallet),
      events: [],
      summary: [`Autopay, up to ${intent.schedule.max_runs} runs. Each run:`, ...summaryOf(executions, intent.token)],
    };
    return { kind: 'check', check };
  },

  async prepare(ctx, intent) {
    const deployment = ctx.deploymentFor(intent.chain_id);
    if (!deployment) return finished({ status: 'failed', error_code: 'NOT_DEPLOYED' });
    const id = ctx.envelope.request_id;
    let row = ctx.store.autopayByStep(id, intent.step);
    const early = await earlyOutcome(ctx, intent, row);
    if (early) return finished(early);

    if (!row) {
      const verified = verifiedIntent(ctx.envelope, intent.step);
      const delegation: SignedDelegation = await signAutopayDelegation(
        {
          intent: verified,
          delegator: ctx.walletAddress,
          executor: deployment.executor,
          chainId: intent.chain_id,
          env: deployment.env,
          startAt: intent.schedule.start_at,
          endAt: intent.schedule.end_at,
        },
        ctx.gateway.signTypedData,
      );
      const redeem = redeemFor(verified, delegation);
      ctx.store.saveAutopayDraft({
        plan_id: planIdOf(redeem),
        request_id: id,
        step: intent.step,
        autopay_id: intent.autopay_id,
        chain_id: intent.chain_id,
        executor: deployment.executor,
        token: intent.token,
        amount: runTotal(intent),
        fee: intent.fee.amount.value,
        delegation_json: JSON.stringify(delegation),
        redeem,
        end_at: intent.schedule.end_at,
      });
      row = ctx.store.autopayByStep(id, intent.step);
    }
    if (!row) throw new Error('autopay draft missing');

    const wallet = ctx.walletAddress;
    const { redeem, executor, plan_id: planId } = row;
    const data = registerData(intent, redeem);
    const s = intent.schedule;
    const check: Check = {
      blocks: [
        { calls: [{ from: wallet, to: executor, data }], stateOverrides: asUpgraded(wallet) },
        { calls: [await reportCall(ctx.gateway, executor, redeem)], time: s.start_at },
      ],
      // Reads the bytes `register` would really send. A changed schedule, or a permission for someone else, stops here.
      decode: () => decodeRegister(data, intent, wallet, executor),
      movements: runMovements(intent, wallet),
      events: [
        { name: 'Registered', planId, address: executor },
        { name: 'Executed', planId, address: executor },
      ],
      summary: [],
    };
    const failure = await runCheck(ctx.gateway, check, wallet);
    if (failure) return finished({ status: 'failed', error_code: failure });
    return { kind: 'tx', tx: { to: executor, data } };
  },

  async settled(ctx, intent, receipt, hash) {
    const row = ctx.store.autopayByStep(ctx.envelope.request_id, intent.step);
    if (!row) return finished({ status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' });
    const s = intent.schedule;
    const registered = parseEventLogs({ abi: EXECUTOR_ABI, eventName: 'Registered', logs: receipt.logs }).find(
      (l) =>
        l.address.toLowerCase() === row.executor.toLowerCase() &&
        l.args.intentId === row.plan_id &&
        l.args.delegator.toLowerCase() === ctx.walletAddress.toLowerCase() &&
        l.args.startAt === BigInt(s.start_at) &&
        l.args.interval === BigInt(s.interval_seconds) &&
        l.args.lateWindow === BigInt(s.late_window_seconds) &&
        l.args.maxRuns === BigInt(s.max_runs),
    );
    if (!registered) return finished({ status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' });
    const planId = row.plan_id;
    return finished({
      status: 'executed',
      tx_hash: hash,
      executed_at: receipt.executedAt,
      report: autopayReport(intent, planId, row.executor),
      commit: (store) => store.activateAutopay(planId, receipt.blockNumber),
    });
  },
};
