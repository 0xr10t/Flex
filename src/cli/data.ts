import { DATA_RESOURCES, parseDataQuery, type DataPage, type DataQuery } from '@flex/protocol';
import type { Line } from './repl.js';
const line = (text: string, tone: 0 | 1 | 2 = 0): Line => [{ text, tone }];
export function dataCatalog(): Line[] {
  return [
    line('Read local data: /get <resource> [filters]', 2),
    ...DATA_RESOURCES.map((s) =>
      line(
        `${s.resource.padEnd(18)} ${s.source} · ${s.tables.join(', ')}${s.sessionScoped ? ' · current session' : ''}`,
        1,
      ),
    ),
    line(
      'Filters: --chain <id|base|arbitrum|sepolia> --token ETH|USDC --status <state> --request <id> --limit 1–100 --offset <n> --json',
      1,
    ),
    line('Only filters listed for a resource are accepted. /get <resource> --help lists them.', 1),
  ];
}
export function parseGetter(
  args: string[],
  sessionId: string,
): { resource: string; query: DataQuery; json: boolean } | Line[] {
  const [name, ...flags] = args;
  const spec = DATA_RESOURCES.find((s) => s.resource === name);
  if (!spec) return name ? [line(`Unknown resource: ${name}. Use /db to see the available getters.`)] : dataCatalog();
  if (flags.includes('--help'))
    return [
      line(`/get ${name} · ${spec.tables.join(', ')}`, 2),
      line(
        `Filters: ${spec.filters.map((k) => '--' + k.replace('_id', '').replace('_', '-')).join(' ') || 'none'}; --limit --offset --json`,
        1,
      ),
    ];
  const raw: Record<string, string> = spec.sessionScoped ? { session_id: sessionId } : {};
  let json = false;
  const names: Record<string, string> = {
    '--chain': 'chain_id',
    '--request': 'request_id',
    '--token': 'token',
    '--status': 'status',
    '--limit': 'limit',
    '--offset': 'offset',
  };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]!;
    if (flag === '--json') {
      if (json) return [line('Use --json once.')];
      json = true;
      continue;
    }
    const key = names[flag];
    const value = flags[++i];
    if (!key || value === undefined || value.startsWith('--') || raw[key] !== undefined)
      return [line('Invalid filters. Use /get <resource> --help.')];
    raw[key] =
      key === 'chain_id'
        ? ({ base: '84532', arbitrum: '421614', sepolia: '11155111' }[value.toLowerCase()] ?? value)
        : key === 'token'
          ? value.toUpperCase()
          : value;
  }
  const query = parseDataQuery(raw, spec);
  return query
    ? { resource: spec.resource, query, json }
    : [line('Invalid filters for this resource. Use /get <resource> --help.')];
}
export function renderData(page: DataPage, json = false): Line[] {
  if (json)
    return JSON.stringify(page, null, 2)
      .split('\n')
      .map((s) => line(s));
  const out: Line[] = [line(`${page.resource} · ${page.source} · ${page.status}`, 2)];
  if (page.as_of) out.push(line(`Snapshot: ${page.as_of}`, 1));
  if (page.status === 'unavailable') return [...out, line('This source is unavailable. Check /status or /doctor.', 1)];
  if (page.status === 'disabled') return [...out, line('Incoming history is disabled in the agent configuration.', 1)];
  if (page.status === 'stale' || page.status === 'partial')
    out.push(line('These are cached or incomplete observations.', 1));
  if (!page.rows.length) out.push(line('No matching records.', 1));
  page.rows.forEach((row, i) => {
    out.push(line(`[${page.offset + i + 1}]`, 2));
    for (const [k, v] of Object.entries(row))
      out.push(line(`${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`));
  });
  out.push(line(`${page.rows.length} of ${page.total} records · offset ${page.offset}`, 1));
  if (page.next_offset !== null) out.push(line(`Next page: repeat this getter with --offset ${page.next_offset}`, 1));
  return out;
}
