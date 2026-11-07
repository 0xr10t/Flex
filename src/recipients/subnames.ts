// Implements: §9.6 step 3 `list_subnames(parent)` as a SubnameSource for `indexer_kind = "ens-subgraph"`: HTTPS POST
// GraphQL to `ens.indexer_url` (§14.5), direct children of `namehash(parent)` with the reference query, pages of
// 1,000, 10 s timeout per request; error/timeout → IndexerUnavailable (→ ENS_INDEXER_UNAVAILABLE).
// §9.6 step 4 needs "parent unknown to ENS (no domain entity)": the subgraph's domain entity id is the namehash,
// so the parent is looked up by id first.

import { createPublicClient, http, parseAbi, parseAbiItem, zeroAddress, type Address, type PublicClient } from 'viem';
import { namehash } from 'viem/ens';
import { IndexerUnavailable, type SubnameSource } from '../contracts/io.js';
import type { Config } from '../contracts/types.js';
import { isolatedFetch } from '../util/isolated-fetch.js';

export const INDEXER_TIMEOUT_MS = 10_000;
export const PAGE_SIZE = 1000;
/** ensv2-registry: the most `eth_getLogs` calls one listing may make while splitting a range the RPC refuses. */
export const MAX_LOG_REQUESTS = 64;
/** ensv2-registry: a refused range is split in halves down to this many blocks before giving up. */
export const MIN_LOG_SPAN = 1_000n;

/** §9.6 step 3 reference query (verbatim). */
export const SUBNAMES_QUERY = `query Subnames($parent: String!, $skip: Int!) {
  domains(where: { parent: $parent }, first: 1000, skip: $skip, orderBy: name) { name labelName }
}`;

/** Domain entity lookup by id (= namehash) for §9.6 step 4. The subgraph's `domain` argument has type `ID!`. */
export const PARENT_QUERY = `query Parent($id: ID!) {
  domain(id: $id) { id }
}`;

type FetchFn = typeof fetch;

interface GraphQlResponse<T> {
  data?: T;
  errors?: unknown[];
}

/**
 * ENSv2 on Sepolia: ENSNode's Omnigraph. The classic subgraph's query shape doesn't apply there, and §9.6 step 3 asks for this
 * source to be swappable. Pages by cursor. A subname with no canonical name, or with an unknown label (written `[hash]`), can't be
 * resolved or shown to the user, so it's left out.
 */
const OMNIGRAPH_SUBDOMAINS_QUERY = `query Subdomains($name: InterpretedName!, $after: String) {
  domain(by: { name: $name }) {
    id
    subdomains(first: 1000, after: $after) {
      pageInfo { hasNextPage endCursor }
      edges { node { canonical { name { interpreted } } } }
    }
  }
}`;

interface OmnigraphPage {
  domain: {
    subdomains: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{ node: { canonical: { name: { interpreted: string } | null } | null } }>;
    };
  } | null;
}

/**
 * ENSv2 straight from the chain, for when no hosted indexer works. Every ENSv2 name has its own registry contract, and that
 * registry logs each child's plaintext label (`LabelRegistered` / `LabelReserved`). The parent's registry is found by walking
 * root → tld → … with `getSubregistry(label)`, the root coming from the Universal Resolver's `ROOT_REGISTRY()`; its logs since
 * `ens.registry_start_block` are replayed to get the children that are still live. `indexer_url` is a JSON-RPC URL whose
 * `eth_getLogs` serves that whole history (many free plans cap the range or prune old blocks; a refused range is split).
 */
