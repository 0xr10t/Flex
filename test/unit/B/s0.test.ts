// Privacy fix 8: S0 reads DB4; balances are read by a jittered background timer, and during a message only at a cold start.
// Tests: §8.1 S0 refresh balances — C-051 (parallel ETH + USDC per allowed chain), C-052 (bigint → decimal
// strings, ETH 18 / USDC 6), C-053 (DB4 upsert ok), C-054 (failure → both rows unavailable, old values kept, note),
// C-055 (all unavailable → BALANCES_UNAVAILABLE), C-056 (no AnswerHandler: S0 runs only for new messages),
// C-357 (RPC clients: transport per chain, eth_getBalance, balanceOf eth_call, 10 s / no retries), C-294 (note wording), C-364 (BALANCES_UNAVAILABLE catalog message), §18 log labels.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { custom, encodeErrorResult, encodeFunctionData, erc20Abi, getAddress, type Transport } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import {
  RPC_TRANSPORT_OPTIONS,
  createRpcClients,
  refreshBalances,
  s0,
  startBalanceRefresher,
} from '../../../src/pipeline/s0-balances.js';
import { makeTestContext, testConfig } from '../../fakes/context.js';
import { seedBalances } from '../../fakes/repos.js';
import { expectLabelsOk } from './helpers.js';

const SEP = 11155111;
const BASE = 84532;
const ARB = 421614;

const ALL = { [SEP]: { ETH: '1', USDC: '10' }, [BASE]: { ETH: '1', USDC: '10' }, [ARB]: { ETH: '1', USDC: '10' } };

describe('S0 balances (§8.1, privacy fix 8)', () => {
  it('cold start (C-051, C-052, C-053): a chain never read is read now; ETH and USDC on every allowed chain as decimal strings', async () => {
    const ctx = makeTestContext();
    ctx.rpc.eth.set(SEP, 1_500_000_000_000_000_000n);
    ctx.rpc.usdc.set(SEP, 80_000_000n);
    ctx.rpc.eth.set(BASE, 1n);
    ctx.rpc.usdc.set(BASE, 1n);
    ctx.rpc.usdc.set(ARB, 123_456_789n);
    const r = await s0.step(ctx);
    expect(r).toEqual({ kind: 'continue' });
    expect(ctx.rpc.calls).toHaveLength(6);
    expect(new Set(ctx.rpc.calls.map((c) => `${c.fn}:${c.chain_id}`)).size).toBe(6);
    const eth = ctx.repos.db4.get(SEP, 'ETH');
    expect(eth).toMatchObject({ balance: '1.5', base_units: '1500000000000000000', status: 'ok', token: 'ETH' });
    expect(ctx.repos.db4.get(SEP, 'USDC')).toMatchObject({ balance: '80', base_units: '80000000', status: 'ok' });
    expect(ctx.repos.db4.get(BASE, 'ETH')?.balance).toBe('0.000000000000000001');
    expect(ctx.repos.db4.get(BASE, 'USDC')?.balance).toBe('0.000001');
    expect(ctx.repos.db4.get(ARB, 'USDC')?.balance).toBe('123.456789');
    expect(typeof ctx.repos.db4.get(ARB, 'USDC')?.balance).toBe('string');
    expect(ctx.repos.db4.get(SEP, 'ETH')?.updated_at).toBe('2026-11-05T17:30:00.000Z');
    expect(ctx.req.notes).toEqual([]);
    expect(ctx.req.state).toBe('BALANCES_REFRESHED');
    expectLabelsOk(ctx);
  });

  it('fix 8: once every chain has been read, a message makes no RPC call at all', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, ALL, '2026-11-05T10:00:00.000Z');
    ctx.rpc.usdc.set(SEP, 999_000_000n);
    expect(await s0.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.rpc.calls).toEqual([]);
    // DB4 is what the step uses, not the RPC.
    expect(ctx.repos.db4.get(SEP, 'USDC')?.balance).toBe('10');
    expect(ctx.req.state).toBe('BALANCES_REFRESHED');
  });

  it('fix 8: only the chains that were never read are read at a cold start', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, { [SEP]: ALL[SEP], [BASE]: ALL[BASE] });
    await s0.step(ctx);
    expect(new Set(ctx.rpc.calls.map((c) => c.chain_id))).toEqual(new Set([ARB]));
  });

  it('fix 8: a chain with only one token row counts as never read', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, { [SEP]: ALL[SEP], [BASE]: ALL[BASE], [ARB]: { ETH: '1' } });
    await s0.step(ctx);
    expect(new Set(ctx.rpc.calls.map((c) => c.chain_id))).toEqual(new Set([ARB]));
  });

  it('§8.1 step 4 (C-054, C-294): a chain DB4 marks unavailable adds the note and the log, without an RPC call', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, ALL, '2026-11-05T10:00:00.000Z');
    ctx.repos.db4.markUnavailable(BASE, 'Base Sepolia', '2026-11-05T11:00:00.000Z');
    expect(await s0.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.rpc.calls).toEqual([]);
    expect(ctx.req.notes).toEqual(["Base Sepolia balance couldn't be read right now, so it wasn't used."]);
    expect(ctx.log.lines.some((l) => JSON.stringify(l.chain_ids_unavailable) === JSON.stringify([BASE]))).toBe(true);
    expect(ctx.log.lines.some((l) => l.event === 'balances_unavailable')).toBe(true);
    expectLabelsOk(ctx);
  });

  it('§8.1 step 4: a cold-start read that fails marks the chain unavailable and adds the note', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, { [SEP]: ALL[SEP], [ARB]: ALL[ARB] });
    ctx.rpc.down.add(BASE);
    expect(await s0.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.repos.db4.get(BASE, 'ETH')?.status).toBe('unavailable');
    expect(ctx.req.notes).toEqual(["Base Sepolia balance couldn't be read right now, so it wasn't used."]);
  });

  it('§8.1 step 5 (C-055, C-364): every chain unavailable → BALANCES_UNAVAILABLE naming the chains', async () => {
    const ctx = makeTestContext();
    ctx.rpc.down.add(SEP).add(BASE).add(ARB);
    const r = await s0.step(ctx);
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.code).toBe('BALANCES_UNAVAILABLE');
    expect(r.params?.chains).toBe('Sepolia, Base Sepolia and Arbitrum Sepolia');
    expect(ERROR_MESSAGE.BALANCES_UNAVAILABLE(r.params ?? {})).toBe(
      "I can't read your balances on Sepolia, Base Sepolia and Arbitrum Sepolia right now. Try again in a moment.",
    );
  });

  it('§8.1 step 5: every chain unavailable in DB4 → BALANCES_UNAVAILABLE, still no RPC call', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, ALL);
    for (const c of [SEP, BASE, ARB] as const) ctx.repos.db4.markUnavailable(c, String(c), '2026-11-05T11:00:00.000Z');
    expect((await s0.step(ctx)).kind).toBe('error');
    expect(ctx.rpc.calls).toEqual([]);
  });

  it('only the allowed chains (DB5) are read and checked', async () => {
    const ctx = makeTestContext();
    ctx.limits = { ...ctx.limits, allowed_chain_ids: [BASE] };
    ctx.rpc.down.add(SEP).add(ARB);
    expect(await s0.step(ctx)).toEqual({ kind: 'continue' });
    expect(new Set(ctx.rpc.calls.map((c) => c.chain_id))).toEqual(new Set([BASE]));
    expect(ctx.req.notes).toEqual([]);
  });

  it('§8.1 (C-056): S0 asks no questions and has no AnswerHandler (runs only for new messages)', () => {
    expect(s0.onAnswer).toBeUndefined();
  });
});

