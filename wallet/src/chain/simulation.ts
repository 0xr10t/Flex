import { createPublicClient, http, type Log } from 'viem';
import {
  agreeSimulation,
  checkAnchor,
  parseSimulation,
  quantity,
  validateQuorum,
  type SimulationAnchor,
} from '@flex/protocol/simulation';
import type { SimBlock, SimCallResult } from './gateway.js';

export interface SimulationConfig {
  rpc_urls: string[];
  quorum: number;
}

export function validateSimulationConfig(config: SimulationConfig): void {
  validateQuorum(config.rpc_urls.length, config.quorum);
  const urls = config.rpc_urls.map((value) => {
    const url = new URL(value);
    if (
      url.hash ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    ) {
      throw new Error('simulation RPC must use HTTPS or loopback HTTP');
    }
    return url.href;
  });
  if (new Set(urls).size !== urls.length) throw new Error('simulation RPC endpoints must be distinct');
}

/** Read RPC selects the anchor; independently configured simulators must agree with it and each other. */
export function createSimulator(chainId: number, config: SimulationConfig) {
  validateSimulationConfig(config);
  const clients = config.rpc_urls.map((url) =>
    createPublicClient({
      transport: http(url, { timeout: 10_000, retryCount: 0, fetchOptions: { redirect: 'error' } }),
      ccipRead: false,
    }),
  );
  return async (blocks: SimBlock[], anchor: SimulationAnchor): Promise<SimCallResult[][]> => {
    let time = quantity(anchor.timestamp);
    const payload = {
      traceTransfers: true,
      validation: false,
      blockStateCalls: blocks.map((b) => {
        time = b.time === undefined ? time + 1n : BigInt(b.time);
        return {
          calls: b.calls,
          blockOverrides: { time: `0x${time.toString(16)}` },
          ...(b.stateOverrides ? { stateOverrides: b.stateOverrides } : {}),
        };
      }),
    };
    const observations = await Promise.all(
      clients.map(async (client) => {
        try {
          const request = (method: string, params: unknown[]) =>
            client.request({ method, params } as never) as Promise<unknown>;
          if (quantity(await request('eth_chainId', [])) !== BigInt(chainId)) return null;
          checkAnchor(await request('eth_getBlockByNumber', [anchor.number, false]), anchor);
          const result = parseSimulation(
            await request('eth_simulateV1', [payload, anchor.number]),
            blocks.map((b) => b.calls.length),
          );
          checkAnchor(await request('eth_getBlockByNumber', [anchor.number, false]), anchor);
          return result;
        } catch {
          return null;
        }
      }),
    );
    return agreeSimulation(observations, config.quorum).map((block) =>
      block.map((c) => ({
        status: c.status === '0x1' ? 'success' : 'failure',
        logs: c.logs as unknown as Log[],
      })),
    );
  };
}
