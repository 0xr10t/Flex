// Implements: §9.6 step 3 `list_subnames(parent)` as a SubnameSource for `indexer_kind = "ens-subgraph"`: HTTPS POST
// GraphQL to `ens.indexer_url` (§14.5), direct children of `namehash(parent)` with the reference query, pages of
// 1,000, 10 s timeout per request; error/timeout → IndexerUnavailable (→ ENS_INDEXER_UNAVAILABLE).
// §9.6 step 4 needs "parent unknown to ENS (no domain entity)": the subgraph's domain entity id is the namehash,
// so the parent is looked up by id first.

import { namehash } from 'viem/ens';
import { IndexerUnavailable, type SubnameSource } from '../contracts/io.js';
import type { Config } from '../contracts/types.js';
import { isolatedFetch } from '../util/isolated-fetch.js';

export const INDEXER_TIMEOUT_MS = 10_000;
export const PAGE_SIZE = 1000;

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

/** anon-rpc over Tor: by default the indexer is queried on its own Tor circuit when `network.socks_proxy` is set. */
export function createSubnameSource(
  config: Config,
  fetchFn: FetchFn = isolatedFetch({ proxy: config.network.socks_proxy, isolation: 'indexer' }),
): SubnameSource {
  const url = config.ens.indexer_url;

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
