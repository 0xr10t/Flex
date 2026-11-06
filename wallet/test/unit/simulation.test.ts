import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, type Hex } from 'viem';
import { agreeSimulation, checkAnchor, parseSimulation, validateQuorum } from '@flex/protocol/simulation';
import { createSimulator, validateSimulationConfig } from '../../src/chain/simulation.js';
import {
  simulateProviders,
  simulateProvidersConcurrent,
  simulationUrls,
  type SimulationRequest,
} from '../../cre/autopay/lib/simulation.js';
import { EVENTS, simulationPaid } from '../../cre/autopay/lib/due.js';

// Route viem through the in-memory RPC fixture; tor.test.ts exercises the real privacy transport.
vi.mock('../../src/chain/tor-fetch.js', () => ({
  torFetch: () => (input: string | URL | Request, init?: RequestInit) => fetch(input, init),
}));

const address = '0x000000000000000000000000000000000000a11c' as Hex;
const hash = `0x${'ab'.repeat(32)}`;
const anchor = { number: '0x64', hash, timestamp: '0x3e8' };
const logs = [{ address, topics: [`0x${'cd'.repeat(32)}`], data: '0x1234' }];
const raw = () => [{ calls: [{ status: '0x1', gasUsed: '0x5208', logs: structuredClone(logs) }] }];
const parsed = () => parseSimulation(raw(), [1]);
const call = { from: address, to: address, data: '0x' as Hex };

describe('strict simulation agreement shared by wallet and CRE', () => {
  it('accepts two matching observations when a third is unavailable or disagrees', () => {
    const mismatch = raw();
    mismatch[0]!.calls[0]!.logs[0]!.data = '0x5678';
    expect(agreeSimulation([parsed(), parsed(), null], 2)).toEqual(parsed());
    expect(agreeSimulation([parsed(), parsed(), parseSimulation(mismatch, [1])], 2)).toEqual(parsed());
  });
  it('stops when the configured quorum cannot agree, even if one provider answers', () => {
    expect(() => agreeSimulation([parsed(), null, null], 2)).toThrow();
    const mismatch = raw();
    mismatch[0]!.calls[0]!.logs[0]!.data = '0x5678';
    expect(() => agreeSimulation([parsed(), parseSimulation(mismatch, [1])], 2)).toThrow();
  });
  it('rejects thresholds that let a minority authorize a simulation', () => {
    for (const [n, q] of [
      [3, 1],
      [2, 1],
      [3, 4],
      [0, 1],
      [4, 3],
      [3, 1.5],
    ]) {
      expect(() => validateQuorum(n!, q!)).toThrow();
    }
    expect(() => validateQuorum(1, 1)).not.toThrow();
  });
  it('ignores provider-specific metadata and hex case, but retains all event data', () => {
    const alternate = raw();
    Object.assign(alternate[0]!.calls[0]!.logs[0]!, {
      address: address.toUpperCase().replace('0X', '0x'),
      logIndex: '0xff',
    });
    expect(agreeSimulation([parsed(), parseSimulation(alternate, [1])], 2)).toEqual(parsed());
  });
  it.each([
    null,
    [],
    [{ calls: [] }],
    [{ calls: [{ status: '0x1', gasUsed: '0x1' }] }],
    [{ calls: [{ status: 'ok', gasUsed: '0x1', logs: [] }] }],
    [{ calls: [{ status: '0x1', gasUsed: '0x1oops', logs: [] }] }],
    [{ calls: [{ status: '0x1', gasUsed: '0x1', logs: [{ address, topics: [], data: 'invalid' }] }] }],
  ])('rejects malformed or incomplete provider results (%#)', (value) => {
    expect(() => parseSimulation(value, [1])).toThrow();
  });
  it('rejects a different block hash, height or timestamp', () => {
    for (const update of [{ hash: `0x${'ef'.repeat(32)}` }, { number: '0x65' }, { timestamp: '0x3e9' }]) {
      expect(() => checkAnchor({ ...anchor, ...update }, anchor)).toThrow();
    }
  });
  it('rejects duplicate endpoints and unencrypted remote endpoints', () => {
    expect(() =>
      validateSimulationConfig({ rpc_urls: ['https://node.example', 'https://node.example/'], quorum: 2 }),
    ).toThrow();
    expect(() => validateSimulationConfig({ rpc_urls: ['http://remote.example'], quorum: 1 })).toThrow();
    expect(() => validateSimulationConfig({ rpc_urls: ['http://127.0.0.1:8545'], quorum: 1 })).not.toThrow();
  });
});

afterEach(() => vi.unstubAllGlobals());

/** JSON-RPC transport fixture; assertions below still inspect the real viem request payloads. */
async function rpcServer(answer: (method: string, params: unknown[], path: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'https://rpc.example') throw new Error('Unexpected RPC endpoint');
      const body = (await request.json()) as { id: number; method: string; params: unknown[] };
      let result;
      try {
        result = { result: answer(body.method, body.params, url.pathname) };
      } catch {
        result = { error: { code: -32000, message: 'unavailable' } };
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, ...result });
    }),
  );
  return 'https://rpc.example';
}

