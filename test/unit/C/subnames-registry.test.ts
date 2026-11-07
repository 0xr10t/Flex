// §9.6 step 3 read straight from ENSv2 registries' logs (`indexer_kind = "ensv2-registry"`). The JSON-RPC endpoint is faked: it
// answers the registry walk (`ROOT_REGISTRY`, `getSubregistry`, `getResolver`) and `eth_getLogs` from a small in-memory chain.
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionResult,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiItem,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { IndexerUnavailable } from '../../../src/contracts/io.js';
import { createSubnameSource, MAX_LOG_REQUESTS } from '../../../src/recipients/subnames.js';
import { testConfig } from '../../fakes/context.js';

const ROOT = '0x00000000000000000000000000000000000000a1' as Address;
const ETH = '0x00000000000000000000000000000000000000a2' as Address;
const IITR = '0x00000000000000000000000000000000000000a3' as Address;
const RESOLVER = '0x00000000000000000000000000000000000000f1' as Address;
const OWNER = '0x00000000000000000000000000000000000000b1' as Address;
const START = 1_000;
const LATEST = 200_000;
const FAR_FUTURE = 4_000_000_000n;

const ABI = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
]);
const REGISTERED = parseAbiItem(
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
);
const RESERVED = parseAbiItem(
  'event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)',
);
const UNREGISTERED = parseAbiItem('event LabelUnregistered(uint256 indexed tokenId, address indexed sender)');
const EXPIRY = parseAbiItem(
  'event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)',
);

const hash = (label: string) => keccak256(toHex(label));
/** Token id = labelhash with the low 32 bits replaced by the version. */
const tokenId = (label: string, version = 0) => (BigInt(hash(label)) & ~0xffffffffn) | BigInt(version);

interface FakeLog {
  block: number;
  topics: Hex[];
  data: Hex;
}
const registered = (block: number, label: string, expiry = FAR_FUTURE, version = 0): FakeLog => ({
  block,
  topics: encodeEventTopics({
    abi: [REGISTERED],
    args: { tokenId: tokenId(label, version), labelHash: hash(label), sender: OWNER },
  }) as Hex[],
  data: encodeAbiParameters([{ type: 'string' }, { type: 'address' }, { type: 'uint64' }], [label, OWNER, expiry]),
});
const reserved = (block: number, label: string): FakeLog => ({
  block,
  topics: encodeEventTopics({
    abi: [RESERVED],
    args: { tokenId: tokenId(label), labelHash: hash(label), sender: OWNER },
  }) as Hex[],
  data: encodeAbiParameters([{ type: 'string' }, { type: 'uint64' }], [label, FAR_FUTURE]),
});
const unregistered = (block: number, label: string, version = 0): FakeLog => ({
  block,
  topics: encodeEventTopics({
    abi: [UNREGISTERED],
    args: { tokenId: tokenId(label, version), sender: OWNER },
  }) as Hex[],
  data: '0x',
});
const renewed = (block: number, label: string, expiry: bigint, version = 0): FakeLog => ({
  block,
  topics: encodeEventTopics({
    abi: [EXPIRY],
    args: { tokenId: tokenId(label, version), newExpiry: expiry, sender: OWNER },
  }) as Hex[],
  data: '0x',
});

interface Chain {
  /** registry → label → [subregistry, resolver] */
  registries: Record<string, Record<string, [Address, Address]>>;
  logs: Record<string, FakeLog[]>;
  /** The widest `eth_getLogs` range the fake RPC accepts. */
  maxRange?: number;
}

const iitrChain = (logs: FakeLog[], maxRange?: number): Chain => ({
  registries: {
    [ROOT]: { eth: [ETH, RESOLVER] },
    [ETH]: { iitr: [IITR, RESOLVER], lonely: [zeroAddress, RESOLVER] },
    [IITR]: {},
  },
  logs: { [IITR]: logs },
  maxRange,
});