describe('refreshBalances (§8.1 steps 1–4)', () => {
  it('one chain failing marks both its rows unavailable, keeps old values, and is returned', async () => {
    const ctx = makeTestContext();
    seedBalances(ctx.repos, { [BASE]: { ETH: '0.2', USDC: '55' } }, '2026-11-05T10:00:00.000Z');
    ctx.rpc.down.add(BASE);
    ctx.rpc.eth.set(SEP, 10n ** 18n);
    const out = await refreshBalances(ctx, [SEP, BASE, ARB], '2026-11-05T12:00:00.000Z');
    expect(out).toEqual([BASE]);
    for (const token of ['ETH', 'USDC'] as const) expect(ctx.repos.db4.get(BASE, token)?.status).toBe('unavailable');
    expect(ctx.repos.db4.get(BASE, 'ETH')?.balance).toBe('0.2');
    expect(ctx.repos.db4.get(BASE, 'USDC')?.balance).toBe('55');
    expect(ctx.repos.db4.get(SEP, 'ETH')).toMatchObject({
      status: 'ok',
      balance: '1',
      updated_at: '2026-11-05T12:00:00.000Z',
    });
  });

  it('ETH ok but USDC failing on a chain still makes that chain unavailable (both rows)', async () => {
    const ctx = makeTestContext();
    const orig = ctx.rpc.getUsdcBalance.bind(ctx.rpc);
    ctx.rpc.getUsdcBalance = async (c) => {
      if (c === ARB) throw new Error('timeout');
      return orig(c);
    };
    expect(await refreshBalances(ctx, [SEP, BASE, ARB], '2026-11-05T12:00:00.000Z')).toEqual([ARB]);
    expect(ctx.repos.db4.get(ARB, 'ETH')?.status).toBe('unavailable');
    expect(ctx.repos.db4.get(ARB, 'USDC')?.status).toBe('unavailable');
  });

  it('a chain that comes back is ok again', async () => {
    const ctx = makeTestContext();
    ctx.rpc.down.add(SEP);
    await refreshBalances(ctx, [SEP], '2026-11-05T12:00:00.000Z');
    ctx.rpc.down.delete(SEP);
    ctx.rpc.usdc.set(SEP, 5_000_000n);
    expect(await refreshBalances(ctx, [SEP], '2026-11-05T12:05:00.000Z')).toEqual([]);
    expect(ctx.repos.db4.get(SEP, 'USDC')).toMatchObject({ status: 'ok', balance: '5' });
  });
});

