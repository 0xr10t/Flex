import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DATA_RESOURCES, parseDataQuery } from '@flex/protocol';
import { readCreData, readReceived } from '../../../src/server/data-snapshots.js';
import { testConfig } from '../../fakes/context.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const spec = (name: string) => DATA_RESOURCES.find((s) => s.resource === name)!;
const q = { limit: 25, offset: 0 };
it('projects CRE plans without redeem data and reports malformed snapshots as unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flex-cre-data-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'index.json'),
    JSON.stringify({
      version: 1,
      chains: {
        84532: {
          snapshot: {
            blockNumber: '123',
            plans: [{ id: 'plan', redeem: 'SECRET_SIGNED_REDEEM', startAt: '12', lastSlot: '0' }],
          },
        },
      },
    }),
  );
  const result = readCreData(spec('cre-plans'), q, dir, Date.now());
  expect(result.total).toBe(1);
  expect(result.rows[0]).toMatchObject({ chain_id: 84532, id: 'plan', block_number: '123' });
  expect(JSON.stringify(result)).not.toContain('SECRET_SIGNED_REDEEM');
  writeFileSync(join(dir, 'index.json'), '{broken');
  expect(readCreData(spec('cre-plans'), q, dir, Date.now()).status).toBe('unavailable');
});
it('keeps submission states distinct from confirmed payment execution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flex-cre-data-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'submissions.json'),
    JSON.stringify({
      version: 1,
      entries: { a: { chainId: 84532, id: 'plan', state: 'mined', tx: 'hash', raw_tx: 'SECRET_RAW' } },
    }),
  );
  const result = readCreData(spec('cre-submissions'), { ...q, status: 'mined' }, dir, Date.now());
  expect(result.rows[0]).toMatchObject({ status: 'mined', tx: 'hash' });
  expect(JSON.stringify(result)).not.toMatch(/paymentExecuted|SECRET_RAW/);
});
it('renders incoming integer units exactly and marks stale cached history', () => {
  const config = testConfig();
  config.history = { enabled: true, sources: [] };
  const now = Date.now(),
    then = now - 3600000;
  const result = readReceived(
    spec('received'),
    { ...q, chain_id: 84532 },
    config,
    {
      snapshot: () => ({
        address: config.wallet.address,
        chainId: 84532,
        status: 'ok',
        fromMs: then - 1000,
        throughMs: then,
        transfers: [
          {
            id: 'a',
            hash: `0x${'ab'.repeat(32)}`,
            from: config.wallet.address,
            to: config.wallet.address,
            token: 'ETH',
            units: 123456789123456789n,
            timestampMs: then,
          },
        ],
      }),
    },
    now,
  );
  expect(result.status).toBe('stale');
  expect(result.rows[0]?.amount).toBe('0.123456789123456789');
  expect(() => JSON.stringify(result)).not.toThrow();
});
it('validates supported filters, duplicate arrays and integer bounds', () => {
  expect(parseDataQuery({ limit: '0' }, spec('contacts'))).toBeNull();
  expect(parseDataQuery({ limit: ['1', '2'] }, spec('contacts'))).toBeNull();
  expect(parseDataQuery({ chain_id: '84532', token: 'ETH' }, spec('contacts'))).toBeNull();
  expect(parseDataQuery({ offset: '-1' }, spec('transactions'))).toBeNull();
});
