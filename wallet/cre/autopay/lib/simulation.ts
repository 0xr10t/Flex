import {
  agreeSimulation,
  checkAnchor,
  parseSimulation,
  quantity,
  validateQuorum,
  type SimulationAnchor,
  type SimulationResult,
} from '@flex/protocol/simulation';

export interface SimulationRequest {
  urls: string[];
  quorum: number;
  chainId: number;
  anchor: SimulationAnchor;
  time: number;
  from: string;
  to: string;
  data: string;
}

/** Each URL is a full secret, so no vendor-specific API key concatenation is needed. */
export function simulationUrls(secret: string, quorum: number): string[] {
  let urls: unknown;
  try {
    urls = JSON.parse(secret);
  } catch {
    throw new Error('invalid simulation endpoint configuration');
  }
  if (
    !Array.isArray(urls) ||
    urls.some(
      (u) =>
        typeof u !== 'string' ||
        !/^(?:https:\/\/[^\s#]+|http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?(?:\/[^\s#]*)?)$/.test(u),
    ) ||
    new Set(urls).size !== urls.length
  )
    throw new Error('invalid simulation endpoint configuration');
  validateQuorum(urls.length, quorum);
  return urls as string[];
}

/** Compatibility adapter for synchronous callers and local tests. */
export function simulateProviders(
  a: SimulationRequest,
  post: (url: string, body: unknown) => unknown,
): SimulationResult {
  return simulateProvidersConcurrent(a, (url, body) => ({ result: () => post(url, body) }));
}

/** Initiate independent CRE capability handles before resolving them; post-checks stay after simulation. */
export function simulateProvidersConcurrent(
  a: SimulationRequest,
  start: (url: string, body: unknown) => { result(): unknown },
): SimulationResult {
  validateQuorum(a.urls.length, a.quorum);
  const pending = a.urls.map((url) => {
    try {
      return start(url, [
        { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
        { jsonrpc: '2.0', id: 2, method: 'eth_getBlockByNumber', params: [a.anchor.number, false] },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'eth_simulateV1',
          params: [
            {
              blockStateCalls: [
                {
                  calls: [{ from: a.from, to: a.to, data: a.data }],
                  blockOverrides: { time: `0x${a.time.toString(16)}` },
                },
              ],
              validation: false,
              traceTransfers: true,
            },
            a.anchor.number,
          ],
        },
      ]);
    } catch {
      return null;
    }
  });
  const simulations = pending.map((call) => {
    try {
      const body = call?.result();
      if (!Array.isArray(body) || body.length !== 3) return null;
      const replies = new Map(body.map((r) => [r.id, r]));
      if (
        replies.size !== 3 ||
        [1, 2, 3].some((id) => !replies.has(id) || replies.get(id).error || replies.get(id).jsonrpc !== '2.0')
      )
        return null;
      if (quantity(replies.get(1).result) !== BigInt(a.chainId)) return null;
      checkAnchor(replies.get(2).result, a.anchor);
      return parseSimulation(replies.get(3).result, [1]);
    } catch {
      return null;
    }
  });
  const postChecks = simulations.map((result, i) => {
    if (result === null) return null;
    try {
      return start(a.urls[i]!, {
        jsonrpc: '2.0',
        id: 4,
        method: 'eth_getBlockByNumber',
        params: [a.anchor.number, false],
      });
    } catch {
      return null;
    }
  });
  const observations = postChecks.map((call, i) => {
    try {
      const after = call?.result() as { id?: number; jsonrpc?: string; error?: unknown; result?: unknown };
      if (after?.id !== 4 || after.jsonrpc !== '2.0' || after.error) return null;
      checkAnchor(after.result, a.anchor);
      return simulations[i] ?? null;
    } catch {
      return null;
    }
  });
  return agreeSimulation(observations, a.quorum);
}
