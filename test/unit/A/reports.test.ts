// Lane A unit tests: §14.3 POST /v1/execution/reports (intent_result for i/j/k/l steps, autopay_payment,
// autopay_status, 404/400/204 rules), §11.4 last row, §16.4 report token, §18 no report content in logs.
// Real SQLCipher DB; Fastify `inject`; no socket.
import { getAddress } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db6Insert } from '../../../src/contracts/repos.js';
import type { Address } from '../../../src/contracts/types.js';
import { openTempDb, type TempDb } from './helpers.js';
import { REPORT_TOKEN, makeServer, type ServerHarness } from './server-harness.js';

const URL = '/v1/execution/reports';
const NOW = '2026-11-05T17:30:00.000Z';
const EXEC_AT = '2026-11-05T10:00:00.000Z';
const TX = `0x${'ab'.repeat(32)}`;
const DELEGATE_LOWER = '0x91ab2c3d4e5f60718293a4b5c6d7e8f9012377d0';
const DELEGATE_EIP55 = getAddress(DELEGATE_LOWER);
const RECIPIENT = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E' as Address;

let t: TempDb;
let s: ServerHarness<TempDb['repos']>;

const db6 = (over: Partial<Db6Insert>): Db6Insert => ({
  request_id: 'req_000000000001',
  step: 0,
  kind: 'payment',
  counts_toward_limit: true,
  chain_id: 84532,
  token: 'USDC',
  amount: '10',
  recipient_address: RECIPIENT,
  intent_id: 'i',
  autopay_id: null,
  status: 'pending',
  tx_hash: null,
  created_at: '2026-11-05T09:00:00.000Z',
  executed_at: null,
  ...over,
});

function autopay(autopay_id: string, request_id: string): void {
  t.repos.db7.insertPending(
    {
      autopay_id: autopay_id as `ap_${string}`,
      request_id,
      recipient_name: 'Mihir',
      recipient_address: RECIPIENT,
      chain_id: 84532,
      token: 'USDC',
      amount_per_payment: '10',
      schedule_json: '{"frequency":"weekly"}',
    },
    '2026-11-05T09:00:00.000Z',
  );
}

const dump = (): unknown => ({
  db6: t.db.prepare('SELECT * FROM db6_spend_log ORDER BY id').all(),
  db7: t.db.prepare('SELECT * FROM db7_autopays ORDER BY autopay_id').all(),
});
const rows6 = (request_id: string): Array<Record<string, unknown>> =>
  t.db.prepare('SELECT * FROM db6_spend_log WHERE request_id = ? ORDER BY id').all(request_id) as Array<
    Record<string, unknown>
  >;
const ap = (id: string): Record<string, unknown> =>
  t.db.prepare('SELECT * FROM db7_autopays WHERE autopay_id = ?').get(id) as Record<string, unknown>;
const post = (body: unknown) => s.call('POST', URL, { token: REPORT_TOKEN, body });

beforeEach(() => {
  t = openTempDb();
  t.repos.db5.insertDefaultsIfMissing(NOW);
  s = makeServer({ repos: t.repos });
});

