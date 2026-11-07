import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  pad,
  parseAbiParameters,
  parseEther,
  toHex,
  type Hex,
} from 'viem';
import { DELEGATION, DELEGATION_MANAGER_ABI } from '../../src/autopay/abi.js';
import { autoApprove } from '../../src/approval.js';
import { BrowserWalletController } from '../../src/browser/controller.js';
import { registerBrowserWallet } from '../../src/browser/routes.js';
import type { WalletBatchPayload } from '../../src/browser/types.js';
import { ACCOUNT_UPGRADE_REQUIRED } from '../../src/browser/upgrade.js';
import { UPGRADED_CODE } from '../../src/chain/addresses.js';
import { silentLogger } from '../../src/log.js';
import { Runner } from '../../src/runner/runner.js';
import { Store } from '../../src/store/store.js';
import { encodeExecuteBatch } from '../../src/payments/payment-i.js';
import { ALEX, BASE, BOB, WALLET, envelope, payEth } from '../support/envelopes.js';
import { FakeChain } from '../support/fake-chain.js';
import { tempDb } from '../support/temp-db.js';

const MANAGER: Hex = '0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3';
const SENT = { from: WALLET, to: ALEX, data: '0x' as Hex, value: parseEther('0.01'), nonce: 0, blockNumber: 2 };
/** MetaMask's gas-sponsored shape: a relayer redeems the account's delegation to run its own `execute` batch. */
const relayed = (delegator: Hex) => ({
  from: BOB,
  to: MANAGER,
  value: 0n,
  nonce: 9,
  blockNumber: 2,
  data: encodeFunctionData({
    abi: DELEGATION_MANAGER_ABI,
    functionName: 'redeemDelegations',
    args: [
      [
        encodeAbiParameters(parseAbiParameters(`${DELEGATION}[]`), [
          [{ delegate: BOB, delegator, authority: `0x${'ff'.repeat(32)}`, caveats: [], salt: 0n, signature: '0x' }],
        ]),
      ],
      [pad('0x00')],
      [
        concat([
          WALLET,
          pad('0x00'),
          encodeExecuteBatch([{ target: ALEX, value: parseEther('0.01'), callData: '0x' }]),
        ]),
      ],
    ],
  }),
});

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
    envFor: () => ({ DelegationManager: MANAGER }) as never,
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
  it('preserves a first-time payment as a setup step without signing or reporting a failure', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).error_code).toBe(ACCOUNT_UPGRADE_REQUIRED));
    expect(h.store.step(e.request_id, 0).status).toBe('pending');
    expect(h.store.envelope(e.request_id)).toEqual(e);
    expect(h.store.dueReports(Date.now())).toEqual([]);
    expect(h.controller.state().upgrades).toEqual([
      { requestId: e.request_id, step: 0, chainId: BASE, intent: e.intents[0] },
    ]);
    expect(h.store.walletBatch(e.request_id, 0)).toBeNull();
    expect(h.chain.simulated).toBe(0);
    await expect(h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' })).rejects.toThrow(
      ACCOUNT_UPGRADE_REQUIRED,
    );
    expect(h.chain.signed).toHaveLength(0);
    expect(h.chain.broadcasts).toHaveLength(0);
    expect(h.chain.upgrades).toBe(0);
  });
  it('rechecks the actual account, then prepares the same payment with fresh simulation and separate approval', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    h.chain.code = UPGRADED_CODE as Hex;
    await h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' });
    await vi.waitFor(() => expect(h.store.walletBatch(e.request_id, 0)).not.toBeNull());
    expect(h.store.envelope(e.request_id)).toEqual(e);
    expect(h.controller.state().upgrades).toEqual([]);
    expect(h.store.step(e.request_id, 0)).toMatchObject({ status: 'approved', error_code: null });
    expect(h.chain.simulated).toBe(1);
    expect(h.store.dueReports(Date.now())).toEqual([]);
    expect(h.store.walletBatch(e.request_id, 0)?.status).toBe('draft');
    expect(h.chain.signed).toEqual([]);
    expect(h.chain.broadcasts).toEqual([]);
    expect(h.chain.upgrades).toBe(0);
  });
  it('keeps setup pending across restart and fails closed if fresh payment simulation disagrees after upgrade', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    await h.runner.stop();
    const restarted = h.start();
    void restarted.kick();
    expect(h.store.step(e.request_id, 0).error_code).toBe(ACCOUNT_UPGRADE_REQUIRED);
    expect(h.chain.simulated).toBe(0);
    h.chain.code = UPGRADED_CODE as Hex;
    h.chain.simulation = 'moves-nothing';
    // The running service normally wires the controller to the restarted runner; its durable CAS is the boundary here.
    await h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' });
    void restarted.kick();
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('failed'));
    expect(h.store.step(e.request_id, 0).error_code).toBe('SIMULATION_MISMATCH');
    expect(h.store.walletBatch(e.request_id, 0)).toBeNull();
    expect(h.chain.signed).toEqual([]);
    expect(h.chain.broadcasts).toEqual([]);
  });
  it('can cancel setup without an RPC or signature and reports the cancellation exactly once', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    h.chain.unavailable.getCode = true;
    await h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'cancel' });
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('failed'));
    expect(h.store.step(e.request_id, 0).error_code).toBe('USER_REJECTED');
    expect(h.store.dueReports(Date.now())).toHaveLength(1);
    await expect(h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' })).rejects.toThrow(
      'UPGRADE_NOT_PENDING',
    );
    expect(h.store.dueReports(Date.now())).toHaveLength(1);
    expect(h.chain.signed).toEqual([]);
    expect(h.chain.upgrades).toBe(0);
  });
  it('does not trust a claimed upgrade, another implementation, malformed input or an unavailable chain', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    const request = { requestId: e.request_id, step: 0, decision: 'check' };
    for (const input of [
      null,
      {},
      { ...request, step: -1 },
      { ...request, step: 0.5 },
      { ...request, upgraded: true },
      { ...request, account: ALEX },
      { ...request, decision: 'sign' },
    ])
      await expect(h.controller.accountUpgrade(input)).rejects.toThrow('INVALID_UPGRADE_REQUEST');
    await expect(h.controller.accountUpgrade({ ...request, step: 1 })).rejects.toThrow('UPGRADE_NOT_PENDING');
    h.chain.code = '0x1234';
    await expect(h.controller.accountUpgrade(request)).rejects.toThrow('ACCOUNT_DELEGATED_ELSEWHERE');
    h.chain.unavailable.getCode = true;
    await expect(h.controller.accountUpgrade(request)).rejects.toThrow('chain unavailable');
    expect(h.store.step(e.request_id, 0).error_code).toBe(ACCOUNT_UPGRADE_REQUIRED);
    expect(h.store.dueReports(Date.now())).toEqual([]);
  });
  it('a late upgrade check cannot resume a payment cancelled while the RPC was pending', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    let answer!: (value: Hex) => void;
    vi.spyOn(h.chain, 'getCode').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const checking = h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' });
    const refused = expect(checking).rejects.toThrow('UPGRADE_NOT_PENDING');
    await h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'cancel' });
    answer(UPGRADED_CODE as Hex);
    await refused;
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('failed'));
    expect(h.store.walletBatch(e.request_id, 0)).toBeNull();
    expect(h.chain.signed).toEqual([]);
  });
  it('never revives a terminal upgrade failure from the old executor', async () => {
    const h = harness();
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    h.store.finishStep(
      e.request_id,
      0,
      { status: 'failed', error_code: ACCOUNT_UPGRADE_REQUIRED },
      e.created_at,
      Date.now(),
    );
    expect(h.controller.state().upgrades).toEqual([]);
    await expect(h.controller.accountUpgrade({ requestId: e.request_id, step: 0, decision: 'check' })).rejects.toThrow(
      'UPGRADE_NOT_PENDING',
    );
    expect(h.store.step(e.request_id, 0).status).toBe('failed');
    expect(h.store.walletBatch(e.request_id, 0)).toBeNull();
  });
  it('sends a single ETH payment as its exact call, with no data and no account wrapper', async () => {
    const h = harness();
    const { batch } = await h.queue();
    const { calls } = (JSON.parse(batch.payload_json) as WalletBatchPayload).calls;
    expect(calls).toEqual([{ to: ALEX, value: toHex(parseEther('0.01')) }]);
  });
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
    expect(calls.calls[0]).toEqual({ to: ALEX, value: toHex(parseEther('0.01')) });
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
  it.each([undefined, toHex(123, { size: 16 })])(
    'recovers after restart with wallet-generated ID %s and independently checks the transaction',
    async (walletId) => {
      const h = harness();
      const { batch, e } = await h.queue();
      h.controller.claim(batch.batch_id);
      if (walletId) h.controller.rememberWalletId(batch.batch_id, walletId);
      await h.runner.stop();
      const restarted = h.start();
      void restarted.kick();
      const hash = toHex(77, { size: 32 });
      vi.spyOn(h.chain, 'getTransaction').mockResolvedValue(SENT);
      vi.spyOn(h.chain, 'getReceipt').mockResolvedValue({
        status: 'success',
        logs: [],
        blockNumber: 2,
        executedAt: new Date().toISOString(),
      });
      await h.controller.receive(batch.batch_id, {
        id: walletId ?? batch.batch_id,
        chainId: toHex(BASE),
        atomic: true,
        receipts: [{ transactionHash: hash }],
      });
      await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('executed'));
      expect(h.store.walletBatch(e.request_id, 0)?.batch_id).toBe(batch.batch_id);
      expect(h.controller.state().batches[0]?.walletId).toBe(walletId ?? batch.batch_id);
      expect(h.chain.signed).toHaveLength(0);
      expect(h.chain.broadcasts).toHaveLength(0);
    },
  );
  it('accepts the same calls relayed by MetaMask through the account delegation', async () => {
    const h = harness();
    const { batch, e } = await h.queue();
    h.controller.claim(batch.batch_id);
    vi.spyOn(h.chain, 'getTransaction').mockResolvedValue(relayed(WALLET));
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
      receipts: [{ transactionHash: toHex(79, { size: 32 }) }],
    });
    await vi.waitFor(() => expect(h.store.step(e.request_id, 0).status).toBe('executed'));
  });
  it('binds a wallet-generated ID once, only after dispatch, without allowing another send', async () => {
    const h = harness();
    const { batch } = await h.queue();
    const walletId = toHex(21, { size: 16 });
    expect(() => h.controller.rememberWalletId(batch.batch_id, walletId)).toThrow('WALLET_ID_UNVERIFIED');
    h.controller.claim(batch.batch_id);
    h.controller.rememberWalletId(batch.batch_id, walletId);
    h.controller.rememberWalletId(batch.batch_id, walletId);
    expect(() => h.controller.rememberWalletId(batch.batch_id, toHex(22))).toThrow('WALLET_ID_UNVERIFIED');
    expect(() => h.controller.claim(batch.batch_id)).toThrow('REFRESH_OR_RECOVER_BATCH');
  });
  it('rejects wallet hints with a wrong identity, non-atomic execution, or an unrelated old transaction', async () => {
    const h = harness();
    const { batch } = await h.queue();
    h.controller.claim(batch.batch_id);
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
    const transaction = vi.spyOn(h.chain, 'getTransaction');
    vi.spyOn(h.chain, 'getReceipt').mockResolvedValue({
      status: 'success',
      logs: [],
      blockNumber: 2,
      executedAt: new Date().toISOString(),
    });
    for (const tx of [
      { ...SENT, from: ALEX },
      { ...SENT, to: BOB },
      { ...SENT, data: '0x12' as Hex },
      { ...SENT, value: 1n },
      { ...SENT, blockNumber: 1 },
      relayed(ALEX),
      { ...relayed(WALLET), to: BOB },
    ]) {
      transaction.mockResolvedValue(tx);
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
  it('authenticates setup actions and only resumes after a server-side account check', async () => {
    const h = harness();
    h.chain.code = '0x';
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    h.store.insertRequest(e, e.created_at);
    void h.runner.kick();
    await vi.waitFor(() => expect(h.controller.state().upgrades).toHaveLength(1));
    const app = Fastify();
    registerBrowserWallet(app, h.controller);
    const host = '127.0.0.1:8788';
    try {
      const home = await app.inject({ url: '/', headers: { host } });
      const cookie = String(home.headers['set-cookie']).split(';')[0]!;
      const headers = { host, cookie, 'x-flex-wallet': '1', origin: `http://${host}` };
      const payload = { requestId: e.request_id, step: 0, decision: 'check' };
      for (const bad of [
        { ...headers, cookie: '' },
        { ...headers, origin: '' },
        { ...headers, origin: 'https://other.example' },
        { ...headers, host: 'other.example' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/browser/account-upgrade', headers: bad, payload });
        expect(response.statusCode).toBe(403);
      }
      const waiting = await app.inject({ method: 'POST', url: '/browser/account-upgrade', headers, payload });
      expect(waiting.statusCode).toBe(409);
      expect(waiting.json()).toEqual({ error: ACCOUNT_UPGRADE_REQUIRED });
      expect(h.store.step(e.request_id, 0).status).toBe('pending');
      h.chain.code = UPGRADED_CODE as Hex;
      const ready = await app.inject({ method: 'POST', url: '/browser/account-upgrade', headers, payload });
      expect(ready.statusCode).toBe(200);
      await vi.waitFor(() => expect(h.store.walletBatch(e.request_id, 0)).not.toBeNull());
      expect((await app.inject({ method: 'POST', url: '/browser/account-upgrade', headers, payload })).statusCode).toBe(
        409,
      );
      expect(h.store.walletBatch(e.request_id, 0)?.status).toBe('draft');
      expect(h.chain.signed).toEqual([]);
      expect(h.chain.broadcasts).toEqual([]);
    } finally {
      await app.close();
    }
  });
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
