// Implements: §14.2 rule 6, §12.5 mapping row `l`, Appendix A.3 `l`. One batch from the user's account: stop the plan, then disable
// the signed delegation. Nothing is refunded, because the money never left the wallet. The delegation is read back from the chain's
// `Registered` event, as the spec says, so a cancel still works if the wallet's store was lost.
//
// The check simulates the batch, then a later run of the plan, to show that run would pay nothing.

import { decodeFunctionResult, encodeFunctionData, keccak256, parseEventLogs, type Hex } from 'viem';
import type { Execution } from '../chain/redeem.v2.js';
import { asUpgraded, type Check } from '../guard/check.js';
import { decodeCall, decodeExecuteBatch, describeCall, type Movement } from '../guard/decode.js';
import { encodeExecuteBatch } from '../payments/payment-i.js';
import { finished, type HandlerContext, type StepOutcome, type StepHandler } from '../runner/handler.js';
import { CancelSchema } from '../schemas/bridge.v2.js';
import type { CancelL } from '../schemas/envelope.js';
import { DELEGATION_MANAGER_ABI, EXECUTOR_ABI } from './abi.js';
import { REGISTERED_EVENT, readPlan, verifiedIntent } from './autopay-k.js';
import { delegationFromRedeem, delegationHash } from './delegation.js';
import { reportCall } from './report-call.js';
import { scanLogs } from './scan.js';

interface CancelWork {
  calls: Execution[];
  executor: Hex;
  manager: Hex;
  redeem: Hex;
  startAt: bigint;
  interval: bigint;
  maxRuns: bigint;
  now: number;
}

/** Reads the plan and delegation from the chain. Returns an outcome instead when there's nothing to sign. */
async function readWork(ctx: HandlerContext, intent: CancelL): Promise<CancelWork | StepOutcome> {
  const deployment = ctx.deploymentFor(intent.chain_id);
  if (!deployment) return { status: 'failed', error_code: 'NOT_DEPLOYED' };
  const { executor } = deployment;
  const manager = deployment.env.DelegationManager as Hex;
  const known = ctx.store.autopayByPlan(intent.plan_id);
  if (known && known.autopay_id !== intent.autopay_id) return { status: 'failed', error_code: 'PLAN_MISMATCH' };

  const latest = await ctx.gateway.latestBlock();
  const [log] = await scanLogs(ctx.gateway, {
    address: executor,
    event: REGISTERED_EVENT,
    args: { intentId: intent.plan_id },
    fromBlock: known?.registered_block ?? deployment.deploymentBlock,
    toBlock: latest.number,
  });
  if (!log) return { status: 'failed', error_code: 'UNKNOWN_PLAN' };

  // A bad plan id must fail here, before anything is signed (W8-02).
  const redeem = log.args.redeem as Hex;
  const delegation = delegationFromRedeem(redeem);
  if (
    !delegation ||
    delegation.delegator.toLowerCase() !== ctx.walletAddress.toLowerCase() ||
    delegation.delegate.toLowerCase() !== executor.toLowerCase() ||
    keccak256(redeem) !== intent.plan_id
  ) {
    return { status: 'failed', error_code: 'PLAN_NOT_OURS' };
  }
  const hash = delegationHash(delegation);
  const verified = verifiedIntent(
    { ...ctx.envelope, intents: ctx.envelope.intents.filter((x) => x.step === intent.step) },
    intent.step,
  );
  if (!CancelSchema.safeParse({ ...verified, delegationHash: hash }).success) {
    return { status: 'failed', error_code: 'PLAN_NOT_OURS' };
  }

  const plan = await readPlan(ctx, executor, intent.plan_id);
  const disabled = decodeFunctionResult({
    abi: DELEGATION_MANAGER_ABI,
    functionName: 'disabledDelegations',
    data: await ctx.gateway.call(
      manager,
      encodeFunctionData({ abi: DELEGATION_MANAGER_ABI, functionName: 'disabledDelegations', args: [hash] }),
    ),
  });

  const planId = intent.plan_id;
  const calls: Execution[] = [];
  if (!plan.cancelled) {
    calls.push({
      target: executor,
      value: 0n,
      callData: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'cancel', args: [planId] }),
    });
  }
  if (!disabled) {
    calls.push({
      target: manager,
      value: 0n,
      callData: encodeFunctionData({
        abi: DELEGATION_MANAGER_ABI,
        functionName: 'disableDelegation',
        args: [delegation as never],
      }),
    });
  }
  // A repeat of a cancel that already happened: nothing left to do. `disableDelegation` would revert on a second call.
  if (calls.length === 0) {
    return {
      status: 'executed',
      executed_at: ctx.now().toISOString(),
      commit: (store) => {
        if (store.autopayByPlan(planId)) store.setAutopayStatus(planId, 'cancelled');
      },
    };
  }
  return {
    calls,
    executor,
    manager,
    redeem,
    startAt: log.args.startAt as bigint,
    interval: log.args.interval as bigint,
    maxRuns: log.args.maxRuns as bigint,
    now: latest.timestamp,
  };
}