describe('startBalanceRefresher (privacy fix 8)', () => {
  afterEach(() => vi.useRealTimers());

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it('reads every allowed chain at start, then again after a jittered delay, and stops', async () => {
    vi.useFakeTimers();
    const ctx = makeTestContext();
    const r = startBalanceRefresher(ctx, {
      intervalMs: 1000,
      random: () => 0.25,
      nowIso: () => '2026-11-05T12:00:00.000Z',
    });
    await flush();
    expect(ctx.rpc.calls).toHaveLength(6);
    // 0.5 + 0.25 = 0.75 × 1000 ms.
    await vi.advanceTimersByTimeAsync(749);
    expect(ctx.rpc.calls).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(ctx.rpc.calls).toHaveLength(12);
    r.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ctx.rpc.calls).toHaveLength(12);
  });

  it('the delay always stays within 0.5–1.5 × the interval', async () => {
    vi.useFakeTimers();
    for (const [random, ms] of [
      [0, 500],
      [0.999, 1499],
    ] as const) {
      const ctx = makeTestContext();
      const r = startBalanceRefresher(ctx, { intervalMs: 1000, random: () => random });
      await flush();
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(ctx.rpc.calls).toHaveLength(6);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(ctx.rpc.calls).toHaveLength(12);
      r.stop();
    }
  });

  it('each read uses the allowed chains in DB5 at that moment', async () => {
    vi.useFakeTimers();
    const ctx = makeTestContext();
    const r = startBalanceRefresher(ctx, { intervalMs: 1000, random: () => 0 });
    await flush();
    ctx.repos.db5.putAll({ ...ctx.repos.db5.getAll(), allowed_chain_ids: [ARB] }, '2026-11-05T12:00:00.000Z');
    ctx.rpc.calls.length = 0;
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(new Set(ctx.rpc.calls.map((c) => c.chain_id))).toEqual(new Set([ARB]));
    r.stop();
  });

  it('a failing chain is logged with its id and nothing about the user; the timer keeps going', async () => {
    vi.useFakeTimers();
    const ctx = makeTestContext();
    ctx.rpc.down.add(BASE);
    const r = startBalanceRefresher(ctx, { intervalMs: 1000, random: () => 0 });
    await flush();
    const line = ctx.log.lines.find((l) => l.event === 'balances_unavailable');
    expect(line).toMatchObject({ chain_ids_unavailable: [BASE] });
    expect(line?.session_id).toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(ctx.rpc.calls).toHaveLength(12);
    r.stop();
  });

  it('a thrown error inside a read is logged and does not stop the timer', async () => {
    vi.useFakeTimers();
    const ctx = makeTestContext();
    const getAll = ctx.repos.db5.getAll.bind(ctx.repos.db5);
    let fail = true;
    ctx.repos.db5.getAll = () => {
      if (fail) throw new Error('db locked');
      return getAll();
    };
    const r = startBalanceRefresher(ctx, { intervalMs: 1000, random: () => 0 });
    await flush();
    expect(ctx.log.lines.some((l) => l.event === 'balance_refresh_failed')).toBe(true);
    fail = false;
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(ctx.rpc.calls).toHaveLength(6);
    r.stop();
  });

  it('tick() reads on demand', async () => {
    const ctx = makeTestContext();
    const r = startBalanceRefresher(ctx, { intervalMs: 60_000 });
    r.stop();
    await flush();
    ctx.rpc.calls.length = 0;
    await r.tick();
    expect(ctx.rpc.calls).toHaveLength(6);
  });
});

