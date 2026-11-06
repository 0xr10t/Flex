// Implements: §14.3 `autopay_payment` and `autopay_status`, §14.2 rule 8, A.5 rule 5. CRE pays runs in the cloud and can't reach
// an agent on 127.0.0.1, so the wallet watches the chain and tells the agent (OQ-14, provisional).
//
// Only an `Executed` event counts: the forwarder's transaction succeeds even when the payment inside it fails. The event
// carries no amounts, but the signed batch fixes them, so the stored ones match what was paid. The cursor is saved with the
// reports, and each run has one report key, so runs while the wallet is off are found once, and a rescan repeats nothing.
//
// Skipped runs have no report kind in §14.3, so they aren't reported (OQ-14(b)). A plan ends once its `end_at` has passed.

import { getAbiItem, type Hex } from 'viem';
import type { ChainGateway } from '../chain/gateway.js';
import type { Logger } from '../log.js';
import type { AutopayRow, Store } from '../store/store.js';
import { EXECUTOR_ABI } from './abi.js';
import { SCAN_BLOCKS } from './scan.js';

const EXECUTED_EVENT = getAbiItem({ abi: EXECUTOR_ABI, name: 'Executed' });

export interface WatcherDeps {
  store: Store;
  chains: { chainId: number; executor: Hex; gateway: ChainGateway }[];
  log: Logger;
  onReportQueued: () => void;
  now?: () => number;
  intervalMs?: number;
}

const autopayFields = (plan: AutopayRow) => ({
  autopay_id: plan.autopay_id,
  plan_id: plan.plan_id,
  executor_address: plan.executor,
  chain_id: plan.chain_id,
  token: plan.token,
});

export class RunWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? Date.now;
    this.intervalMs = deps.intervalMs ?? 30_000;
  }

  /** Catches up, then keeps checking. */
  start(): void {
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over every chain. A chain that can't be reached is tried again on the next pass. */
  tick(): Promise<void> {
    this.running ??= this.pass().finally(() => {
      this.running = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), this.intervalMs);
        this.timer.unref();
      }
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    for (const chain of this.deps.chains) {
      try {
        await this.scanChain(chain.chainId, chain.executor, chain.gateway);
      } catch {
        this.deps.log('watch_unavailable', { chain_id: chain.chainId });
      }
    }
  }

  private async scanChain(chainId: number, executor: Hex, gateway: ChainGateway): Promise<void> {
    const { store } = this.deps;
    const plans = store.watchedPlans(chainId).filter((p) => p.executor.toLowerCase() === executor.toLowerCase());
    if (plans.length === 0) return;
    const byPlan = new Map(plans.map((p) => [p.plan_id, p]));
    const latest = await gateway.latestBlock();
    const cursor = store.watchCursor(chainId);
    const firstBlock = Math.min(...plans.map((p) => p.registered_block ?? latest.number));
    let from = cursor === null ? firstBlock : cursor + 1;

    while (from <= latest.number && !this.stopped) {
      const to = Math.min(from + SCAN_BLOCKS - 1, latest.number);
      // Privacy fix 9: every run on the shared executor, not filtered by this user's plan ids, so the RPC can't tell which
      // plans are being watched. Other users' runs are dropped below (`byPlan`).
      const logs = await gateway.getLogs({ address: executor, event: EXECUTED_EVENT, fromBlock: from, toBlock: to });
      const ordered = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
      const times = new Map<number, number>();
      for (const log of ordered) {
        if (!times.has(log.blockNumber)) times.set(log.blockNumber, await gateway.blockTime(log.blockNumber));
      }
      let queued = false;
      store.transaction(() => {
        for (const log of ordered) {
          const plan = byPlan.get(log.args.intentId as Hex);
          if (!plan) continue;
          const slot = Number(log.args.slot);
          const body = {
            kind: 'autopay_payment',
            request_id: plan.request_id,
            status: 'executed',
            tx_hash: log.transactionHash,
            executed_at: new Date((times.get(log.blockNumber) as number) * 1000).toISOString(),
            autopay: { ...autopayFields(plan), slot, status: 'active', amount: plan.amount, fee: plan.fee },
          };
          queued = store.queueReport(plan.request_id, null, `run:${plan.plan_id}:${slot}`, body, this.now()) || queued;
        }
        store.setWatchCursor(chainId, to);
      });
      if (queued) this.deps.onReportQueued();
      from = to + 1;
    }

    // Only after the scan reached the latest block, so a last run is reported before its plan's end.
    let ended = false;
    store.transaction(() => {
      for (const plan of plans) {
        if (plan.status !== 'active' || latest.timestamp <= plan.end_at) continue;
        store.setAutopayStatus(plan.plan_id, 'ended');
        const body = {
          kind: 'autopay_status',
          request_id: plan.request_id,
          autopay: { ...autopayFields(plan), status: 'ended' },
        };
        ended = store.queueReport(plan.request_id, null, `status:${plan.plan_id}:ended`, body, this.now()) || ended;
      }
    });
    if (ended) this.deps.onReportQueued();
  }
}
