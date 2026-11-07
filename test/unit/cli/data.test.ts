import { expect, it } from 'vitest';
import { parseGetter, renderData } from '../../../src/cli/data.js';
it('maps CLI chain aliases and refuses irrelevant filters and duplicate arguments', () => {
  expect(
    parseGetter(['transactions', '--chain', 'base', '--token', 'usdc', '--limit', '10', '--json'], 'ses_000000000001'),
  ).toEqual({ resource: 'transactions', query: { chain_id: 84532, token: 'USDC', limit: 10, offset: 0 }, json: true });
  expect(Array.isArray(parseGetter(['contacts', '--token', 'ETH'], 'ses_000000000001'))).toBe(true);
  expect(Array.isArray(parseGetter(['contacts', '--limit', '10', '--limit', '20'], 'ses_000000000001'))).toBe(true);
});
it('always uses the current session for ephemeral records', () => {
  expect(parseGetter(['prompts'], 'ses_000000000001')).toMatchObject({ query: { session_id: 'ses_000000000001' } });
  expect(Array.isArray(parseGetter(['prompts', '--session', 'ses_ffffffffffff'], 'ses_000000000001'))).toBe(true);
});
it('shows pagination and preserves full addresses in JSON copy output', () => {
  const page = {
    resource: 'contacts',
    source: 'agent' as const,
    status: 'ok' as const,
    rows: [{ address: '0x1234567890123456789012345678901234567890' }],
    total: 2,
    limit: 1,
    offset: 0,
    next_offset: 1,
    as_of: null,
  };
  expect(
    renderData(page)
      .flat()
      .map((x) => x.text)
      .join('\n'),
  ).toContain('--offset 1');
  expect(
    JSON.parse(
      renderData(page, true)
        .map((l) => l.map((s) => s.text).join(''))
        .join('\n'),
    ),
  ).toEqual(page);
});
