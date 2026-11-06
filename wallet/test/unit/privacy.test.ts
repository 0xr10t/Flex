// Privacy fixes in the wallet: fix 3 (viem never follows an offchain lookup, which would fetch a URL outside the RPC) and
// fix 9 (the run watcher reads every run on the shared executor, not only this user's plan ids).
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeErrorResult, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunWatcher } from '../../src/autopay/watcher.js';
import { createChainGateway, type ChainGateway, type LogQuery } from '../../src/chain/gateway.js';
import { silentLogger } from '../../src/log.js';
import { Store } from '../../src/store/store.js';
import { ALEX, BASE, envelope, payEth } from '../support/envelopes.js';
import { tempDb } from '../support/temp-db.js';

afterEach(() => vi.restoreAllMocks());

describe('privacy fix 3: the chain gateway never follows CCIP-Read', () => {
  it('a call answered with an offchain lookup fails, and no gateway URL is fetched', async () => {
    const target = '0x000000000000000000000000000000000000c0de' as Hex;
    const revert = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'OffchainLookup',
          inputs: [
            { name: 'sender', type: 'address' },
            { name: 'urls', type: 'string[]' },
            { name: 'callData', type: 'bytes' },
            { name: 'callbackFunction', type: 'bytes4' },
            { name: 'extraData', type: 'bytes' },
          ],
        },
      ],
      errorName: 'OffchainLookup',
      args: [target, ['https://gateway.attacker.invalid/{sender}/{data}'], '0x', '0x12345678', '0x'],
    });
    const methods: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { id: number; method: string };
        methods.push(body.method);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: 3, message: 'execution reverted', data: revert },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    const outside: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const u = String(input instanceof Request ? input.url : input);
      if (!u.startsWith(url)) outside.push(u);
      return realFetch(input, init);
    });
    try {
      const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
      const gateway = createChainGateway(BASE, url, account);
      await expect(gateway.call(target, '0x12345678')).rejects.toThrow();
      expect(outside).toEqual([]);
      expect(methods).toEqual(['eth_call']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('privacy fix 9: the run watcher', () => {
  const EXECUTOR = '0x00000000000000000000000000000000000E7EC0' as Hex;
  const MINE = `0x${'aa'.repeat(32)}` as Hex;
  const THEIRS = `0x${'bb'.repeat(32)}` as Hex;

  function setup() {
    const store = new Store(tempDb());
    const e = envelope([payEth(0, [[ALEX, '0.01']])]);
    store.insertRequest(e, '2026-11-06T10:00:00.000Z');
    store.saveAutopayDraft({
      plan_id: MINE,
      request_id: e.request_id,
      step: 0,
      autopay_id: 'ap_000000000001',
      chain_id: BASE,
      executor: EXECUTOR,
      token: 'USDC',
      amount: '5',
      fee: '0.01',
      delegation_json: '{}',
      redeem: '0x',
      end_at: 4_000_000_000,
    });
    store.activateAutopay(MINE, 10);
    const queries: LogQuery[] = [];
    const log = (intentId: Hex, slot: bigint, blockNumber: number, logIndex: number) => ({
      args: { intentId, slot, paid: 1n },
      blockNumber,
      transactionHash: `0x${String(blockNumber).padStart(64, '0')}` as Hex,
      logIndex,
    });
    const gateway = {
      latestBlock: async () => ({ number: 20, timestamp: 1_800_000_000 }),
      blockTime: async () => 1_800_000_000,
      getLogs: async (q: LogQuery) => {
        queries.push(q);
        return [log(THEIRS, 0n, 12, 0), log(MINE, 0n, 12, 1), log(THEIRS, 1n, 15, 0)];
      },
    } as unknown as ChainGateway;
    const watcher = new RunWatcher({
      store,
      chains: [{ chainId: BASE, executor: EXECUTOR, gateway }],
      log: silentLogger,
      onReportQueued: () => {},
    });
    return { store, watcher, queries, request_id: e.request_id };
  }

  it('asks for every Executed event on the executor, with no plan-id filter', async () => {
    const { watcher, queries } = setup();
    await watcher.tick();
    await watcher.stop();
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ address: EXECUTOR, fromBlock: 10, toBlock: 20 });
    expect(queries[0]?.event.name).toBe('Executed');
    expect(queries[0]?.args).toBeUndefined();
    expect(JSON.stringify(queries[0], (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      MINE.slice(2),
    );
  });

  it("reports only this user's runs; other users' runs on the shared executor are dropped", async () => {
    const { store, watcher } = setup();
    await watcher.tick();
    await watcher.stop();
    const bodies = store
      .allReports()
      .map((r) => JSON.parse(r.body_json) as { kind: string; autopay: { plan_id: Hex } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ kind: 'autopay_payment', autopay: { plan_id: MINE, slot: 0 } });
  });

  it("the cursor still advances past blocks that held only other users' runs", async () => {
    const { store, watcher } = setup();
    await watcher.tick();
    await watcher.stop();
    expect(store.watchCursor(BASE)).toBe(20);
  });
});
