import { bytesToBase64, ok, type HTTPSendRequester } from '@chainlink/cre-sdk';
import { quantity, type SimulationAnchor } from '@flex/protocol/simulation';
import { simulateProvidersConcurrent, type SimulationRequest } from './simulation';
import type { Simulated } from './due';

export const startPost = (sender: HTTPSendRequester, url: string, body: unknown) => {
  const pending = sender.sendRequest({
    url,
    method: 'POST',
    body: bytesToBase64(new TextEncoder().encode(JSON.stringify(body))),
    headers: { 'Content-Type': 'application/json' },
  });
  return {
    result: () => {
      const response = pending.result();
      if (!ok(response)) throw new Error('simulation HTTP unavailable');
      return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
    },
  };
};

export const simulateFetch = (sender: HTTPSendRequester, a: SimulationRequest): Simulated => {
  try {
    return simulateProvidersConcurrent(a, (url, body) => startPost(sender, url, body))[0][0];
  } catch {
    return { status: 'unavailable', gasUsed: 0, logs: [] };
  }
};

/** Receiver-free probe uses exactly the normal simulation/quorum path. It never constructs a CRE report. */
export const qualifyFetch = (
  sender: HTTPSendRequester,
  a: { urls: string[]; quorum: number; chainId: number; now: number },
) => {
  const pending = a.urls.map((url) =>
    startPost(sender, url, { jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['latest', false] }),
  );
  const anchors = pending.map((reply) => {
    try {
      const body = reply.result() as { id?: number; jsonrpc?: string; error?: unknown; result?: SimulationAnchor };
      if (
        body.id !== 1 ||
        body.jsonrpc !== '2.0' ||
        body.error ||
        !body.result ||
        !/^0x[0-9a-fA-F]{64}$/.test(body.result.hash)
      )
        return null;
      quantity(body.result.number);
      quantity(body.result.timestamp);
      return body.result;
    } catch {
      return null;
    }
  });
  // A bad nominated head can only prevent agreement: every provider must check its hash before AND after execution.
  const anchor = anchors.find((v) => v !== null);
  if (!anchor) throw new Error('simulation anchor unavailable');
  const timestamp = Number(quantity(anchor.timestamp));
  if (!Number.isSafeInteger(timestamp) || Math.abs(a.now - timestamp) > 300) throw new Error('simulation anchor stale');
  const simulated = simulateFetch(sender, {
    ...a,
    anchor,
    time: Math.max(a.now, timestamp + 1),
    // An empty, zero-value eth_simulateV1 call is a qualification probe, never a payment or account permission.
    from: '0x0000000000000000000000000000000000000001',
    to: '0x0000000000000000000000000000000000000002',
    data: '0x',
  });
  if (simulated.status !== '0x1') throw new Error('simulation quorum unavailable');
  return {
    chainId: a.chainId,
    blockNumber: anchor.number,
    blockHash: anchor.hash,
    quorum: a.quorum,
    status: 'qualified',
  };
};
