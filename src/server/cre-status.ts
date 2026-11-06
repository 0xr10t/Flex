// Local simulation observations never enter the execution-report or payment-history write paths.
import { readFileSync, statSync } from 'node:fs';

export function readCreStatus(path: string, now = Date.now()) {
  const base = { mode: 'build-and-simulate', broadcast: false, paymentExecuted: false } as const;
  try {
    if (statSync(path).size > 1_000_000) throw new Error('oversized');
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const time = Date.parse(raw.time);
    if (!Number.isFinite(time) || time > now + 60_000) throw new Error('invalid time');
    const states = ['starting', 'qualified', 'simulated', 'simulation_blocked', 'catching_up', 'failed', 'stopped'];
    if (!states.includes(raw.status)) throw new Error('invalid state');
    const stale = now - time > 120_000;
    const results: Array<{ chainId: number; executor: string; planId: string; slot: string; outcome: string }> = [];
    if (raw.result?.mode === 'dry-run' && Array.isArray(raw.result.results)) {
      for (const item of raw.result.results.slice(0, 100)) {
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
            : ['window_closed', 'unavailable', 'reverted', 'success'].includes(item.skipped)
              ? 'blocked'
              : null;
        if (outcome)
          results.push({ chainId: item.chainId, executor: item.executor, planId: item.id, slot: item.slot, outcome });
      }
    }
    return {
      ...base,
      status: stale ? 'stale' : (raw.status as string),
      lastCheckedAt: new Date(time).toISOString(),
      code: typeof raw.code === 'string' && /^[A-Z_]{1,80}$/.test(raw.code) ? raw.code : null,
      results: stale ? [] : results,
    };
  } catch {
    return { ...base, status: 'unavailable', lastCheckedAt: null, code: null, results: [] };
  }
}