describe('§14.3 intent_result', () => {
  it('C-351 i: DB6 rows of this request+step become executed with tx_hash and executed_at; others untouched', async () => {
    t.repos.db6.insertMany([db6({ step: 0 }), db6({ step: 1 }), db6({ request_id: 'req_000000000002', step: 0 })]);
    const r = await post({
      kind: 'intent_result',
      request_id: 'req_000000000001',
      step: 0,
      status: 'executed',
      tx_hash: TX,
      executed_at: EXEC_AT,
    });
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
    const mine = rows6('req_000000000001');
    expect(mine[0]).toMatchObject({ step: 0, status: 'executed', tx_hash: TX, executed_at: EXEC_AT });
    expect(mine[1]).toMatchObject({ step: 1, status: 'pending', tx_hash: null, executed_at: null });
    expect(rows6('req_000000000002')[0]).toMatchObject({ status: 'pending', tx_hash: null });
  });

  it('C-351 i: a failed step is recorded as failed', async () => {
    t.repos.db6.insertMany([db6({})]);
    const r = await post({ kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'failed' });
    expect(r.status).toBe(204);
    expect(rows6('req_000000000001')[0]).toMatchObject({ status: 'failed', tx_hash: null, executed_at: null });
  });

  it('C-351 j: both bridge_out and bridge_buffer rows of the step are updated', async () => {
    t.repos.db6.insertMany([
      db6({ kind: 'bridge_out', counts_toward_limit: false, intent_id: 'j' }),
      db6({ kind: 'bridge_buffer', counts_toward_limit: true, intent_id: 'j' }),
    ]);
    const r = await post({
      kind: 'intent_result',
      request_id: 'req_000000000001',
      step: 0,
      status: 'executed',
      tx_hash: TX,
      executed_at: EXEC_AT,
    });
    expect(r.status).toBe(204);
    for (const row of rows6('req_000000000001')) {
      expect(row).toMatchObject({ status: 'executed', tx_hash: TX, executed_at: EXEC_AT });
    }
  });

  describe('k step (autopay creation)', () => {
    beforeEach(() => {
      t.repos.db6.insertMany([
        db6({ kind: 'autopay_prefund', counts_toward_limit: false, intent_id: 'k', autopay_id: 'ap_00000000000a' }),
      ]);
      autopay('ap_00000000000a', 'req_000000000001');
    });

    it('C-351 k: executed → prefund row executed; DB7 active with EIP-55 delegate_address and cre_job_id', async () => {
      const r = await post({
        kind: 'intent_result',
        request_id: 'req_000000000001',
        step: 0,
        status: 'executed',
        tx_hash: TX,
        executed_at: EXEC_AT,
        autopay: { autopay_id: 'ap_00000000000a', delegate_address: DELEGATE_LOWER, cre_job_id: 'job-123' },
      });
      expect(r.status).toBe(204);
      expect(rows6('req_000000000001')[0]).toMatchObject({ status: 'executed', tx_hash: TX });
      expect(ap('ap_00000000000a')).toMatchObject({
        status: 'active',
        delegate_address: DELEGATE_EIP55,
        cre_job_id: 'job-123',
      });
    });

    it('C-351 k: failed → DB6 failed and DB7 failed', async () => {
      const r = await post({
        kind: 'intent_result',
        request_id: 'req_000000000001',
        step: 0,
        status: 'failed',
        autopay: { autopay_id: 'ap_00000000000a' },
      });
      expect(r.status).toBe(204);
      expect(rows6('req_000000000001')[0]).toMatchObject({ status: 'failed' });
      expect(ap('ap_00000000000a')).toMatchObject({ status: 'failed', delegate_address: null });
    });

    it('C-351 k: executed with no delegate_address → 400 and nothing changed', async () => {
      const before = dump();
      const r = await post({
        kind: 'intent_result',
        request_id: 'req_000000000001',
        step: 0,
        status: 'executed',
        tx_hash: TX,
        executed_at: EXEC_AT,
        autopay: { autopay_id: 'ap_00000000000a', cre_job_id: 'job-123' },
      });
      expect(r.status).toBe(400);
      expect(dump()).toEqual(before);
    });
  });

  describe('l step (autopay cancellation)', () => {
    beforeEach(() => {
      autopay('ap_00000000000b', 'req_000000000001');
      t.repos.db7.update(
        'ap_00000000000b',
        { status: 'active', delegate_address: DELEGATE_EIP55 as Address, cre_job_id: 'job-1' },
        NOW,
      );
      // B03: l-only requests have no spend row, but must prove the exact submitted cancellation identity.
      t.repos.handoffs.insert({
        request_id: 'req_00000000000c',
        status: 'accepted',
        history: null,
        envelope: {
          version: '1',
          request_id: 'req_00000000000c',
          wallet_address: getAddress('0x00000000000000000000000000000000000000aa'),
          created_at: NOW,
          intents: [
            {
              intent_id: 'l',
              step: 0,
              autopay_id: 'ap_00000000000b',
              chain_id: 84532,
              delegate_address: DELEGATE_EIP55,
              recipient: getAddress(RECIPIENT.toLowerCase()),
              refund_remaining: true,
            },
          ],
        },
      });
    });

    it('C-351 l / SQ-A-04: executed → DB7 row of the earlier request cancelled; no DB6 row for the l request is fine → 204', async () => {
      const r = await post({
        kind: 'intent_result',
        request_id: 'req_00000000000c',
        step: 0,
        status: 'executed',
        executed_at: EXEC_AT,
        autopay: { autopay_id: 'ap_00000000000b' },
      });
      expect(r.status).toBe(204);
      expect(ap('ap_00000000000b')).toMatchObject({ status: 'cancelled', delegate_address: DELEGATE_EIP55 });
      expect(rows6('req_00000000000c')).toEqual([]);
    });

    it('C-351 l / SQ-A-04: failed → the DB7 row is unchanged', async () => {
      const before = dump();
      const r = await post({
        kind: 'intent_result',
        request_id: 'req_00000000000c',
        step: 0,
        status: 'failed',
        autopay: { autopay_id: 'ap_00000000000b' },
      });
      expect(r.status).toBe(204);
      expect(dump()).toEqual(before);
      expect(ap('ap_00000000000b')).toMatchObject({ status: 'active' });
    });
  });

  it('C-351: status executed without executed_at → 400, nothing changed', async () => {
    t.repos.db6.insertMany([db6({})]);
    const before = dump();
    const r = await post({
      kind: 'intent_result',
      request_id: 'req_000000000001',
      step: 0,
      status: 'executed',
      tx_hash: TX,
    });
    expect(r.status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it('C-351: missing request_id, step or status → 400', async () => {
    t.repos.db6.insertMany([db6({})]);
    const full = { kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'failed' };
    for (const drop of ['request_id', 'step', 'status']) {
      const { [drop]: _removed, ...rest } = full as Record<string, unknown>;
      expect((await post(rest)).status, drop).toBe(400);
    }
  });
});

describe('§14.3 autopay_payment', () => {
  beforeEach(() => {
    t.repos.db6.insertMany([
      db6({ kind: 'autopay_prefund', counts_toward_limit: false, intent_id: 'k', autopay_id: 'ap_00000000000a' }),
    ]);
    autopay('ap_00000000000a', 'req_000000000001');
  });
  const body = (over: Record<string, unknown> = {}, apOver: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'autopay_payment',
    tx_hash: TX,
    executed_at: EXEC_AT,
    autopay: { autopay_id: 'ap_00000000000a', amount: '10', chain_id: 84532, token: 'USDC', ...apOver },
    ...over,
  });

  it('C-352 / C-266: inserts an executed autopay_payment DB6 row that counts toward the limit; request_id defaults to the DB7 row', async () => {
    const r = await post(body());
    expect(r.status).toBe(204);
    const rows = rows6('req_000000000001').filter((x) => x.kind === 'autopay_payment');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'autopay_payment',
      status: 'executed',
      counts_toward_limit: 1,
      amount: '10',
      chain_id: 84532,
      token: 'USDC',
      autopay_id: 'ap_00000000000a',
      tx_hash: TX,
      executed_at: EXEC_AT,
      step: null,
    });
  });

  it('C-352: the row counts in spentToday', async () => {
    await post(body());
    const spent = t.repos.db6.spentToday('USDC', 'Asia/Kolkata', NOW).filter((x) => x.kind === 'autopay_payment');
    expect(spent.map((x) => x.amount)).toEqual(['10']);
  });

  it('C-352: an explicit known request_id is used', async () => {
    t.repos.db6.insertMany([db6({ request_id: 'req_000000000009' })]);
    expect((await post(body({ request_id: 'req_000000000009' }))).status).toBe(204);
    expect(rows6('req_000000000009').some((x) => x.kind === 'autopay_payment')).toBe(true);
  });

  it('C-352: too many decimals for the token → 400 (USDC 7, ETH 19), nothing changed', async () => {
    const before = dump();
    expect((await post(body({}, { amount: '1.0000001' }))).status).toBe(400);
    expect((await post(body({}, { amount: '0.0000000000000000001', token: 'ETH' }))).status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it('C-352: missing amount / chain_id / token / executed_at → 400', async () => {
    for (const k of ['amount', 'chain_id', 'token']) {
      const b = body();
      delete (b.autopay as Record<string, unknown>)[k];
      expect((await post(b)).status, k).toBe(400);
    }
    const b = body();
    delete b.executed_at;
    expect((await post(b)).status).toBe(400);
    const c = body();
    delete c.autopay;
    expect((await post(c)).status).toBe(400);
  });
});

describe('§14.3 autopay_status', () => {
  beforeEach(() => autopay('ap_00000000000a', 'req_000000000001'));

  for (const status of ['active', 'cancelled', 'ended', 'failed'] as const) {
    it(`C-353: status ${status} updates the DB7 row`, async () => {
      const r = await post({ kind: 'autopay_status', autopay: { autopay_id: 'ap_00000000000a', status } });
      expect(r.status).toBe(204);
      expect(ap('ap_00000000000a')).toMatchObject({ status });
    });
  }

  it('C-353: a missing status → 400, nothing changed; a status outside the set → 400', async () => {
    const before = dump();
    expect((await post({ kind: 'autopay_status', autopay: { autopay_id: 'ap_00000000000a' } })).status).toBe(400);
    expect(
      (await post({ kind: 'autopay_status', autopay: { autopay_id: 'ap_00000000000a', status: 'pending' } })).status,
    ).toBe(400);
    expect((await post({ kind: 'autopay_status' })).status).toBe(400);
    expect(dump()).toEqual(before);
  });
});

describe('§14.3 404 / 400 / 204', () => {
  beforeEach(() => {
    t.repos.db6.insertMany([db6({})]);
    autopay('ap_00000000000a', 'req_000000000001');
  });
  const paymentAp = { amount: '10', chain_id: 84532, token: 'USDC' };

  it('C-354: an unknown request_id → 404 (intent_result without autopay; payment / status with a known autopay_id)', async () => {
    const before = dump();
    expect(
      (await post({ kind: 'intent_result', request_id: 'req_ffffffffffff', step: 0, status: 'failed' })).status,
    ).toBe(404);
    expect(
      (
        await post({
          kind: 'autopay_payment',
          request_id: 'req_ffffffffffff',
          executed_at: EXEC_AT,
          autopay: { autopay_id: 'ap_00000000000a', ...paymentAp },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await post({
          kind: 'autopay_status',
          request_id: 'req_ffffffffffff',
          autopay: { autopay_id: 'ap_00000000000a', status: 'ended' },
        })
      ).status,
    ).toBe(404);
    expect(dump()).toEqual(before);
  });

  it('C-354: an unknown autopay_id → 404 for all three kinds', async () => {
    const before = dump();
    const unknown = 'ap_ffffffffffff';
    expect(
      (
        await post({
          kind: 'intent_result',
          request_id: 'req_000000000001',
          step: 0,
          status: 'failed',
          autopay: { autopay_id: unknown },
        })
      ).status,
    ).toBe(404);
    expect(
      (await post({ kind: 'autopay_payment', executed_at: EXEC_AT, autopay: { autopay_id: unknown, ...paymentAp } }))
        .status,
    ).toBe(404);
    expect((await post({ kind: 'autopay_status', autopay: { autopay_id: unknown, status: 'ended' } })).status).toBe(
      404,
    );
    expect(dump()).toEqual(before);
  });

  const malformed: Array<[string, unknown]> = [
    ['an unknown kind', { kind: 'refund' }],
    ['a missing kind', { request_id: 'req_000000000001', step: 0, status: 'failed' }],
    ['an extra key', { kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'failed', extra: 1 }],
    [
      'a bad tx_hash',
      {
        kind: 'intent_result',
        request_id: 'req_000000000001',
        step: 0,
        status: 'executed',
        tx_hash: '0x12',
        executed_at: EXEC_AT,
      },
    ],
    [
      'a bad date',
      { kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'executed', executed_at: 'yesterday' },
    ],
    [
      'a bad address',
      {
        kind: 'intent_result',
        request_id: 'req_000000000001',
        step: 0,
        status: 'executed',
        executed_at: EXEC_AT,
        autopay: { autopay_id: 'ap_00000000000a', delegate_address: '0x123' },
      },
    ],
    ['a negative step', { kind: 'intent_result', request_id: 'req_000000000001', step: -1, status: 'failed' }],
    ['a non-integer step', { kind: 'intent_result', request_id: 'req_000000000001', step: 'zero', status: 'failed' }],
    ['a bad status', { kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'pending' }],
    ['an array', []],
    ['a string', 'report'],
    ['a number', 5],
  ];
  for (const [label, b] of malformed) {
    it(`C-354: ${label} → 400, nothing changed`, async () => {
      const before = dump();
      const r = await post(b);
      expect(r.status).toBe(400);
      expect(dump()).toEqual(before);
    });
  }

  it('C-354: a body that is not JSON → 400; an empty body → 400', async () => {
    const before = dump();
    const raw = await s.call('POST', URL, { token: REPORT_TOKEN, raw: '{"kind": ' });
    expect(raw.status).toBe(400);
    expect((await s.call('POST', URL, { token: REPORT_TOKEN })).status).toBe(400);
    expect(dump()).toEqual(before);
  });

  it('C-354: success → 204 with an empty body', async () => {
    const r = await post({ kind: 'intent_result', request_id: 'req_000000000001', step: 0, status: 'failed' });
    expect(r.status).toBe(204);
    expect(r.text).toBe('');
  });
});

describe('§18 report content is not logged', () => {
  it('§18: tx hash, addresses and amounts of reports never appear in any log entry', async () => {
    t.repos.db6.insertMany([
      db6({
        kind: 'autopay_prefund',
        counts_toward_limit: false,
        intent_id: 'k',
        autopay_id: 'ap_00000000000a',
        amount: '12.345',
      }),
    ]);
    autopay('ap_00000000000a', 'req_000000000001');
    await post({
      kind: 'intent_result',
      request_id: 'req_000000000001',
      step: 0,
      status: 'executed',
      tx_hash: TX,
      executed_at: EXEC_AT,
      autopay: { autopay_id: 'ap_00000000000a', delegate_address: DELEGATE_LOWER, cre_job_id: 'job-secret-77' },
    });
    await post({
      kind: 'autopay_payment',
      tx_hash: `0x${'cd'.repeat(32)}`,
      executed_at: EXEC_AT,
      autopay: { autopay_id: 'ap_00000000000a', amount: '12.345', chain_id: 84532, token: 'USDC' },
    });
    await post({ kind: 'autopay_status', autopay: { autopay_id: 'ap_ffffffffffff', status: 'ended' } });
    expect(s.log.lines.length).toBeGreaterThan(0);
    const logged = JSON.stringify(s.log.lines);
    for (const secret of [
      TX,
      'cdcdcdcd',
      DELEGATE_LOWER,
      DELEGATE_EIP55.slice(2).toLowerCase(),
      '12.345',
      'job-secret-77',
      RECIPIENT,
    ]) {
      expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });
});