function rpc(chain: Chain) {
  const calls: { method: string; params: unknown[] }[] = [];
  const answer = (method: string, params: unknown[]): unknown => {
    if (method === 'eth_blockNumber') return toHex(LATEST);
    if (method === 'eth_chainId') return toHex(11155111);
    if (method === 'eth_call') {
      const { to, data } = params[0] as { to: Address; data: Hex };
      const call = decodeFunctionData({ abi: ABI, data });
      if (call.functionName === 'ROOT_REGISTRY')
        return encodeFunctionResult({ abi: ABI, functionName: 'ROOT_REGISTRY', result: ROOT });
      const label = call.args[0] as string;
      const key = Object.keys(chain.registries).find((k) => k.toLowerCase() === to.toLowerCase());
      const [sub, res] = (key ? chain.registries[key]?.[label] : undefined) ?? [zeroAddress, zeroAddress];
      return encodeFunctionResult({
        abi: ABI,
        functionName: call.functionName,
        result: call.functionName === 'getSubregistry' ? sub : res,
      });
    }
    if (method === 'eth_getLogs') {
      const f = params[0] as { address: Address; fromBlock: Hex; toBlock: Hex };
      const from = Number(f.fromBlock);
      const to = Number(f.toBlock);
      if (chain.maxRange !== undefined && to - from + 1 > chain.maxRange)
        throw { code: -32600, message: `exceed maximum block range: ${chain.maxRange}` };
      const key = Object.keys(chain.logs).find((k) => k.toLowerCase() === f.address.toLowerCase());
      return (key ? chain.logs[key]! : [])
        .map((l, i) => ({ ...l, i }))
        .filter((l) => l.block >= from && l.block <= to)
        .map((l) => ({
          address: f.address,
          topics: l.topics,
          data: l.data,
          blockNumber: toHex(l.block),
          logIndex: toHex(l.i),
          transactionIndex: '0x0',
          transactionHash: `0x${'11'.repeat(32)}`,
          blockHash: `0x${'22'.repeat(32)}`,
          removed: false,
        }));
    }
    throw { code: -32601, message: `unexpected ${method}` };
  };
  const fetchFn = (async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
    calls.push({ method: req.method, params: req.params });
    let body: unknown;
    try {
      body = { jsonrpc: '2.0', id: req.id, result: answer(req.method, req.params) };
    } catch (error) {
      body = { jsonrpc: '2.0', id: req.id, error };
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

const config = () => {
  const c = testConfig();
  return {
    ...c,
    ens: {
      ...c.ens,
      indexer_kind: 'ensv2-registry' as const,
      indexer_url: 'https://rpc.test',
      registry_start_block: START,
    },
  };
};
const list = (chain: Chain, parent = 'iitr.eth') => {
  const r = rpc(chain);
  return { result: createSubnameSource(config(), r.fetchFn).listChildren(parent), calls: r.calls };
};

describe('listing an organisation from ENSv2 registry logs', () => {
  it('returns the live members, alphabetically', async () => {
    const { result } = list(
      iitrChain([registered(2_000, 'gamma'), registered(2_001, 'alpha'), registered(2_002, 'beta')]),
    );
    expect(await result).toEqual(['alpha.iitr.eth', 'beta.iitr.eth', 'gamma.iitr.eth']);
  });

  it('drops unregistered members, and keeps one registered again under a new token version', async () => {
    const { result } = list(
      iitrChain([
        registered(2_000, 'alpha'),
        registered(2_001, 'mihir'),
        unregistered(2_100, 'alpha'),
        unregistered(2_101, 'mihir'),
        registered(2_200, 'alpha', FAR_FUTURE, 1),
      ]),
    );
    expect(await result).toEqual(['alpha.iitr.eth']);
  });

  it('drops expired members, unless their expiry was extended', async () => {
    const { result } = list(
      iitrChain([
        registered(2_000, 'old', 1n),
        registered(2_001, 'renewed', 1n),
        renewed(2_002, 'renewed', FAR_FUTURE),
      ]),
    );
    expect(await result).toEqual(['renewed.iitr.eth']);
  });

  it('counts reserved names as members (whether each can be paid is decided by resolving it)', async () => {
    const { result } = list(iitrChain([reserved(2_000, 'vip')]));
    expect(await result).toEqual(['vip.iitr.eth']);
  });

  it('leaves out labels that cannot form a subname', async () => {
    const { result } = list(iitrChain([registered(2_000, 'ok'), registered(2_001, 'a.b'), registered(2_002, '[abc]')]));
    expect(await result).toEqual(['ok.iitr.eth']);
  });

  it('reads logs from the configured start block to the latest block', async () => {
    const { result, calls } = list(iitrChain([registered(2_000, 'alpha')]));
    await result;
    const logs = calls.filter((c) => c.method === 'eth_getLogs');
    expect(logs).toHaveLength(1);
    expect(logs[0]?.params[0]).toMatchObject({
      address: getAddress(IITR),
      fromBlock: toHex(START),
      toBlock: toHex(LATEST),
    });
  });

  it('splits a range the RPC refuses and still finds every member', async () => {
    const { result, calls } = list(iitrChain([registered(2_000, 'alpha'), registered(150_000, 'beta')], 50_000));
    expect(await result).toEqual(['alpha.iitr.eth', 'beta.iitr.eth']);
    expect(calls.filter((c) => c.method === 'eth_getLogs').length).toBeGreaterThan(1);
  });

  it('gives up as unavailable when the RPC keeps refusing, within a bounded number of calls', async () => {
    const { result, calls } = list(iitrChain([registered(2_000, 'alpha')], 10));
    await expect(result).rejects.toBeInstanceOf(IndexerUnavailable);
    expect(calls.filter((c) => c.method === 'eth_getLogs').length).toBeLessThanOrEqual(MAX_LOG_REQUESTS);
  });

  it('says when the organisation is not in ENS', async () => {
    expect(await list(iitrChain([]), 'nope.eth').result).toBe('not_found');
    expect(await list(iitrChain([]), 'iitr.nope').result).toBe('not_found');
  });

  it('a name that exists but has no registry of its own is an empty organisation', async () => {
    expect(await list(iitrChain([]), 'lonely.eth').result).toEqual([]);
  });

  it('an RPC failure is "indexer unavailable"', async () => {
    const fetchFn = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    await expect(createSubnameSource(config(), fetchFn).listChildren('iitr.eth')).rejects.toBeInstanceOf(
      IndexerUnavailable,
    );
  });
});
