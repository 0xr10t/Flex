import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotPage, pickData, type DataPage, type DataQuery, type DataResource, type DataRow } from '@flex/protocol';
import type { Config } from '../contracts/types.js';
import type { HistoryReader } from '../history/types.js';
import { HISTORY_MAX_AGE_MS } from '../history/types.js';
import { fromBaseUnits } from '../contracts/money.js';
import { readCreStatus } from './cre-status.js';

export function readReceived(
  spec: DataResource,
  query: DataQuery,
  config: Config,
  history: HistoryReader | undefined,
  now: number,
): DataPage {
  if (!config.history?.enabled) return snapshotPage(spec, query, [], 'disabled');
  const rows: DataRow[] = [];
  let missing = 0;
  let stale = false;
  const times: number[] = [];
  for (const chain of config.chains) {
    if (query.chain_id !== undefined && chain.chain_id !== query.chain_id) continue;
    const snapshot = history?.snapshot(chain.chain_id);
    if (
      !snapshot ||
      snapshot.status !== 'ok' ||
      snapshot.address.toLowerCase() !== config.wallet.address.toLowerCase()
    ) {
      missing++;
      continue;
    }
    times.push(snapshot.throughMs);
    stale ||= now - snapshot.throughMs > HISTORY_MAX_AGE_MS;
    for (const tx of snapshot.transfers)
      rows.push({
        id: tx.id,
        chain_id: chain.chain_id,
        tx_hash: tx.hash,
        from: tx.from,
        to: tx.to,
        token: tx.token,
        amount: fromBaseUnits(tx.units, tx.token === 'ETH' ? 18 : 6),
        base_units: String(tx.units),
        received_at: new Date(tx.timestampMs).toISOString(),
      });
  }
  rows.sort(
    (a, b) => String(b.received_at).localeCompare(String(a.received_at)) || String(a.id).localeCompare(String(b.id)),
  );
  return snapshotPage(
    spec,
    query,
    rows,
    !times.length ? 'unavailable' : missing ? 'partial' : stale ? 'stale' : 'ok',
    times.length ? new Date(Math.min(...times)).toISOString() : null,
  );
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export function readCreData(spec: DataResource, query: DataQuery, directory: string, now: number): DataPage {
  if (spec.resource === 'cre-status') {
    const status = readCreStatus(join(directory, 'status.json'), now);
    return snapshotPage(
      spec,
      query,
      [status],
      status.status === 'unavailable' ? 'unavailable' : status.status === 'stale' ? 'stale' : 'ok',
      status.lastCheckedAt,
    );
  }
  try {
    const name = spec.tables[0]!;
    const path = join(directory, name);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 10_000_000) throw new Error('invalid snapshot');
    const raw = record(JSON.parse(readFileSync(path, 'utf8')));
    const rows: DataRow[] = [];
    if (spec.resource === 'cre-build') {
      if (
        typeof raw.sourceHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.sourceHash) ||
        typeof raw.wasmHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(raw.wasmHash) ||
        typeof raw.builtAt !== 'string' ||
        !Number.isFinite(Date.parse(raw.builtAt))
      )
        throw new Error('invalid manifest');
      rows.push(pickData(raw, ['sourceHash', 'wasmHash', 'builtAt']));
    } else {
      if (raw.version !== 1) throw new Error('unknown version');
      if (spec.resource === 'cre-plans') {
        if (!raw.chains || typeof raw.chains !== 'object' || Array.isArray(raw.chains))
          throw new Error('invalid index');
        for (const [chain, value] of Object.entries(record(raw.chains))) {
          const snapshot = record(record(value).snapshot);
          for (const plan of list(snapshot.plans))
            rows.push({
              chain_id: Number(chain),
              block_number: snapshot.blockNumber,
              ...pickData(plan, ['id', 'startAt', 'interval', 'lateWindow', 'maxRuns', 'lastSlot', 'cancelled']),
            });
        }
      } else {
        if (!raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries))
          throw new Error('invalid journal');
        for (const entry of Object.values(record(raw.entries))) {
          const value = record(entry);
          rows.push({
            chain_id: value.chainId,
            status: value.state,
            ...pickData(value, ['id', 'executor', 'slot', 'tx', 'code', 'startedAt', 'transmitter', 'nonce']),
          });
        }
      }
    }
    return snapshotPage(spec, query, rows, 'ok', stat.mtime.toISOString());
  } catch {
    return snapshotPage(spec, query, [], 'unavailable');
  }
}
