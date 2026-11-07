/** Read-only local data contract shared by the agent, wallet and terminal. */
export type DataRow = Record<string, unknown>;
export interface DataQuery {
  limit: number;
  offset: number;
  session_id?: string;
  request_id?: string;
  chain_id?: number;
  token?: string;
  status?: string;
}
export interface DataPage {
  resource: string;
  source: 'agent' | 'wallet' | 'cre' | 'history';
  status: 'ok' | 'unavailable' | 'disabled' | 'partial' | 'stale';
  rows: DataRow[];
  total: number;
  limit: number;
  offset: number;
  next_offset: number | null;
  as_of: string | null;
}
export interface DataResource {
  resource: string;
  source: DataPage['source'];
  tables: string[];
  sessionScoped: boolean;
  filters: string[];
}
const resource = (
  name: string,
  source: DataPage['source'],
  tables: string[],
  filters: string[] = [],
  sessionScoped = false,
): DataResource => ({ resource: name, source, tables, sessionScoped, filters });
export const DATA_RESOURCES: readonly DataResource[] = [
  resource('amounts', 'agent', ['db1_amount_placeholders'], ['request_id', 'token'], true),
  resource('contacts', 'agent', ['db2_address_book'], ['chain_id']),
  resource('recipients', 'agent', ['db3_address_placeholders'], ['request_id', 'chain_id'], true),
  resource('balances', 'agent', ['db4_balances'], ['chain_id', 'token', 'status']),
  resource('limits', 'agent', ['db5_limits']),
  resource('transactions', 'agent', ['db6_spend_log'], ['request_id', 'chain_id', 'token', 'status']),
  resource('autopays', 'agent', ['db7_autopays'], ['request_id', 'chain_id', 'token', 'status']),
  resource('session', 'agent', ['db8_sessions'], [], true),
  resource('prompts', 'agent', ['db8_prompts'], ['request_id'], true),
  resource('history', 'agent', ['db8_history'], ['request_id'], true),
  resource('handoffs', 'agent', ['handoff_journal'], ['request_id', 'status']),
  resource('requests', 'wallet', ['requests'], ['request_id']),
  resource('steps', 'wallet', ['steps'], ['request_id', 'status']),
  resource('reports', 'wallet', ['reports'], ['request_id', 'status']),
  resource('wallet-autopays', 'wallet', ['autopays'], ['request_id', 'chain_id', 'token', 'status']),
  resource('watchers', 'wallet', ['watch_cursors'], ['chain_id']),
  resource('approvals', 'wallet', ['wallet_batches'], ['request_id', 'chain_id', 'status']),
  resource('received', 'history', ['incoming-transfer cache'], ['chain_id', 'token']),
  resource('cre-status', 'cre', ['status.json']),
  resource('cre-plans', 'cre', ['index.json'], ['chain_id']),
  resource('cre-submissions', 'cre', ['submissions.json'], ['chain_id', 'status']),
  resource('cre-build', 'cre', ['build.json']),
];
export function parseDataQuery(input: unknown, spec: DataResource): DataQuery | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const allowed = ['limit', 'offset', ...spec.filters, ...(spec.sessionScoped ? ['session_id'] : [])];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) return null;
  const q: DataQuery = { limit: 25, offset: 0 };
  for (const key of ['limit', 'offset', 'chain_id'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !/^(0|[1-9]\d*)$/.test(raw[key])) return null;
    const n = Number(raw[key]);
    if (
      !Number.isSafeInteger(n) ||
      (key === 'limit' && (n < 1 || n > 100)) ||
      (key === 'offset' && n > 1_000_000) ||
      (key === 'chain_id' && ![11155111, 84532, 421614].includes(n))
    )
      return null;
    q[key] = n;
  }
  for (const key of ['session_id', 'request_id', 'token', 'status'] as const) {
    if (raw[key] === undefined) continue;
    const v = raw[key];
    if (typeof v !== 'string') return null;
    if (key === 'session_id' && !/^ses_[0-9a-f]{12}$/.test(v)) return null;
    if (key === 'request_id' && !/^req_[0-9a-f]{12}$/.test(v)) return null;
    if (key === 'token' && !['ETH', 'USDC'].includes(v)) return null;
    if (key === 'status' && !/^[a-z_]{1,40}$/.test(v)) return null;
    q[key] = v;
  }
  return spec.sessionScoped && !q.session_id ? null : q;
}
export function dataPage(
  spec: DataResource,
  q: DataQuery,
  rows: DataRow[],
  total = rows.length,
  status: DataPage['status'] = 'ok',
  as_of: string | null = null,
): DataPage {
  return {
    resource: spec.resource,
    source: spec.source,
    status,
    rows,
    total,
    limit: q.limit,
    offset: q.offset,
    next_offset: q.offset + rows.length < total ? q.offset + rows.length : null,
    as_of,
  };
}
/** Filters bounded file/cache snapshots; SQL stores apply the same filters with bound parameters. */
export function snapshotPage(
  spec: DataResource,
  q: DataQuery,
  rows: DataRow[],
  status: DataPage['status'] = 'ok',
  asOf: string | null = null,
): DataPage {
  const filtered = rows.filter((row) =>
    spec.filters.every(
      (k) => q[k as keyof DataQuery] === undefined || String(row[k]) === String(q[k as keyof DataQuery]),
    ),
  );
  return dataPage(spec, q, filtered.slice(q.offset, q.offset + q.limit), filtered.length, status, asOf);
}
/** Explicit projections prevent signing material in stored payloads from entering read responses. */
export function pickData(value: unknown, fields: readonly string[]): DataRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as DataRow;
  return Object.fromEntries(fields.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
}
