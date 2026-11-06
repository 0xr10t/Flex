// Implements: §8.1 S0 — Balances (code). Privacy fix 8: balances are read on a background timer with jitter
// (`startBalanceRefresher`), never because a message arrived, so the RPC can't tell when you use the agent. S0 reads DB4;
// only a chain that has never been read is read during a message (cold start). `refreshBalances` is §8.1 steps 1–4:
// parallel eth_getBalance + USDC balanceOf per chain via anon-rpc, bigint → decimal strings, DB4 upsert ok, failure → both
// rows unavailable (old values kept). S0 adds the §13.1 note for each unavailable chain; all unavailable →
// BALANCES_UNAVAILABLE. §14.5 RPC part: one viem public client per chain, http(rpc_url), 10 s timeout, no retries; the
// clients share one connection pool of their own with random JSON-RPC ids (fix 7) and never follow CCIP-Read (fix 3).
// FR-02, NFR-07, I-12. S0 runs only for new messages (the runner never calls it for answers; it asks no questions).
// Owner: Lane B.

import { randomInt } from 'node:crypto';
import { createPublicClient, erc20Abi, type PublicClient, type Transport } from 'viem';
import { NOTES, joinList } from '../contracts/catalog.js';
import type { AllowlistLogger, RpcClients } from '../contracts/io.js';
import { fromBaseUnits } from '../contracts/money.js';
import type { Repos } from '../contracts/repos.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import { TOKEN_DECIMALS, type ChainId, type Config } from '../contracts/types.js';
import { chainName } from '../lexical/step-util.js';
import { isolatedHttp } from '../util/isolated-fetch.js';

/** §14.5: 10 s timeout, no retries inside a request. */
const RPC_TIMEOUT_MS = 10_000;

/** §14.5 transport options: 10 s timeout, no retries. */
export const RPC_TRANSPORT_OPTIONS = { timeout: RPC_TIMEOUT_MS, retryCount: 0 } as const;

/** Builds the transport for one chain; unit tests replace it (no network). */
export type RpcTransportFactory = (rpc_url: string) => Transport;

/** Production RPC clients (§14.5): one viem public client per chain. */
export function createRpcClients(
  config: Config,
  transportFor: RpcTransportFactory = isolatedHttp(RPC_TIMEOUT_MS),
): RpcClients {
  const clients = new Map<ChainId, { client: PublicClient; usdc: `0x${string}` }>();
  for (const c of config.chains) {
    clients.set(c.chain_id, {
      // Fix 3: a contract that answers with an offchain lookup would make viem fetch a URL it names, outside anon-rpc.
      client: createPublicClient({ transport: transportFor(c.rpc_url), ccipRead: false }),
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

export interface RefreshDeps {
  rpc: RpcClients;
  repos: Repos;
  config: Config;
}

/** §8.1 steps 1–4 for `chains`, in parallel. Returns the chains that couldn't be read. */
export async function refreshBalances(d: RefreshDeps, chains: ChainId[], nowIso: string): Promise<ChainId[]> {
  const results = await Promise.all(
    chains.map(async (chain_id) => {
      try {
        const [eth, usdc] = await Promise.all([d.rpc.getEthBalance(chain_id), d.rpc.getUsdcBalance(chain_id)]);
        return { chain_id, ok: true as const, eth, usdc };
      } catch {
        return { chain_id, ok: false as const };
      }
    }),
  );
  const unavailable: ChainId[] = [];
  for (const r of results) {
    const name = chainName(d.config, r.chain_id);
    if (!r.ok) {
      d.repos.db4.markUnavailable(r.chain_id, name, nowIso);
      unavailable.push(r.chain_id);
      continue;
    }
    for (const [token, units] of [
      ['ETH', r.eth],
      ['USDC', r.usdc],
    ] as const) {
      d.repos.db4.upsertOk(
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
  }
  return unavailable;
}

/** Fix 8: mean time between background balance reads. ponytail: a constant; make it a setting if anyone needs another. */
export const BALANCE_REFRESH_MS = 5 * 60_000;

export interface BalanceRefresher {
  /** One read of every allowed chain, as the timer does. */
  tick(): Promise<void>;
  stop(): void;
}

/**
 * Fix 8: reads every allowed chain (DB5) now, then again after 0.5–1.5 × `intervalMs`, for as long as it runs. The jitter
 * keeps the reads from forming a pattern of their own.
 */
export function startBalanceRefresher(
  d: RefreshDeps & { log: AllowlistLogger },
  o: { intervalMs?: number; random?: () => number; nowIso?: () => string } = {},
): BalanceRefresher {
  const intervalMs = o.intervalMs ?? BALANCE_REFRESH_MS;
  const random = o.random ?? ((): number => randomInt(1_000_000) / 1_000_000);
  const nowIso = o.nowIso ?? (() => new Date().toISOString());
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    try {
      const unavailable = await refreshBalances(d, d.repos.db5.getAll().allowed_chain_ids, nowIso());
      if (unavailable.length > 0) d.log.warn({ event: 'balances_unavailable', chain_ids_unavailable: unavailable });
    } catch {
      d.log.error({ event: 'balance_refresh_failed' });
    }
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => void tick().finally(schedule), intervalMs * (0.5 + random()));
    timer.unref();
  };
  void tick().finally(schedule);
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

async function s0Step(ctx: StepContext): Promise<StepResult> {
  const { req, repos, config, limits } = ctx;
  const chains = limits.allowed_chain_ids;
  const hasRows = (c: ChainId): boolean =>
    repos.db4.get(c, 'ETH') !== undefined && repos.db4.get(c, 'USDC') !== undefined;
  // Cold start only: a chain the refresher has never read is read now, once.
  const unread = chains.filter((c) => !hasRows(c));
  if (unread.length > 0) {
    await refreshBalances(ctx, unread, ctx.now().toUTC().toISO() ?? new Date().toISOString());
  }
  const unavailable = chains.filter(
    (c) => repos.db4.get(c, 'ETH')?.status !== 'ok' || repos.db4.get(c, 'USDC')?.status !== 'ok',
  );
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
