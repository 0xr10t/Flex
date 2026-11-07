// GET /v1/intents/:request_id: what the CLI shows after handing a request to the wallet.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Hex } from 'viem';
import { silentLogger } from '../../src/log.js';
import { buildApp } from '../../src/server/app.js';
import { statusReader } from '../../src/server/status.js';
import { Store } from '../../src/store/store.js';
import type { WalletBatchPayload } from '../../src/browser/types.js';
import { tempDb } from '../support/temp-db.js';
import { ALEX, ARBITRUM, BASE, BOB, WALLET, envelope, payEth, payUsdc } from '../support/envelopes.js';

const TOKEN = 'inbound-test-token';
const HASH = `0x${'12'.repeat(32)}` as Hex;
let store: Store;
let app: FastifyInstance;
let receipts: Map<Hex, 'success' | 'reverted'>;
let lookups: number;

beforeEach(() => {
  store = new Store(tempDb());
  receipts = new Map();
  lookups = 0;
  app = buildApp({
    store,
    walletAddress: WALLET,
    inboundToken: TOKEN,
    chainIds: [BASE, ARBITRUM],
    executorChainIds: [],
    onAccepted: () => undefined,
    requestStatus: statusReader(store, async (_chain, hash) => {
      lookups++;
      return receipts.get(hash) ?? null;
    }),
    log: silentLogger,
  });
});
afterEach(() => app.close());

const get = (id: string, token: string | null = TOKEN) =>
  app.inject({
    method: 'GET',
    url: `/v1/intents/${id}`,
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });

const batch = (requestId: string, step: number, chainId: number): Hex => {
  const id = `0x${(step + 1).toString(16).padStart(64, '0')}` as Hex;
  const payload: WalletBatchPayload = {
    calls: { id, chainId, calls: [] } as unknown as WalletBatchPayload['calls'],
    sourceBlock: 1,
    minNonce: 0,
    summary: [],
  };
  store.saveWalletBatch(requestId, step, chainId, payload, Date.now());
  return id;
};

describe('GET /v1/intents/:request_id', () => {
  it('needs the inbound token and a known request id', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, new Date().toISOString());
    expect((await get(e.request_id, null)).statusCode).toBe(401);
    expect((await get(e.request_id, 'wrong')).statusCode).toBe(401);
    expect((await get('req_ffffffffffff')).statusCode).toBe(404);
    expect((await get('not-a-request')).statusCode).toBe(404);
    const res = await get(e.request_id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('describes each step from the stored envelope', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']]), payUsdc(1, [[BOB, '2']], ARBITRUM)]);
    store.insertRequest(e, new Date().toISOString());
    const { steps } = (await get(e.request_id)).json();
    expect(steps).toEqual([
      {
        step: 0,
        kind: 'i',
        chain_id: BASE,
        token: 'ETH',
        recipients: [{ address: ALEX, amount: '0.01' }],
        state: 'preparing',
        tx_hash: null,
        error_code: null,
      },
      {
        step: 1,
        kind: 'i',
        chain_id: ARBITRUM,
        token: 'USDC',
        recipients: [{ address: BOB, amount: '2' }],
        state: 'preparing',
        tx_hash: null,
        error_code: null,
      },
    ]);
  });

  it('follows a MetaMask step from approval to confirmed, reading the receipt once it is mined', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, new Date().toISOString());
    store.markApproved(e.request_id, 0);
    const id = batch(e.request_id, 0, BASE);
    const state = async () => (await get(e.request_id)).json().steps[0];
    expect((await state()).state).toBe('awaiting_approval');
    expect(store.claimWalletBatch(id, Date.now())).toBe(true);
    expect((await state()).state).toBe('awaiting_approval');
    expect(store.receiveWalletBatch(id, HASH)).toBe(true);
    expect(await state()).toMatchObject({ state: 'confirming', tx_hash: HASH });
    receipts.set(HASH, 'success');
    expect(await state()).toMatchObject({ state: 'confirmed', tx_hash: HASH });
    const before = lookups;
    await state();
    expect(lookups).toBe(before);
    store.finishStep(e.request_id, 0, { status: 'executed', tx_hash: HASH }, new Date().toISOString(), Date.now());
    expect(await state()).toMatchObject({ state: 'completed', tx_hash: HASH });
  });

  it('reports a MetaMask rejection, a reverted receipt and a recorded failure as failed', async () => {
    const e = envelope([
      payEth(0, [[ALEX, '0.01']]),
      payEth(1, [[BOB, '0.01']], ARBITRUM),
      payEth(2, [[ALEX, '0.02']], ARBITRUM),
    ]);
    store.insertRequest(e, new Date().toISOString());
    for (const step of [0, 1]) store.markApproved(e.request_id, step);
    const rejected = batch(e.request_id, 0, BASE);
    expect(store.rejectWalletBatch(rejected)).toBe(true);
    const reverted = batch(e.request_id, 1, ARBITRUM);
    store.claimWalletBatch(reverted, Date.now());
    store.receiveWalletBatch(reverted, HASH);
    receipts.set(HASH, 'reverted');
    store.finishStep(e.request_id, 2, { status: 'failed', error_code: 'INSUFFICIENT_FUNDS' }, '', Date.now());
    const { steps } = (await get(e.request_id)).json();
    expect(steps.map((s: { state: string; error_code: string }) => [s.state, s.error_code])).toEqual([
      ['failed', 'USER_REJECTED'],
      ['failed', 'TX_REVERTED'],
      ['failed', 'INSUFFICIENT_FUNDS'],
    ]);
  });

  it('says when the account still needs the smart-account upgrade', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, new Date().toISOString());
    expect(store.awaitAccountUpgrade(e.request_id, 0)).toBe(true);
    expect((await get(e.request_id)).json().steps[0].state).toBe('needs_setup');
  });

  it('says confirming, not failed, while the chain is unreachable', async () => {
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, new Date().toISOString());
    store.markApproved(e.request_id, 0);
    const id = batch(e.request_id, 0, BASE);
    store.claimWalletBatch(id, Date.now());
    store.receiveWalletBatch(id, HASH);
    const flaky = buildApp({
      store,
      walletAddress: WALLET,
      inboundToken: TOKEN,
      chainIds: [BASE],
      executorChainIds: [],
      onAccepted: () => undefined,
      requestStatus: statusReader(store, async () => {
        throw new Error('rpc down');
      }),
      log: silentLogger,
    });
    const res = await flaky.inject({
      method: 'GET',
      url: `/v1/intents/${e.request_id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.json().steps[0].state).toBe('confirming');
    await flaky.close();
  });
});