/** A cancel moves no money, and every call must be for this plan and this wallet. Null otherwise. */
export function decodeCancelBatch(data: Hex, planId: Hex, wallet: Hex, executor: Hex, manager: Hex): Movement[] | null {
  const calls = decodeExecuteBatch(data);
  if (!calls) return null;
  const ok = calls.map(decodeCall).every((c) => {
    if (c.kind === 'cancel') return c.planId === planId && c.executor.toLowerCase() === executor.toLowerCase();
    if (c.kind === 'disableDelegation') {
      return (
        c.manager.toLowerCase() === manager.toLowerCase() &&
        c.delegator.toLowerCase() === wallet.toLowerCase() &&
        c.delegate.toLowerCase() === executor.toLowerCase()
      );
    }
    return false;
  });
  return ok ? [] : null;
}

const isOutcome = (x: CancelWork | StepOutcome): x is StepOutcome => 'status' in x;

/** The time of the next slot, if the plan has one left. A probe there shows that a run that would have paid no longer does. */
function nextSlot(work: CancelWork): number | null {
  const now = BigInt(work.now);
  const n = now < work.startAt ? 0n : (now - work.startAt) / work.interval + 1n;
  return n < work.maxRuns ? Number(work.startAt + n * work.interval) : null;
}

export const cancelHandler: StepHandler<CancelL> = {
  chainOf: (intent) => intent.chain_id,
  baseReport: (intent) => ({ autopay: { autopay_id: intent.autopay_id } }),

  async plan(ctx, intent) {
    const work = await readWork(ctx, intent);
    if (isOutcome(work)) return finished(work);
    const wallet = ctx.walletAddress;
    const data = encodeExecuteBatch(work.calls);
    const planId = intent.plan_id;
    const decodedCalls = (decodeExecuteBatch(data) ?? []).map(decodeCall);
    const slot = nextSlot(work);
    const check: Check = {
      blocks: [
        { calls: [{ from: wallet, to: wallet, data }], stateOverrides: asUpgraded(wallet) },
        ...(slot === null
          ? []
          : [{ calls: [await reportCall(ctx.gateway, work.executor, work.redeem)], time: slot, probe: true }]),
      ],
      decode: () => decodeCancelBatch(data, planId, wallet, work.executor, work.manager),
      movements: [],
      events: decodedCalls.some((c) => c.kind === 'cancel')
        ? [{ name: 'Cancelled', planId, address: work.executor }]
        : [],
      forbidden: [{ name: 'Executed', planId, address: work.executor }],
      summary: decodedCalls.map((c) =>
        describeCall(
          c,
          () => 0,
          () => '',
        ),
      ),
    };
    if (decodedCalls.some((c) => c.kind === 'disableDelegation')) {
      check.events.push({ name: 'DisabledDelegation', address: work.manager });
    }
    return { kind: 'check', check };
  },

  async prepare(ctx, intent) {
    const work = await readWork(ctx, intent);
    if (isOutcome(work)) return finished(work);
    return { kind: 'tx', tx: { to: ctx.walletAddress, data: encodeExecuteBatch(work.calls) } };
  },

  async settled(ctx, intent, receipt, hash) {
    const deployment = ctx.deploymentFor(intent.chain_id);
    const planId = intent.plan_id;
    const plan = deployment ? await readPlan(ctx, deployment.executor, planId) : null;
    const disabledLog = parseEventLogs({
      abi: DELEGATION_MANAGER_ABI,
      eventName: 'DisabledDelegation',
      logs: receipt.logs,
    }).length;
    const cancelledLog = parseEventLogs({ abi: EXECUTOR_ABI, eventName: 'Cancelled', logs: receipt.logs }).some(
      (l) => l.args.intentId === planId,
    );
    // The chain's own state is the effect: the plan is cancelled, and this transaction did something towards it.
    if (!plan?.cancelled || (!cancelledLog && disabledLog === 0)) {
      return finished({ status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' });
    }
    return finished({
      status: 'executed',
      tx_hash: hash,
      executed_at: receipt.executedAt,
      commit: (store) => {
        if (store.autopayByPlan(planId)) store.setAutopayStatus(planId, 'cancelled');
      },
    });
  },
};