const REGISTRY_ABI = parseAbi([
  'function ROOT_REGISTRY() view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function getResolver(string label) view returns (address)',
]);
const REGISTRY_EVENTS = [
  parseAbiItem(
    'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  ),
  parseAbiItem(
    'event LabelReserved(uint256 indexed tokenId, bytes32 indexed labelHash, string label, uint64 expiry, address indexed sender)',
  ),
  parseAbiItem('event LabelUnregistered(uint256 indexed tokenId, address indexed sender)'),
  parseAbiItem('event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)'),
] as const;

/** A token id is the labelhash with its low 32 bits replaced by a version counter, so the top 224 bits name the label. */
const labelKey = (idOrHash: bigint | string): bigint => BigInt(idOrHash) >> 32n;

interface RegistryLog {
  eventName: string;
  blockNumber: bigint | null;
  logIndex: number | null;
  args: { tokenId?: bigint; labelHash?: string; label?: string; expiry?: bigint; newExpiry?: bigint };
}

function registrySource(config: Config, url: string, fetchFn: FetchFn): SubnameSource {
  const startBlock = BigInt(config.ens.registry_start_block ?? 0);
  const client = createPublicClient({ transport: http(url, { timeout: INDEXER_TIMEOUT_MS, retryCount: 0, fetchFn }) });

  const read = async (address: Address, functionName: 'getSubregistry' | 'getResolver', label: string) =>
    (await client.readContract({ address, abi: REGISTRY_ABI, functionName, args: [label] })) as Address;

  /** All of one registry's label events, oldest first, halving any range the RPC refuses. */
  async function registryLogs(pc: PublicClient, address: Address, latest: bigint): Promise<RegistryLog[]> {
    const out: RegistryLog[] = [];
    let requests = 0;
    const fetchRange = async (from: bigint, to: bigint): Promise<void> => {
      if (++requests > MAX_LOG_REQUESTS) throw new IndexerUnavailable();
      try {
        const logs = await pc.getLogs({
          address,
          events: REGISTRY_EVENTS,
          fromBlock: from,
          toBlock: to,
          strict: false,
        });
        out.push(...(logs as unknown as RegistryLog[]));
      } catch (e) {
        if (e instanceof IndexerUnavailable || to - from < MIN_LOG_SPAN) throw new IndexerUnavailable();
        const mid = from + (to - from) / 2n;
        await fetchRange(from, mid);
        await fetchRange(mid + 1n, to);
      }
    };
    await fetchRange(startBlock, latest);
    const order = (l: RegistryLog) => [l.blockNumber ?? 0n, BigInt(l.logIndex ?? 0)] as const;
    return out.sort((a, b) => {
      const [ab, ai] = order(a);
      const [bb, bi] = order(b);
      return ab !== bb ? (ab < bb ? -1 : 1) : ai < bi ? -1 : ai > bi ? 1 : 0;
    });
  }

  return {
    async listChildren(parent: string): Promise<string[] | 'not_found'> {
      try {
        let registry = (await client.readContract({
          address: config.ens.universal_resolver_address,
          abi: REGISTRY_ABI,
          functionName: 'ROOT_REGISTRY',
        })) as Address;
        const labels = parent.split('.').reverse();
        for (const [i, label] of labels.entries()) {
          const sub = await read(registry, 'getSubregistry', label);
          if (sub === zeroAddress) {
            // The parent itself exists but has never had children: an empty organisation, not an unknown one.
            const last = i === labels.length - 1;
            return last && (await read(registry, 'getResolver', label)) !== zeroAddress ? [] : 'not_found';
          }
          registry = sub;
        }
        const latest = await client.getBlockNumber();
        const live = new Map<bigint, { label: string; expiry: bigint }>();
        for (const log of await registryLogs(client as PublicClient, registry, latest)) {
          const { args } = log;
          if (log.eventName === 'LabelRegistered' || log.eventName === 'LabelReserved') {
            if (typeof args.label !== 'string' || args.labelHash === undefined) continue;
            live.set(labelKey(args.labelHash), { label: args.label, expiry: args.expiry ?? 0n });
          } else if (log.eventName === 'LabelUnregistered' && args.tokenId !== undefined) {
            live.delete(labelKey(args.tokenId));
          } else if (log.eventName === 'ExpiryUpdated' && args.tokenId !== undefined) {
            const entry = live.get(labelKey(args.tokenId));
            if (entry && args.newExpiry !== undefined) entry.expiry = args.newExpiry;
          }
        }
        const now = BigInt(Math.floor(Date.now() / 1000));
        return [...live.values()]
          .filter((e) => e.expiry > now && e.label.length > 0 && !/[.[\]]/.test(e.label))
          .map((e) => `${e.label}.${parent}`)
          .sort();
      } catch {
        throw new IndexerUnavailable();
      }
    },
  };
}

/** anon-rpc over Tor: by default the indexer is queried on its own Tor circuit when `network.socks_proxy` is set. */
export function createSubnameSource(
  config: Config,
  fetchFn: FetchFn = isolatedFetch({ proxy: config.network.socks_proxy, isolation: 'indexer' }),
): SubnameSource {
  const url = config.ens.indexer_url;

  if (config.ens.indexer_kind === 'ensv2-registry') {
    // Privacy fix 6: no indexer URL means group sends are off; the RPC goes over TLS like every other indexer.
    if (url === null || !url.startsWith('https://')) {
      return { listChildren: async () => Promise.reject(new IndexerUnavailable()) };
    }
    return registrySource(config, url, fetchFn);
  }

  async function post<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    // Privacy fix 6: no indexer configured means group sends are off (S6 says so before getting here).
    if (url === null || !url.startsWith('https://')) throw new IndexerUnavailable();
    let body: GraphQlResponse<T>;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw new IndexerUnavailable();
      body = (await res.json()) as GraphQlResponse<T>;
    } catch {
      throw new IndexerUnavailable();
    }
    if ((body.errors !== undefined && body.errors.length > 0) || body.data === undefined || body.data === null) {
      throw new IndexerUnavailable();
    }
    return body.data;
  }

  if (config.ens.indexer_kind === 'ensnode-omnigraph') {
    return {
      async listChildren(parent: string): Promise<string[] | 'not_found'> {
        const names: string[] = [];
        let after: string | null = null;
        for (;;) {
          const page: OmnigraphPage = await post<OmnigraphPage>(OMNIGRAPH_SUBDOMAINS_QUERY, { name: parent, after });
          if (!page.domain) return 'not_found';
          const { edges, pageInfo } = page.domain.subdomains ?? {};
          if (!Array.isArray(edges) || !pageInfo) throw new IndexerUnavailable();
          for (const edge of edges) {
            const name = edge.node?.canonical?.name?.interpreted;
            if (typeof name === 'string' && !name.includes('[')) names.push(name);
          }
          if (!pageInfo.hasNextPage) return names;
          // A page that claims more but gives no way on would otherwise loop forever.
          if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor === after) throw new IndexerUnavailable();
          after = pageInfo.endCursor;
        }
      },
    };
  }

  return {
    async listChildren(parent: string): Promise<string[] | 'not_found'> {
      const id = namehash(parent);
      const found = await post<{ domain: { id: string } | null }>(PARENT_QUERY, { id });
      if (!found.domain) return 'not_found';
      const names: string[] = [];
      for (let skip = 0; ; skip += PAGE_SIZE) {
        const page = await post<{ domains: Array<{ name: string | null; labelName: string | null }> }>(SUBNAMES_QUERY, {
          parent: id,
          skip,
        });
        if (!Array.isArray(page.domains)) throw new IndexerUnavailable();
        for (const d of page.domains) {
          const name =
            typeof d.name === 'string' ? d.name : typeof d.labelName === 'string' ? `${d.labelName}.${parent}` : null;
          if (name !== null) names.push(name);
        }
        if (page.domains.length < PAGE_SIZE) break;
      }
      return names;
    },
  };
}