describe('S0 RPC clients (§14.5, C-357)', () => {
  type Req = { method: string; params?: unknown };
  function build() {
    const cfg = testConfig();
    // TEST_WALLET in test/fakes is not EIP-55 valid, which viem rejects; use a checksummed wallet here.
    cfg.wallet.address = getAddress('0x00000000000000000000000000000000000000aa');
    const urls: string[] = [];
    const requests: Array<{ url: string; req: Req }> = [];
    const factory = (url: string): Transport => {
      urls.push(url);
      return custom({
        async request(req: Req) {
          requests.push({ url, req });
          if (req.method === 'eth_getBalance') return '0x1bc16d674ec80000'; // 2e18
          if (req.method === 'eth_call') return '0x' + 123_456_789n.toString(16).padStart(64, '0');
          throw new Error(`unexpected ${req.method}`);
        },
      });
    };
    return { cfg, urls, requests, rpc: createRpcClients(cfg, factory) };
  }

  it('one transport per configured chain, built from that chain rpc_url', () => {
    const { cfg, urls } = build();
    expect(urls).toEqual(cfg.chains.map((c) => c.rpc_url));
  });

  it('getEthBalance sends eth_getBalance for the wallet at latest and returns a bigint', async () => {
    const { cfg, requests, rpc } = build();
    const chain = cfg.chains[1]!;
    const v = await rpc.getEthBalance(chain.chain_id);
    expect(v).toBe(2n * 10n ** 18n);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(chain.rpc_url);
    expect(requests[0]?.req.method).toBe('eth_getBalance');
    const params = requests[0]?.req.params as string[];
    expect(params[0]?.toLowerCase()).toBe(cfg.wallet.address.toLowerCase());
    expect(params[1]).toBe('latest');
  });

  it('getUsdcBalance sends eth_call to usdc_address with balanceOf(wallet) data and decodes a bigint', async () => {
    const { cfg, requests, rpc } = build();
    const chain = cfg.chains[2]!;
    const v = await rpc.getUsdcBalance(chain.chain_id);
    expect(v).toBe(123_456_789n);
    expect(typeof v).toBe('bigint');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(chain.rpc_url);
    expect(requests[0]?.req.method).toBe('eth_call');
    const call = (requests[0]?.req.params as Array<{ to: string; data: string }>)[0];
    expect(call?.to.toLowerCase()).toBe(chain.usdc_address.toLowerCase());
    expect(call?.data.startsWith('0x70a08231')).toBe(true);
    expect(call?.data).toBe(
      encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [cfg.wallet.address] }),
    );
    expect(call?.data.toLowerCase()).toContain(cfg.wallet.address.slice(2).toLowerCase());
  });

  it('an unknown chain id rejects (S0 then marks it unavailable)', async () => {
    const { rpc } = build();
    await expect(rpc.getEthBalance(1 as never)).rejects.toThrow();
  });

  it('RPC_TRANSPORT_OPTIONS = { timeout: 10000, retryCount: 0 }', () => {
    expect(RPC_TRANSPORT_OPTIONS).toEqual({ timeout: 10000, retryCount: 0 });
  });
});

describe('S0 RPC clients: privacy fixes 3 and 7', () => {
  const offchainLookup = (): never => {
    // OffchainLookup(address sender, string[] urls, bytes callData, bytes4 callbackFunction, bytes extraData)
    const data = encodeErrorResult({
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
      args: [
        testConfig().chains[0]!.usdc_address,
        ['https://gateway.invalid/{sender}/{data}'],
        '0x',
        '0x12345678',
        '0x',
      ],
    });
    throw Object.assign(new Error('execution reverted'), { code: 3, data });
  };

  it('fix 3: a balanceOf that answers with an offchain lookup fails; no gateway URL is fetched', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const cfg = testConfig();
    cfg.wallet.address = getAddress('0x00000000000000000000000000000000000000aa');
    const rpc = createRpcClients(cfg, () => custom({ request: async () => offchainLookup() }, { retryCount: 0 }));
    await expect(rpc.getUsdcBalance(SEP)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('fix 7: the production transport sends random JSON-RPC ids on its own connections, never through the global fetch', async () => {
    const seen: Array<{ id: unknown; port: number }> = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { id: unknown; method: string };
        seen.push({ id: body.id, port: req.socket.remotePort as number });
        const result = body.method === 'eth_getBalance' ? '0x2' : '0x' + '3'.padStart(64, '0');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const spy = vi.spyOn(globalThis, 'fetch');
    try {
      const cfg = testConfig();
      cfg.wallet.address = getAddress('0x00000000000000000000000000000000000000aa');
      cfg.chains = cfg.chains.map((c) => ({ ...c, rpc_url: url }));
      const rpc = createRpcClients(cfg);
      for (let i = 0; i < 3; i++) {
        expect(await rpc.getEthBalance(SEP)).toBe(2n);
        expect(await rpc.getUsdcBalance(BASE)).toBe(3n);
      }
      expect(spy).not.toHaveBeenCalled();
      const ids = seen.map((s) => s.id as number);
      expect(new Set(ids).size).toBe(6);
      expect(ids.every((id) => id > 1000)).toBe(true); // viem's own counter would start near 0
    } finally {
      spy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
