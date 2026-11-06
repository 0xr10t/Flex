import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { toHex, type Hex } from 'viem';
import { autoApprove } from '../../src/approval.js';
import { BrowserWalletController } from '../../src/browser/controller.js';
import { registerBrowserWallet } from '../../src/browser/routes.js';
import type { WalletBatchPayload } from '../../src/browser/types.js';
import { silentLogger } from '../../src/log.js';
import { Runner } from '../../src/runner/runner.js';
import { Store } from '../../src/store/store.js';
import { ALEX, BASE, WALLET, envelope, payEth } from '../support/envelopes.js';
import { FakeChain } from '../support/fake-chain.js';
import { tempDb } from '../support/temp-db.js';

const runners: Runner[] = [];
afterEach(async () => {
  await Promise.all(runners.splice(0).map((r) => r.stop()));
  vi.restoreAllMocks();
});

function harness() {
  const store = new Store(tempDb());
  const chain = new FakeChain();
  let now = Date.now();
  const start = () => {
    const runner = new Runner({
      store,
      walletAddress: WALLET,
      approver: autoApprove,
      gatewayFor: () => chain,
      log: silentLogger,
      onReportQueued: () => {},
      browserWallet: true,
      pollMs: 5,
      now: () => new Date(now),
    });
    runners.push(runner);
    return runner;
  };
  const runner = start();
  const controller = new BrowserWalletController({
    store,
    walletAddress: WALLET,
    chainIds: [11155111, 84532, 421614],
    feeMaxEth: '0.003',
    gatewayFor: () => chain,
    now: () => now,
    kick: () => {
      void runner.kick();
    },
  });
  const queue = async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, new Date(now).toISOString());
    void runner.kick();
    await vi.waitFor(() => expect(store.walletBatch(e.request_id, 0)).not.toBeNull());
    return { e, batch: store.walletBatch(e.request_id, 0)! };
  };
  return {
    store,
    chain,
    runner,
    controller,
    queue,
    start,
    advance: () => {
      now += 61_000;
    },
  };
}

