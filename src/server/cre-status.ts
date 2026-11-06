// Local simulation observations never enter the execution-report or payment-history write paths.
import { readFileSync, statSync } from 'node:fs';

export function readCreStatus(path: string, now = Date.now()) {
  const base = { mode: 'build-and-simulate', broadcast: false, paymentExecuted: false } as const;
  try {
    if (statSync(path).size > 1_000_000) throw new Error('oversized');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const time = Date.parse(raw.time);
    if (!Number.isFinite(time) || time > now + 60_000) throw new Error('invalid time');
    const states = [
      'starting',
      'qualified',
      'simulated',
      'simulation_blocked',
      'catching_up',
      'failed',
      'stopped',
      'broadcast_checked',
    ];
    if (!states.includes(raw.status)) throw new Error('invalid state');
    const stale = now - time > 120_000;
    const results: Array<{
      chainId: number;
      executor: string;
      planId: string;
      slot: string;
      outcome: string;
      txHash?: string;
      code?: string;
    }> = [];
    const broadcast = raw.result?.mode === 'testnet-broadcast' && raw.broadcast === true;
    const chains: Array<{ chainId: number; status: string; code: string | null }> = [];
    if (
      ['dry-run', 'testnet-dry-run', 'testnet-broadcast'].includes(raw.result?.mode) &&
      Array.isArray(raw.result.results)
    ) {
      for (const item of raw.result.results.slice(0, 100)) {
        if (
          [11155111, 84532, 421614].includes(item.chainId) &&
          ['idle', 'waiting_finality', 'blocked'].includes(item.status)
        )
          chains.push({
            chainId: item.chainId,
            status: item.status,
            code: typeof item.code === 'string' && /^[A-Z_]{1,80}$/.test(item.code) ? item.code : null,
          });
        if (
          ![11155111, 84532, 421614].includes(item.chainId) ||
          !/^0x[0-9a-fA-F]{40}$/.test(item.executor) ||
          !/^0x[0-9a-fA-F]{64}$/.test(item.id) ||
          !/^\d{1,20}$/.test(item.slot)
        )
          continue;
        const outcome =
          item.status === 'would_execute'
            ? 'would_execute'
            : broadcast &&
                ['submitted', 'pending', 'mined'].includes(item.status) &&
                /^0x[0-9a-fA-F]{64}$/.test(item.tx)
              ? 'submitted'
              : item.status === 'blocked' ||
                  ['failed', 'receiver_failed'].includes(item.status) ||
                  ['window_closed', 'unavailable', 'reverted', 'success', '0x0', '0x1'].includes(item.skipped)
                ? 'blocked'
                : null;
        if (outcome)
          results.push({
            chainId: item.chainId,
            executor: item.executor,
            planId: item.id,
            slot: item.slot,
            outcome,
            ...(outcome === 'submitted' ? { txHash: item.tx } : {}),
            ...(typeof item.code === 'string' && /^[A-Z_]{1,80}$/.test(item.code) ? { code: item.code } : {}),
          });
      }
    }
    return {
      ...base,
      broadcast,
      status: stale ? 'stale' : (raw.status as string),
      lastCheckedAt: new Date(time).toISOString(),
      code: typeof raw.code === 'string' && /^[A-Z_]{1,80}$/.test(raw.code) ? raw.code : null,
      results: stale ? [] : results,
      chains: stale ? [] : chains,
    };
  } catch {
    return { ...base, status: 'unavailable', lastCheckedAt: null, code: null, results: [], chains: [] };
  }
}
