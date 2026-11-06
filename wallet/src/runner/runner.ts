// Implements: §14.2 rule 2 (step order, depends_on), rule 7 (nothing twice), rule 8 (report every outcome). OQ-08
// (provisional): independent steps still run; a step whose dependency failed is reported as failed without running.
//
// A step's state is saved before each move that can't be undone. The signed transaction is saved before it is sent, so
// after a crash the runner looks that exact transaction up and repeats it. It never signs a second one.
//
// Signing and source settlement remain serialized to preserve nonce ordering. Once a source transaction settles,
// bridge polling yields between passes so unrelated requests, including cancellation, can progress.

import { randomBytes } from 'node:crypto';
import { toHex, type Hex } from 'viem';
import type { Approver } from '../approval.js';
import { autopayHandler } from '../autopay/autopay-k.js';
import { cancelHandler } from '../autopay/cancel-l.js';
import { bridgeHandler } from '../bridge/bridge-j.js';
import { accountProblem, ensureUpgraded } from '../chain/account.js';
import { UPGRADED_CODE } from '../chain/addresses.js';
import {
  ChainUnavailableError,
  SimulationUnavailableError,
  WouldFailError,
  type ChainGateway,
} from '../chain/gateway.js';
import { runCheck } from '../guard/check.js';
import { decodeExecuteBatch } from '../guard/decode.js';
import type { Logger } from '../log.js';
import { paymentHandler } from '../payments/payment-i.js';
import type { EnvelopeIntent, HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import type { StepStatus, Store } from '../store/store.js';
import type { Deployment, HandlerContext, StepHandler, StepOutcome } from './handler.js';

export interface RunnerDeps {
  store: Store;
  walletAddress: Hex;
  approver: Approver;
  gatewayFor: (chainId: number) => ChainGateway;
  deploymentFor?: (chainId: number) => Deployment | null;
  log: Logger;
  onReportQueued: () => void;
  now?: () => Date;
  /** How long to wait between looks at a sent transaction, and between tries when a chain is unreachable. */
  pollMs?: number;
  /** Tries before giving up on a step that has signed nothing. A signed step keeps trying: its outcome is unknown. */
  maxTries?: number;
  /** How long before a still-pending bridge is marked delayed; never permission to resend. */
  bridgeTimeoutMs?: number;
  /** User-controlled EIP-5792 submission. The service never signs or broadcasts in this mode. */
  browserWallet?: boolean;
  bridgeFeeMaxEth?: string;
}

const OUTCOME_UNKNOWN_DELAY_FACTOR = 4;
const DEFAULT_BRIDGE_TIMEOUT_MS = 30 * 60 * 1000;

const HANDLERS = {
  i: paymentHandler,
  j: bridgeHandler,
  k: autopayHandler,
  l: cancelHandler,
} as unknown as Record<EnvelopeIntent['intent_id'], StepHandler>;

export class Runner {
  private running: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private readonly now: () => Date;
  private readonly pollMs: number;
  private readonly maxTries: number;
  private readonly summaries = new Map<string, string[]>();

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.pollMs = deps.pollMs ?? 1000;
    this.maxTries = deps.maxTries ?? 5;
  }

  /** Starts working through unfinished requests, if it isn't already. */
  kick(): Promise<void> {
    this.again = true;
    this.wake?.();
    this.running ??= this.loop().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Stops after the current wait. What isn't finished stays saved, and continues on the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  private async loop(): Promise<void> {
    try {
      while (this.again && !this.stopped) {
        this.again = false;
        for (const envelope of this.deps.store.unfinishedRequests()) {
          if (this.stopped) break;
          await this.runRequest(envelope);
        }
        if (!this.stopped && this.deps.store.nextUnfinished()) {
          this.again = true;
          await this.pause(this.pollMs);
        }
      }
    } catch {
      // Not a known chain outcome, so whether money moved may be unknown. The state stays saved, and the request is
      // tried again on the next kick or restart. Only the code is logged: an error's text could repeat a value.
      this.deps.log('runner_error', {});
    }
  }

  private async runRequest(envelope: HandoffEnvelope): Promise<void> {
    const ordered = [...envelope.intents].sort((a, b) => a.step - b.step);
    for (const intent of ordered) {
      if (this.stopped) return;
      await this.runStep(envelope, intent);
    }
  }

  private async runStep(envelope: HandoffEnvelope, intent: EnvelopeIntent): Promise<void> {
    const { store } = this.deps;
    const id = envelope.request_id;
    const status = store.step(id, intent.step).status;
    if (status === 'executed' || status === 'failed') return;

    const dependsOn = 'depends_on' in intent ? intent.depends_on : [];
    if (dependsOn.some((d) => store.step(id, d).status === 'failed')) {
      this.finish(id, intent, { status: 'failed', error_code: 'DEPENDENCY_FAILED' });
      return;
    }
    if (dependsOn.some((d) => store.step(id, d).status !== 'executed')) return;
    const handler = HANDLERS[intent.intent_id];
    const ctx = this.contextFor(envelope, handler.chainOf(intent));

    if (this.deps.browserWallet && status === 'approved' && store.walletBatch(id, intent.step)) {
      await this.settleWallet(ctx, handler, intent);
      if (store.step(id, intent.step).status === 'waiting') await this.waitFor(ctx, handler, intent);
      return;
    }
    if (this.deps.browserWallet && intent.intent_id !== 'i' && intent.intent_id !== 'j') {
      this.finish(id, intent, { status: 'failed', error_code: 'BROWSER_INTENT_UNSUPPORTED' });
      return;
    }

    // The check comes first, so nothing unverified reaches the approval. It runs again after a restart, as things may have changed.
    if ((status === 'pending' || status === 'approved') && !(await this.gate(ctx, handler, intent, status))) return;
    if (store.step(id, intent.step).status === 'approved' && !(await this.signStep(ctx, handler, intent))) return;
    if (store.step(id, intent.step).status === 'signed') await this.settle(ctx, handler, intent);
    if (store.step(id, intent.step).status === 'waiting') await this.waitFor(ctx, handler, intent);
  }

  private contextFor(envelope: HandoffEnvelope, chainId: number): HandlerContext {
    return {
      store: this.deps.store,
      walletAddress: this.deps.walletAddress,
      envelope,
      gateway: this.deps.gatewayFor(chainId),
      gatewayFor: this.deps.gatewayFor,
      deploymentFor: this.deps.deploymentFor ?? (() => null),
      now: this.now,
      bridgeTimeoutMs: this.deps.bridgeTimeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS,
      bridgeFeeMaxEth: this.deps.bridgeFeeMaxEth ?? '0.003',
    };
  }

  /** Tries `work`, again if the chain can't be reached. Returns false when the step has finished, or the runner is stopping. */
  private async attempt(
    ctx: HandlerContext,
    intent: EnvelopeIntent,
    stage: string,
    work: () => Promise<boolean>,
  ): Promise<boolean> {
    const id = ctx.envelope.request_id;
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (e) {
        if (e instanceof WouldFailError) {
          this.finish(id, intent, { status: 'failed', error_code: 'WOULD_FAIL' });
          return false;
        }
        const noSimulation = e instanceof SimulationUnavailableError;
        if (!noSimulation && !(e instanceof ChainUnavailableError)) throw e;
        this.deps.log('chain_unavailable', { request_id: id, step: intent.step, attempts: attempt, stage });
        if (attempt >= this.maxTries) {
          const error_code = noSimulation ? 'SIMULATION_UNAVAILABLE' : 'CHAIN_UNAVAILABLE';
          this.finish(id, intent, { status: 'failed', error_code });
          return false;
        }
        await this.pause(this.pollMs * attempt);
        if (this.stopped) return false;
      }
    }
  }

  /**
   * Account check and quote, then approval, then the decoder and simulation (privacy fix 2). Nothing is signed on any
   * path that returns false. A retry after the chain was unavailable never asks the user a second time.
   */
  private gate(
    ctx: HandlerContext,
    handler: StepHandler,
    intent: EnvelopeIntent,
    status: StepStatus,
  ): Promise<boolean> {
    const id = ctx.envelope.request_id;
    let approved = status !== 'pending';
    return this.attempt(ctx, intent, 'check', async () => {
      const problem = await accountProblem(ctx.gateway, this.deps.walletAddress);
      if (problem) {
        this.finish(id, intent, { status: 'failed', error_code: problem });
        return false;
      }
      const planned = await handler.plan(ctx, intent);
      if (planned.kind === 'finished') {
        this.finish(id, intent, planned.outcome);
        return false;
      }
      // Privacy fix 2 (user decision, 6 Nov 2026): ask after quoting and before the simulation, so a request the user
      // refuses never reaches the RPC as a full simulated batch. Nothing is signed until the simulation passes as well.
      if (!approved) {
        const yes = await this.deps.approver.approve({
          envelope: ctx.envelope,
          intent,
          summary: planned.check.summary,
        });
        if (!yes) {
          this.finish(id, intent, { status: 'failed', error_code: 'USER_REJECTED' });
          return false;
        }
        this.deps.store.markApproved(id, intent.step);
        approved = true;
      }
      const failure = await runCheck(ctx.gateway, planned.check, this.deps.walletAddress);
      if (failure) {
        this.finish(id, intent, { status: 'failed', error_code: failure });
        return false;
      }
      // MetaMask mode approves automatically here; the user decides in MetaMask afterwards, on this checked summary. In
      // that mode the simulation comes before the user's decision, because MetaMask signs and sends on its own.
      if (this.deps.browserWallet) this.summaries.set(`${id}:${intent.step}`, planned.check.summary);
      return true;
    });
  }

  /** Returns false when nothing is left to send: the step has finished, or the runner is stopping. */
  private signStep(ctx: HandlerContext, handler: StepHandler, intent: EnvelopeIntent): Promise<boolean> {
    const id = ctx.envelope.request_id;
    return this.attempt(ctx, intent, 'sign', async () => {
      const prepared = await handler.prepare(ctx, intent);
      if (prepared.kind === 'finished') {
        this.finish(id, intent, prepared.outcome);
        return false;
      }
      if (this.deps.browserWallet) {
        const calls = decodeExecuteBatch(prepared.tx.data);
        if (!calls || prepared.tx.to.toLowerCase() !== this.deps.walletAddress.toLowerCase())
          throw new Error('unsupported wallet batch');
        // MetaMask sends a single wallet_sendCalls entry directly. Preserve the checked executeBatch wrapper.
        // A first-time account must be upgraded by its wallet before it can execute that single self-call.
        if (
          calls.length === 1 &&
          (await ctx.gateway.getCode(this.deps.walletAddress))?.toLowerCase() !== UPGRADED_CODE
        ) {
          this.finish(id, intent, { status: 'failed', error_code: 'BROWSER_ACCOUNT_UPGRADE_REQUIRED' });
          return false;
        }
        const walletCalls =
          calls.length === 1 ? [{ target: prepared.tx.to, callData: prepared.tx.data, value: 0n }] : calls;
        const summaryKey = `${id}:${intent.step}`;
        this.deps.store.saveWalletBatch(
          id,
          intent.step,
          handler.chainOf(intent),
          {
            calls: {
              version: '2.0.0',
              id: `0x${randomBytes(32).toString('hex')}`,
              from: this.deps.walletAddress,
              chainId: toHex(handler.chainOf(intent)),
              atomicRequired: true,
              calls: walletCalls.map((c) => ({ to: c.target, data: c.callData, value: toHex(c.value) })),
            },
            expectedTx: prepared.tx,
            sourceBlock: (await ctx.gateway.latestBlock()).number,
            minNonce: await ctx.gateway.minedNonce(),
            summary: this.summaries.get(summaryKey) ?? [],
          },
          this.now().getTime(),
        );
        this.summaries.delete(summaryKey);
        return false;
      }
      const upgrade = await ensureUpgraded(ctx.gateway, this.deps.walletAddress);
      if (upgrade !== 'ready') {
        this.finish(id, intent, { status: 'failed', error_code: upgrade });
        return false;
      }
      const signed = await ctx.gateway.prepareAndSign(prepared.tx);
      this.deps.store.saveSigned(id, intent.step, signed);
      return true;
    });
  }

  /** Wallet-provided hashes are independently checked by the browser controller before entering this state. */
  private async settleWallet(ctx: HandlerContext, handler: StepHandler, intent: EnvelopeIntent): Promise<void> {
    const id = ctx.envelope.request_id;
    const batch = this.deps.store.walletBatch(id, intent.step)!;
    if (batch.status === 'rejected') {
      this.finish(id, intent, { status: 'failed', error_code: 'USER_REJECTED' });
      return;
    }
    if (!batch.tx_hash || batch.status !== 'received') return;
    try {
      // Bridges yield as soon as their source tx is mined; their poll checks finality on both chains.
      const receipt =
        intent.intent_id === 'j'
          ? await ctx.gateway.getReceipt(batch.tx_hash)
          : await ctx.gateway.getFinalizedReceipt(batch.tx_hash);
      if (!receipt) return;
      if (receipt.status !== 'success') {
        const final = await ctx.gateway.getFinalizedReceipt(batch.tx_hash);
        if (final?.status === 'reverted')
          this.finish(id, intent, { status: 'failed', tx_hash: batch.tx_hash, error_code: 'TX_REVERTED' });
        return;
      }
      const result = await handler.settled(ctx, intent, receipt, batch.tx_hash);
      if (result.kind === 'finished') this.finish(id, intent, result.outcome);
      else this.deps.store.markWalletWaiting(id, intent.step, result.data);
    } catch (e) {
      if (!(e instanceof ChainUnavailableError)) throw e;
      this.deps.log('chain_unavailable', { request_id: id, step: intent.step, stage: 'wallet_settle' });
    }
  }

  /** Sends the saved transaction and waits for its outcome. Repeating this is always safe. */
  private async settle(ctx: HandlerContext, handler: StepHandler, intent: EnvelopeIntent): Promise<void> {
    const id = ctx.envelope.request_id;
    const row = this.deps.store.step(id, intent.step);
    const hash = row.tx_hash as Hex;
    while (!this.stopped) {
      try {
        const receipt = await ctx.gateway.getReceipt(hash);
        if (receipt) {
          if (receipt.status !== 'success') {
            this.finish(id, intent, { status: 'failed', tx_hash: hash, error_code: 'TX_REVERTED' });
            return;
          }
          const result = await handler.settled(ctx, intent, receipt, hash);
          if (result.kind === 'finished') this.finish(id, intent, result.outcome);
          else this.deps.store.markWaiting(id, intent.step, result.data);
          return;
        }
        // No receipt, and another transaction has used this nonce: this one can never be mined.
        if ((await ctx.gateway.minedNonce()) > (row.nonce as number) && !(await ctx.gateway.getReceipt(hash))) {
          this.finish(id, intent, { status: 'failed', tx_hash: hash, error_code: 'TX_REPLACED' });
          return;
        }
        await ctx.gateway.broadcast(row.raw_tx as Hex);
        await this.pause(this.pollMs);
      } catch (e) {
        if (e instanceof WouldFailError) {
          this.finish(id, intent, { status: 'failed', tx_hash: hash, error_code: 'EFFECT_MISSING' });
          return;
        }
        if (!(e instanceof ChainUnavailableError)) throw e;
        this.deps.log('chain_unavailable', { request_id: id, step: intent.step, stage: 'settle' });
        await this.pause(this.pollMs * OUTCOME_UNKNOWN_DELAY_FACTOR);
      }
    }
  }

  /** The transaction is done, and something else must still happen, such as a bridge arriving. Survives a restart. */
  private async waitFor(ctx: HandlerContext, handler: StepHandler, intent: EnvelopeIntent): Promise<void> {
    const id = ctx.envelope.request_id;
    const row = this.deps.store.step(id, intent.step);
    if (!handler.poll) throw new Error('step waits, but its handler cannot');
    const data: unknown = JSON.parse(row.data_json as string);
    if (this.stopped) return;
    try {
      const outcome = await handler.poll(ctx, intent, data, row.tx_hash as Hex);
      if (outcome) this.finish(id, intent, outcome);
    } catch (e) {
      if (!(e instanceof ChainUnavailableError)) throw e;
      this.deps.log('chain_unavailable', { request_id: id, step: intent.step, stage: 'wait' });
    }
  }

  private finish(id: string, intent: EnvelopeIntent, outcome: StepOutcome): void {
    const now = this.now();
    const handler = HANDLERS[intent.intent_id];
    const { commit, report, ...result } = outcome;
    const merged = { ...handler.baseReport?.(intent), ...report };
    this.deps.store.transaction(() => {
      this.deps.store.finishStep(id, intent.step, { ...result, report: merged }, now.toISOString(), now.getTime());
      commit?.(this.deps.store);
    });
    this.deps.log('step_finished', {
      request_id: id,
      step: intent.step,
      ...(outcome.error_code ? { error_code: outcome.error_code } : {}),
    });
    this.deps.onReportQueued();
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}