describe('durable browser wallet batches', () => {
  it('prepares an atomic request without signing, broadcasting or upgrading, and rejects a second dispatch', async () => {
    const h = harness();
    const { batch } = await h.queue();
    const calls = h.controller.claim(batch.batch_id);
    expect(calls).toMatchObject({
      id: batch.batch_id,
      atomicRequired: true,
      version: '2.0.0',
      from: WALLET,
      chainId: toHex(BASE),
    });
    expect(calls.calls).toHaveLength(1);
    expect(h.store.walletBatchById(batch.batch_id)?.status).toBe('dispatched');
    expect(() => h.controller.claim(batch.batch_id)).toThrow('REFRESH_OR_RECOVER_BATCH');
    expect(h.chain.signed).toHaveLength(0);
    expect(h.chain.broadcasts).toHaveLength(0);
    expect(h.chain.upgrades).toBe(0);
  });
  it('expires stale quotes and only refreshes requests which have never been dispatched', async () => {
    const h = harness();
    const { batch, e } = await h.queue();
    h.advance();
    expect(() => h.controller.claim(batch.batch_id)).toThrow('REFRESH_OR_RECOVER_BATCH');
    h.controller.refresh(batch.batch_id);
    await vi.waitFor(() => {
      const next = h.store.walletBatch(e.request_id, 0);
      expect(next).not.toBeNull();
      expect(next?.batch_id).not.toBe(batch.batch_id);
    });
    const replacement = h.store.walletBatch(e.request_id, 0)!;
    h.controller.claim(replacement.batch_id);
    expect(() => h.controller.refresh(replacement.batch_id)).toThrow('BATCH_ALREADY_DISPATCHED');
  });
  it('preserves a dispatched request through restart and completes from an independently checked transaction', async () => {
    const h = harness();
    const { batch, e } = await h.queue();
    h.controller.claim(batch.batch_id);
    await h.runner.stop();
    const restarted = h.start();
    void restarted.kick();
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    const hash = toHex(77, { size: 32 });
    vi.spyOn(h.chain, 'getTransaction').mockResolvedValue({
      ...payload.expectedTx,
      from: WALLET,
      value: 0n,
      nonce: 0,
      blockNumber: 2,
    });
    vi.spyOn(h.chain, 'getReceipt').mockResolvedValue({
      status: 'success',
      logs: [],
      blockNumber: 2,
      executedAt: new Date().toISOString(),
    });
    await h.controller.receive(batch.batch_id, {
      id: batch.batch_id,
      chainId: toHex(BASE),
      atomic: true,
      receipts: [{ transactionHash: hash }],
    });
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('executed'));
    expect(h.store.walletBatch(e.request_id, 0)?.batch_id).toBe(batch.batch_id);
    expect(h.chain.signed).toHaveLength(0);
    expect(h.chain.broadcasts).toHaveLength(0);
  });
  it('rejects wallet hints with a wrong identity, non-atomic execution, or an unrelated old transaction', async () => {
    const h = harness();
    const { batch } = await h.queue();
    h.controller.claim(batch.batch_id);
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    const hint = {
      id: batch.batch_id,
      chainId: toHex(BASE),
      atomic: true,
      receipts: [{ transactionHash: toHex(78, { size: 32 }) }],
    };
    for (const change of [{ id: toHex(1) }, { chainId: '0x1' }, { atomic: false }, { receipts: [] }])
      await expect(h.controller.receive(batch.batch_id, { ...hint, ...change })).rejects.toThrow(
        'WALLET_RESULT_UNVERIFIED',
      );
    const tx = { ...payload.expectedTx, from: WALLET, value: 0n, nonce: 0, blockNumber: 2 };
    const transaction = vi.spyOn(h.chain, 'getTransaction');
    vi.spyOn(h.chain, 'getReceipt').mockResolvedValue({
      status: 'success',
      logs: [],
      blockNumber: 2,
      executedAt: new Date().toISOString(),
    });
    for (const change of [{ from: ALEX }, { to: ALEX }, { data: '0x' as Hex }, { value: 1n }, { blockNumber: 1 }]) {
      transaction.mockResolvedValue({ ...tx, ...change });
      await expect(h.controller.receive(batch.batch_id, hint)).rejects.toThrow('TRANSACTION_DOES_NOT_MATCH');
    }
    expect(h.store.walletBatchById(batch.batch_id)?.tx_hash).toBeNull();
  });
  it('does not dispatch another batch on a chain with an unresolved wallet submission', async () => {
    const h = harness();
    const first = await h.queue();
    const second = await h.queue();
    h.controller.claim(first.batch.batch_id);
    expect(() => h.controller.claim(second.batch.batch_id)).toThrow('REFRESH_OR_RECOVER_BATCH');
    h.controller.reject(first.batch.batch_id);
    await vi.waitFor(() => expect(h.store.step(first.e.request_id, 0).error_code).toBe('USER_REJECTED'));
    expect(h.controller.claim(second.batch.batch_id).id).toBe(second.batch.batch_id);
  });
  it('accepts typed self-transfer plans and rejects unsupported chains or precision', () => {
    const h = harness();
    const id = h.controller.createBridge({ sourceChainId: 11155111, destChainId: 84532, amount: '1.00' });
    expect(h.store.envelope(id)?.intents[0]).toMatchObject({
      intent_id: 'j',
      receiver: 'self',
      fee_max_eth: '0.003',
      funds_steps: [],
      amount: { value: '1', base_units: '1000000', decimals: 6 },
    });
    for (const input of [
      { sourceChainId: 1, destChainId: 84532, amount: '1' },
      { sourceChainId: 11155111, destChainId: 11155111, amount: '1' },
      { sourceChainId: 11155111, destChainId: 84532, amount: '0.0000001' },
    ])
      expect(() => h.controller.createBridge(input)).toThrow('INVALID_BRIDGE');
  });
});

describe('local browser access', () => {
  it('requires a same-origin browser session and blocks cross-origin or rebound hosts', async () => {
    const h = harness();
    const app = Fastify();
    registerBrowserWallet(app, h.controller);
    const host = '127.0.0.1:8788';
    const home = await app.inject({ url: '/', headers: { host } });
    const cookie = String(home.headers['set-cookie']).split(';')[0]!;
    expect(home.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const headers = { host, cookie, 'x-flex-wallet': '1', origin: `http://${host}` };
    expect((await app.inject({ url: '/browser/state', headers })).statusCode).toBe(200);
    for (const bad of [
      { ...headers, cookie: '' },
      { ...headers, origin: 'https://other.example' },
      { ...headers, host: 'other.example' },
      { ...headers, 'x-flex-wallet': '' },
    ])
      expect((await app.inject({ url: '/browser/state', headers: bad })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/browser/bridge', headers: { ...headers, origin: '' }, payload: {} }))
        .statusCode,
    ).toBe(403);
    await app.close();
  });
});