describe('wallet transport', () => {
  it('pins every provider to the same height and time and tolerates one outage', async () => {
    const requests: unknown[][] = [];
    const url = await rpcServer((method, params, path) => {
      if (path === '/c') throw new Error('offline');
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'eth_getBlockByNumber') {
        expect(params).toEqual(['0x64', false]);
        return anchor;
      }
      requests.push(params);
      return raw();
    });
    const simulate = createSimulator(84532, { rpc_urls: ['/a', '/b', '/c'].map((p) => url + p), quorum: 2 });
    expect(await simulate([{ calls: [call] }], anchor)).toEqual([[{ status: 'success', logs }]]);
    expect(requests).toHaveLength(2);
    for (const params of requests)
      expect(params).toEqual([
        {
          traceTransfers: true,
          validation: false,
          blockStateCalls: [{ calls: [call], blockOverrides: { time: '0x3e9' } }],
        },
        '0x64',
      ]);
  });
  it('rejects wrong-chain and reorg responses without trying another simulation method', async () => {
    const counts = new Map<string, number>();
    const methods: string[] = [];
    const url = await rpcServer((method, _params, path) => {
      methods.push(method);
      if (method === 'eth_chainId') return path === '/b' ? '0x1' : '0x14a34';
      if (method === 'eth_getBlockByNumber') {
        const n = (counts.get(path) ?? 0) + 1;
        counts.set(path, n);
        return { ...anchor, hash: n === 2 ? `0x${'ef'.repeat(32)}` : hash };
      }
      return raw();
    });
    await expect(
      createSimulator(84532, { rpc_urls: [url + '/a', url + '/b'], quorum: 2 })([{ calls: [call] }], anchor),
    ).rejects.toThrow();
    expect(methods).not.toContain('eth_call');
  });
});

describe('CRE provider adapter', () => {
  const args: SimulationRequest = {
    urls: ['https://a.example', 'https://b.example', 'https://c.example'],
    quorum: 2,
    chainId: 84532,
    anchor,
    time: 1001,
    ...call,
  };
  const post = (_url: string, body: unknown) =>
    Array.isArray(body)
      ? [
          { jsonrpc: '2.0', id: 3, result: raw() },
          { jsonrpc: '2.0', id: 1, result: '0x14a34' },
          { jsonrpc: '2.0', id: 2, result: anchor },
        ]
      : { jsonrpc: '2.0', id: 4, result: anchor };
  it('accepts reordered RPC batches and uses at most six HTTP requests per run', () => {
    let calls = 0;
    expect(
      simulateProviders(args, (url, body) => {
        calls++;
        return post(url, body);
      }),
    ).toEqual(parsed());
    expect(calls).toBe(6);
  });
  it('starts independent capability calls before waiting for their results', () => {
    const order: string[] = [];
    expect(
      simulateProvidersConcurrent(args, (url, body) => {
        const phase = Array.isArray(body) ? 'simulate' : 'post-check';
        order.push(`start ${phase} ${url}`);
        return {
          result() {
            order.push(`resolve ${phase} ${url}`);
            return post(url, body);
          },
        };
      }),
    ).toEqual(parsed());
    expect(order).toEqual(
      ['simulate', 'post-check'].flatMap((phase) =>
        ['start', 'resolve'].flatMap((action) => args.urls.map((url) => `${action} ${phase} ${url}`)),
      ),
    );
  });
  it('counts scheduling failures and reorganized post-checks against the original quorum', () => {
    const run = (reorg: boolean) =>
      simulateProvidersConcurrent(args, (url, body) => {
        if (url === args.urls[2]) throw new Error('scheduling unavailable');
        return {
          result: () =>
            reorg && url === args.urls[1] && !Array.isArray(body)
              ? { jsonrpc: '2.0', id: 4, result: { ...anchor, hash: `0x${'ef'.repeat(32)}` } }
              : post(url, body),
        };
      });
    expect(run(false)).toEqual(parsed());
    expect(() => run(true)).toThrow();
  });
  it('rejects duplicate response IDs and wrong block hashes', () => {
    expect(() =>
      simulateProviders(args, () => [1, 1, 3].map((id) => ({ jsonrpc: '2.0', id, result: anchor }))),
    ).toThrow();
    expect(() =>
      simulateProviders(args, (url, body) =>
        Array.isArray(body)
          ? post(url, body)
          : { jsonrpc: '2.0', id: 4, result: { ...anchor, hash: `0x${'ef'.repeat(32)}` } },
      ),
    ).toThrow();
  });
  it('allows a provider outage without reducing the threshold', () => {
    expect(
      simulateProviders(args, (url, body) => {
        if (url === args.urls[2]) throw new Error('offline');
        return post(url, body);
      }),
    ).toEqual(parsed());
    expect(() =>
      simulateProviders(args, (url, body) => {
        if (url !== args.urls[0]) throw new Error('offline');
        return post(url, body);
      }),
    ).toThrow();
  });
  it('uses full secret URLs and rejects local URLs for a deployed DON', () => {
    expect(simulationUrls(JSON.stringify(args.urls), 2)).toEqual(args.urls);
    expect(() => simulationUrls('["http://127.0.0.1:8545"]', 1)).toThrow();
    expect(() => simulationUrls('["https://a.example","https://a.example"]', 2)).toThrow();
  });
  it('requires the exact plan and slot event before submitting a CRE report', () => {
    const id = hash as Hex;
    const sim = {
      status: '0x1',
      gasUsed: 100,
      logs: [
        {
          address,
          topics: encodeEventTopics({ abi: EVENTS, eventName: 'Executed', args: { intentId: id } }) as Hex[],
          data: encodeAbiParameters([{ type: 'uint64' }, { type: 'uint64' }], [2n, 1n]),
        },
      ],
    };
    expect(simulationPaid(sim, address, { id, slot: 2n })).toBe(true);
    expect(simulationPaid(sim, address, { id, slot: 1n })).toBe(false);
    expect(simulationPaid(sim, address, { id: `0x${'ef'.repeat(32)}`, slot: 2n })).toBe(false);
  });
});
