import { randomInt } from 'node:crypto';
import type { AllowlistLogger } from '../contracts/io.js';
import type { Address, ChainId } from '../contracts/types.js';
import { HISTORY_LOOKBACK_MS, type ChainHistory, type HistoryReader, type HistorySource } from './types.js';

/** One public account per cache. No persistent history, user prompts, or request-triggered refreshes. */
export class HistoryCache implements HistoryReader {
  private readonly snapshots = new Map<ChainId, ChainHistory>();
  private readonly abort = new AbortController();
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private started = false;

  constructor(private readonly deps: {
    address: Address;
    chains: () => ChainId[];
    source: HistorySource;
    log: AllowlistLogger;
    now?: () => number;
    random?: () => number;
    intervalMs?: number;
  }) {}

  snapshot(chainId: ChainId): ChainHistory | undefined { return this.snapshots.get(chainId); }

  tick(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    this.inflight ??= this.refresh().catch(() => {
      if (!this.abort.signal.aborted) {
        this.snapshots.clear();
        this.deps.log.error({ event: 'history_refresh_failed' });
      }
    }).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async refresh(): Promise<void> {
    const throughMs = (this.deps.now ?? Date.now)();
    const fromMs = throughMs - HISTORY_LOOKBACK_MS;
    const chains = this.deps.chains();
    for (const chain of this.snapshots.keys()) if (!chains.includes(chain)) this.snapshots.delete(chain);
    await Promise.all(chains.map(async (chainId) => {
      let snapshot: ChainHistory;
      try {
        const transfers = await this.deps.source.read(chainId, fromMs, throughMs, this.abort.signal);
        snapshot = { address: this.deps.address, chainId, status: 'ok', fromMs, throughMs, transfers };
      } catch {
        // Never turn failed or truncated history into a zero, and never log provider errors/URLs.
        snapshot = { address: this.deps.address, chainId, status: 'unavailable', fromMs, throughMs, transfers: [] };
        if (!this.abort.signal.aborted) this.deps.log.warn({ event: 'history_unavailable', chain_ids_unavailable: [chainId] });
      }
      if (!this.abort.signal.aborted) this.snapshots.set(chainId, snapshot);
    }));
  }

  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    const schedule = (): void => {
      if (this.abort.signal.aborted) return;
      const random = this.deps.random ?? (() => randomInt(1_000_000) / 1_000_000);
      this.timer = setTimeout(() => void this.tick().finally(schedule), (this.deps.intervalMs ?? 5 * 60_000) * (0.5 + random()));
      this.timer.unref();
    };
    void this.tick().finally(schedule);
  }

  stop(): void {
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.snapshots.clear();
  }
}
