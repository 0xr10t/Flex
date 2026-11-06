// Implements: §8.1 S0 — Refresh balances (code): steps 1–5 (parallel eth_getBalance + USDC balanceOf per allowed
// chain via anon-rpc, bigint → decimal strings, DB4 upsert ok, failure → both rows unavailable + note, all
// unavailable → BALANCES_UNAVAILABLE). §14.5 RPC part: one viem public client per chain, http(rpc_url), 10 s
// timeout, no retries. FR-02, NFR-07, I-12. §13.1 note "{Chain} balance couldn't be read right now, …".
// S0 runs only for new messages (the runner never calls it for answers; it asks no questions, so no onAnswer).
// Owner: Lane B.

import { createPublicClient, erc20Abi, http, type PublicClient, type Transport } from 'viem';
import { NOTES, joinList } from '../contracts/catalog.js';
import type { RpcClients } from '../contracts/io.js';
import { fromBaseUnits } from '../contracts/money.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import { TOKEN_DECIMALS, type ChainId, type Config } from '../contracts/types.js';
import { chainName } from '../lexical/step-util.js';

/** §14.5: 10 s timeout, no retries inside a request. */
const RPC_TIMEOUT_MS = 10_000;

/** §14.5 transport options: 10 s timeout, no retries. */
export const RPC_TRANSPORT_OPTIONS = { timeout: RPC_TIMEOUT_MS, retryCount: 0 } as const;

/** Builds the transport for one chain; unit tests replace it (no network). */
export type RpcTransportFactory = (rpc_url: string) => Transport;

const httpTransport: RpcTransportFactory = (rpc_url) => http(rpc_url, RPC_TRANSPORT_OPTIONS);

/** Production RPC clients (§14.5): one viem public client per chain. */
export function createRpcClients(config: Config, transportFor: RpcTransportFactory = httpTransport): RpcClients {
  const clients = new Map<ChainId, { client: PublicClient; usdc: `0x${string}` }>();
  for (const c of config.chains) {
    clients.set(c.chain_id, {
      client: createPublicClient({ transport: transportFor(c.rpc_url) }),
      usdc: c.usdc_address,
    });
  }
  const get = (chain_id: ChainId): { client: PublicClient; usdc: `0x${string}` } => {
    const c = clients.get(chain_id);
    if (!c) throw new Error('chain not configured');
    return c;
  };
  const wallet = config.wallet.address;
  return {
    async getEthBalance(chain_id) {
      return get(chain_id).client.getBalance({ address: wallet, blockTag: 'latest' });
    },
    async getUsdcBalance(chain_id) {
      const c = get(chain_id);
      return c.client.readContract({ address: c.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] });
    },
  };
}

async function s0Step(ctx: StepContext): Promise<StepResult> {
  const { req, repos, rpc, config, limits } = ctx;
  const nowIso = ctx.now().toUTC().toISO() ?? new Date().toISOString();
  const chains = limits.allowed_chain_ids;
  const results = await Promise.all(
    chains.map(async (chain_id) => {
      try {
        const [eth, usdc] = await Promise.all([rpc.getEthBalance(chain_id), rpc.getUsdcBalance(chain_id)]);
        return { chain_id, ok: true as const, eth, usdc };
      } catch {
        return { chain_id, ok: false as const };
      }
    }),
  );
  const unavailable: ChainId[] = [];
  for (const r of results) {
    const name = chainName(config, r.chain_id);
    if (r.ok) {
      for (const [token, units] of [
        ['ETH', r.eth],
        ['USDC', r.usdc],
      ] as const) {
        repos.db4.upsertOk(
          {
            chain_id: r.chain_id,
            chain: name,
            token,
            balance: fromBaseUnits(units, TOKEN_DECIMALS[token]),
            base_units: units.toString(),
          },
          nowIso,
        );
      }
    } else {
      repos.db4.markUnavailable(r.chain_id, name, nowIso);
      unavailable.push(r.chain_id);
    }
  }
  if (unavailable.length > 0) {
    ctx.log.warn({
      event: 'balances_unavailable',
      step: 's0',
      session_id: req.session_id,
      request_id: req.request_id,
      chain_ids_unavailable: unavailable,
    });
  }
  if (chains.length > 0 && unavailable.length === chains.length) {
    return {
      kind: 'error',
      code: 'BALANCES_UNAVAILABLE',
      params: { chains: joinList(unavailable.map((c) => chainName(config, c))) },
    };
  }
  for (const c of unavailable) req.notes.push(NOTES.CHAIN_UNREADABLE({ chain: chainName(config, c) }));
  req.state = 'BALANCES_REFRESHED';
  return { kind: 'continue' };
}

export const s0: StepEntry = { step: s0Step };
