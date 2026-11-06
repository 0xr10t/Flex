// Host runner and indexer tests: no CRE account, wallet key, RPC network, or transaction is used.
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, keccak256 } from 'viem';
// @ts-expect-error Host ESM helpers intentionally also run directly under Node without a TS build.
import { EVENTS, indexPlans, rpcClient } from '../../../scripts/cre-indexer.mjs';
// @ts-expect-error See above.
import { acquireLock, assertLocalNetwork, optionsOf, parseSimulationOutput } from '../../../scripts/cre-local.mjs';

const executor = `0x${'ab'.repeat(20)}`;
const chain = { chainId: 11155111, executor, deploymentBlock: '1' };
const blockHash = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
const block = (n: bigint) => ({ number: `0x${n.toString(16)}`, hash: blockHash(n) });
const redeem = '0x12345678';
const id = keccak256(redeem);
const registered = {
  address: executor,
  blockNumber: '0x1',
  logIndex: '0x0',
  removed: false,
  topics: encodeEventTopics({
    abi: EVENTS,
    eventName: 'Registered',
    args: { intentId: id, delegator: `0x${'01'.repeat(20)}` },
  }),
  data: encodeAbiParameters(
    [{ type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes' }],
    [1000n, 60n, 30n, 5n, redeem],
  ),
};

function fakeRpc(head = 25n, limit = 10n) {
  const calls: Array<[bigint, bigint]> = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_chainId') return '0xaa36a7';
    if (method === 'eth_getBlockByNumber') return block(params[0] === 'finalized' ? head : BigInt(params[0] as string));
    if (method === 'eth_getLogs') {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(p.fromBlock),
        to = BigInt(p.toBlock);
      if (to - from + 1n > limit) throw new Error('RPC_LOG_RANGE');
      calls.push([from, to]);
      return from === 1n ? [registered] : [];
    }
    throw new Error('unexpected RPC');
  });
  return { rpc, calls };
}

describe('CRE local runner safety', () => {
  it('refuses to bypass a configured wallet Tor proxy', () => {
    expect(() => assertLocalNetwork({ network: { socks_proxy: 'socks5h://127.0.0.1:9050' } })).toThrow(
      'CRE_LOCAL_PROXY_UNSUPPORTED',
    );
    expect(() => assertLocalNetwork({ network: { socks_proxy: null } })).not.toThrow();
  });
  it('enforces exclusive ownership and recovers an informational stale file after release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flex-cre-lock-'));
    const path = join(dir, 'runner.lock');
    let release = await acquireLock(path, 0);
    try {
      await expect(acquireLock(path, release.port)).rejects.toThrow('RUNNER_LOCKED');
      const port = release.port;
      await release();
      writeFileSync(path, '{"pid":999999,"token":"stale"}');
      release = await acquireLock(path, port);
    } finally {
      await release();
      rmdirSync(dir);
    }
  });
  it('rejects broadcast, deployment, unknown flags, and rapid loops', () => {
    for (const args of [
      ['run', '--broadcast'],
      ['deploy'],
      ['run', '--interval-seconds', '1'],
      ['run', '--iterations', '2'],
    ])
      expect(() => optionsOf(args)).toThrow('USAGE');
    expect(optionsOf(['run', '--watch', '--iterations', '2'])).toMatchObject({
      command: 'run',
      iterations: 2,
      intervalSeconds: 30,
    });
  });
  it('reads a native quoted result and never treats CLI success text as payment evidence', () => {
    const result = { mode: 'dry-run', due: 1, results: [{ status: 'would_execute' }] };
    expect(
      parseSimulationOutput(
        `Workflow Simulation Result:\n${JSON.stringify(JSON.stringify(result))}\nSimulation complete`,
      ),
    ).toEqual(result);
    expect(() => parseSimulationOutput('Simulation complete')).toThrow('CRE_RESULT_MISSING');
    expect(() => parseSimulationOutput('Workflow Simulation Result:\n{"mode":"broadcast"}')).toThrow(
      'CRE_RESULT_INVALID',
    );
  });
  it('reduces rejected log ranges while retaining old active plans', async () => {
    const h = fakeRpc();
    const result = await indexPlans(chain, null, h.rpc);
    expect(result.caughtUp).toBe(true);
    expect(h.calls).toEqual([
      [1n, 10n],
      [11n, 20n],
      [21n, 25n],
    ]);
    expect(result.state.snapshot.plans[0]).toMatchObject({ id, startAt: '1000', lastSlot: '-1' });
  });
  it('persists bounded progress then resumes without discarding earlier registrations', async () => {
    const h = fakeRpc(50n);
    const checkpoints: unknown[] = [];
    const first = await indexPlans(chain, null, h.rpc, {
      maxPages: 2,
      onCheckpoint: async (state: unknown) => checkpoints.push(state),
    });
    expect(first.caughtUp).toBe(false);
    expect(checkpoints.length).toBe(1);
    const second = await indexPlans(chain, first.state, h.rpc);
    expect(second.caughtUp).toBe(true);
    expect(second.state.snapshot.plans).toHaveLength(1);
  });
  it('rebuilds from deployment after a changed checkpoint hash', async () => {
    const h = fakeRpc();
    const first = await indexPlans(chain, null, h.rpc);
    first.state.snapshot.blockHash = blockHash(999n);
    h.calls.length = 0;
    const second = await indexPlans(chain, first.state, h.rpc);
    expect(h.calls[0]?.[0]).toBe(1n);
    expect(second.state.snapshot.plans).toHaveLength(1);
  });
  it('does not shrink or advance past an outage', async () => {
    const h = fakeRpc();
    const rpc = async (method: string, params: unknown[]) => {
      if (method === 'eth_getLogs') throw new Error('RPC_UNAVAILABLE');
      return h.rpc(method, params);
    };
    const checkpoint = vi.fn();
    await expect(indexPlans(chain, null, rpc, { onCheckpoint: checkpoint })).rejects.toThrow('RPC_UNAVAILABLE');
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it('does not expose provider credentials in failures', async () => {
    const rpc = rpcClient('https://secret.invalid/key', async () => ({
      ok: true,
      json: async () => ({
        id: 1,
        jsonrpc: '2.0',
        error: { code: -32001, message: 'https://secret.invalid/key rejected' },
      }),
    }));
    await expect(rpc('eth_chainId', [])).rejects.toThrow(/^RPC_REJECTED$/);
  });
  it.each([200, 400])('recognizes provider log-range rejections returned as HTTP %s', async (status) => {
    const rpc = rpcClient(
      'https://secret.invalid/key',
      async () =>
        new Response(
          JSON.stringify({
            id: 1,
            jsonrpc: '2.0',
            error: { code: -32600, message: 'eth_getLogs is limited to a 10 block range: https://secret.invalid/key' },
          }),
          { status },
        ),
    );
    await expect(rpc('eth_getLogs', [{}])).rejects.toThrow(/^RPC_LOG_RANGE$/);
    await expect(rpc('eth_chainId', [])).rejects.not.toThrow('RPC_LOG_RANGE');
  });
  it.each([401, 429, 503])('does not retry HTTP %s failures as smaller log ranges', async (status) => {
    const rpc = rpcClient(
      'https://secret.invalid/key',
      async () =>
        new Response(
          JSON.stringify({ id: 1, jsonrpc: '2.0', error: { code: -32600, message: 'block range rejected' } }),
          { status },
        ),
    );
    await expect(rpc('eth_getLogs', [{}])).rejects.toThrow(/^RPC_UNAVAILABLE$/);
  });
});
