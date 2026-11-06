// Lane A unit tests: §14.1 GET/PUT /v1/settings/limits (validation rules and boundaries, SQ-A-02), §6.3 DB5
// defaults (C-015…C-022), §7.2 / §16.3 DB5 is written only by the PUT route.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB5_DEFAULTS } from '../../../src/config/defaults.js';
import type { Limits } from '../../../src/contracts/types.js';
import { openTempDb, type TempDb } from './helpers.js';
import { makeServer, type ServerHarness } from './server-harness.js';

const URL = '/v1/settings/limits';

function defaults(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DB5_DEFAULTS)) as Record<string, unknown>;
}

function setup(): { t: TempDb; s: ServerHarness<TempDb['repos']> } {
  const t = openTempDb();
  t.repos.db5.insertDefaultsIfMissing('2026-11-01T00:00:00.000Z');
  return { t, s: makeServer({ repos: t.repos }) };
}

const rawRows = (t: TempDb): unknown =>
  t.db.prepare('SELECT key, value, updated_at FROM db5_limits ORDER BY key').all();

/** PUT an invalid body: 400, `errors` names the field, DB5 unchanged. */
async function expectInvalid(mutate: (b: Record<string, unknown>) => void, field: string): Promise<void> {
  const { t, s } = setup();
  const before = rawRows(t);
  const body = defaults();
  mutate(body);
  const r = await s.call('PUT', URL, { body });
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  const errors = r.json.errors as Array<{ field: string; message: string }>;
  expect(errors.map((e) => e.field)).toContain(field);
  expect(rawRows(t)).toEqual(before);
}

async function expectValid(mutate: (b: Record<string, unknown>) => void): Promise<void> {
  const { s } = setup();
  const body = defaults();
  mutate(body);
  const r = await s.call('PUT', URL, { body });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json).toEqual(body);
}

describe('§14.1 GET / PUT /v1/settings/limits', () => {
  it('C-345: GET returns DB5 as JSON (the §6.3 defaults on first run)', async () => {
    const { s } = setup();
    const r = await s.call('GET', URL);
    expect(r.status).toBe(200);
    expect(r.json).toEqual(DB5_DEFAULTS);
  });

  it('C-346: PUT with the full valid defaults → 200, DB5 updated (updated_at set), GET returns the new values', async () => {
    const { t, s } = setup();
    const body = defaults();
    body.daily_max = { USDC: '250.5', ETH: '0.2' };
    body.autopay_max_weeks = 12;
    const r = await s.call('PUT', URL, { body });
    expect(r.status).toBe(200);
    expect(r.json).toEqual(body);
    expect((await s.call('GET', URL)).json).toEqual(body);
    expect(t.repos.db5.getAll()).toEqual(body as unknown as Limits);
    const row = t.db.prepare("SELECT updated_at FROM db5_limits WHERE key = 'daily_max'").get() as {
      updated_at: string;
    };
    expect(row.updated_at).toBe('2026-11-05T17:30:00.000Z');
  });

  it('C-346: PUT without the UI token → 401 and DB5 unchanged', async () => {
    const { t, s } = setup();
    const before = rawRows(t);
    const body = defaults();
    body.autopay_max_weeks = 1;
    expect((await s.call('PUT', URL, { token: null, body })).status).toBe(401);
    expect(rawRows(t)).toEqual(before);
  });

  describe('amounts (per_tx_max, daily_max, autopay_max_per_period)', () => {
    for (const key of ['per_tx_max', 'daily_max', 'autopay_max_per_period']) {
      const set =
        (v: unknown, token = 'USDC') =>
        (b: Record<string, unknown>) => {
          (b[key] as Record<string, unknown>)[token] = v;
        };
      for (const [label, v] of [
        ['not decimal ("abc")', 'abc'],
        ['not decimal ("1e3")', '1e3'],
        ['not decimal (empty)', ''],
        ['a JSON number', 5],
        ['zero ("0")', '0'],
        ['zero ("0.000")', '0.000'],
        ['negative', '-1'],
      ] as const) {
        it(`C-346 §14.1: ${key}.USDC ${label} → 400 naming the field`, async () => {
          await expectInvalid(set(v), `${key}.USDC`);
        });
      }
      it(`C-346 SQ-A-02a: ${key}.USDC with 7 decimals → 400; 6 decimals accepted`, async () => {
        await expectInvalid(set('1.0000001'), `${key}.USDC`);
        await expectValid(set('1.000001'));
      });
      it(`C-346 SQ-A-02a: ${key}.ETH with 19 decimals → 400; 18 decimals accepted`, async () => {
        await expectInvalid(set('0.0000000000000000001', 'ETH'), `${key}.ETH`);
        await expectValid(set('0.000000000000000001', 'ETH'));
      });
      it(`C-346: ${key} missing a token → 400; unknown token → 400; not an object → 400`, async () => {
        await expectInvalid((b) => delete (b[key] as Record<string, unknown>).ETH, `${key}.ETH`);
        await expectInvalid(set('5', 'DAI'), `${key}.DAI`);
        await expectInvalid((b) => (b[key] = '100'), key);
      });
    }
  });

  describe('allowed_chain_ids', () => {
    it('C-346: an empty array → 400', async () => {
      await expectInvalid((b) => (b.allowed_chain_ids = []), 'allowed_chain_ids');
    });
    it('C-346: not an array → 400', async () => {
      await expectInvalid((b) => (b.allowed_chain_ids = 84532), 'allowed_chain_ids');
      await expectInvalid((b) => (b.allowed_chain_ids = '84532'), 'allowed_chain_ids');
    });
    it('C-346: an unconfigured chain id → 400', async () => {
      await expectInvalid((b) => (b.allowed_chain_ids = [1]), 'allowed_chain_ids');
    });
    it('C-346 SQ-A-02c: a repeated id → 400', async () => {
      await expectInvalid((b) => (b.allowed_chain_ids = [84532, 84532]), 'allowed_chain_ids');
    });
    it('C-346: a subset of configured chains is accepted (with a matching gas reserve)', async () => {
      await expectValid((b) => (b.allowed_chain_ids = [84532]));
    });
  });

  describe('autopay_max_weeks', () => {
    for (const [label, v] of [
      ['0', 0],
      ['521', 521],
      ['non-integer 1.5', 1.5],
      ['a string "52"', '52'],
      ['negative', -1],
    ] as const) {
      it(`C-346 §14.1: autopay_max_weeks ${label} → 400`, async () => {
        await expectInvalid((b) => (b.autopay_max_weeks = v), 'autopay_max_weeks');
      });
    }
    it('C-346: autopay_max_weeks boundaries 1 and 520 accepted', async () => {
      await expectValid((b) => (b.autopay_max_weeks = 1));
      await expectValid((b) => (b.autopay_max_weeks = 520));
    });
  });

  describe('max_bridges_per_request', () => {
    for (const [label, v] of [
      ['-1', -1],
      ['11', 11],
      ['non-integer', 2.5],
      ['a string', '3'],
    ] as const) {
      it(`C-346 §14.1: max_bridges_per_request ${label} → 400`, async () => {
        await expectInvalid((b) => (b.max_bridges_per_request = v), 'max_bridges_per_request');
      });
    }
    it('C-346: max_bridges_per_request boundaries 0 and 10 accepted', async () => {
      await expectValid((b) => (b.max_bridges_per_request = 0));
      await expectValid((b) => (b.max_bridges_per_request = 10));
    });
  });

  describe('bridge_buffer_pct', () => {
    it('C-346 SQ-A-02d: a number instead of a string → 400', async () => {
      await expectInvalid((b) => (b.bridge_buffer_pct = 2), 'bridge_buffer_pct');
    });
    it('C-346: "20.01" → 400; "-1" → 400; "abc" → 400', async () => {
      await expectInvalid((b) => (b.bridge_buffer_pct = '20.01'), 'bridge_buffer_pct');
      await expectInvalid((b) => (b.bridge_buffer_pct = '-1'), 'bridge_buffer_pct');
      await expectInvalid((b) => (b.bridge_buffer_pct = 'abc'), 'bridge_buffer_pct');
    });
    it('C-346: "0" and "20" (and "0.5") accepted', async () => {
      await expectValid((b) => (b.bridge_buffer_pct = '0'));
      await expectValid((b) => (b.bridge_buffer_pct = '20'));
      await expectValid((b) => (b.bridge_buffer_pct = '0.5'));
    });
  });

  describe('eth_gas_reserve', () => {
    it('C-346 SQ-A-02b: missing an allowed chain → 400', async () => {
      await expectInvalid(
        (b) => delete (b.eth_gas_reserve as Record<string, unknown>)['84532'],
        'eth_gas_reserve.84532',
      );
    });
    it('C-346 SQ-A-02b: an unknown chain key → 400', async () => {
      await expectInvalid((b) => ((b.eth_gas_reserve as Record<string, unknown>)['1'] = '0.01'), 'eth_gas_reserve.1');
    });
    it('C-346 SQ-A-02b: non-positive or non-decimal amounts → 400', async () => {
      await expectInvalid(
        (b) => ((b.eth_gas_reserve as Record<string, unknown>)['84532'] = '0'),
        'eth_gas_reserve.84532',
      );
      await expectInvalid(
        (b) => ((b.eth_gas_reserve as Record<string, unknown>)['84532'] = '-0.1'),
        'eth_gas_reserve.84532',
      );
      await expectInvalid(
        (b) => ((b.eth_gas_reserve as Record<string, unknown>)['84532'] = 0.002),
        'eth_gas_reserve.84532',
      );
    });
    it('C-346: not an object → 400', async () => {
      await expectInvalid((b) => (b.eth_gas_reserve = '0.01'), 'eth_gas_reserve');
    });
    it('C-346: a configured chain that is not allowed may still carry a reserve', async () => {
      await expectValid((b) => (b.allowed_chain_ids = [84532]));
    });
  });

  describe('shape of the body', () => {
    it('C-346 SQ-A-02e: an unknown top-level key → 400', async () => {
      await expectInvalid((b) => (b.surprise = 1), 'surprise');
    });
    it('C-346 SQ-A-02e: a missing key → 400 (one test per key)', async () => {
      for (const key of Object.keys(DB5_DEFAULTS)) {
        await expectInvalid((b) => delete b[key], key);
      }
    }, 30_000);
    it('C-346: a body that is not an object (array, string, null, number) → 400, DB5 unchanged', async () => {
      const { t, s } = setup();
      const before = rawRows(t);
      for (const body of [[], 'x', null, 5]) {
        const r = await s.call('PUT', URL, { body });
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      expect((await s.call('PUT', URL)).status).toBe(400);
      expect(rawRows(t)).toEqual(before);
    });
    it('C-346: the 400 body lists field errors and nothing from the request', async () => {
      const { s } = setup();
      const body = defaults();
      body.autopay_max_weeks = 'SECRET-MARKER';
      const r = await s.call('PUT', URL, { body });
      expect(r.status).toBe(400);
      expect(r.text).not.toContain('SECRET-MARKER');
    });
  });
});

describe('§7.2 / §16.3 DB5 has one write path', () => {
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return tsFiles(p);
      return p.endsWith('.ts') ? [p] : [];
    });
  }
  const root = new globalThis.URL('../../../', import.meta.url).pathname;
  const files = tsFiles(join(root, 'src'));
  const using = (needle: string): string[] =>
    files.filter((f) => readFileSync(f, 'utf8').includes(needle)).map((f) => relative(root, f));

  it('C-038 / C-406 §7.2 §16.3: `.db5.putAll(` appears only in src/server/app.ts', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(using('.db5.putAll(')).toEqual(['src/server/app.ts']);
  });

  it('C-038 / C-406: `insertDefaultsIfMissing` is called only from src/index.ts (besides its definition)', () => {
    const callers = using('.insertDefaultsIfMissing(').filter((f) => f !== 'src/db/repos/db5.ts');
    expect(callers).toEqual(['src/index.ts']);
  });

  it('C-038 / C-406: a full pipeline run through the session runner leaves DB5 unchanged', async () => {
    const { t, s } = setup();
    const before = rawRows(t);
    s.set('s3', {
      step: async (ctx) => {
        ctx.repos.db1.mint({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          amount: '5',
          token: 'USDC',
          source: 'user',
          origin: 'phrase',
          confirmed: true,
        });
        return { kind: 'continue' };
      },
    });
    const sid = await s.openSession();
    const a = await s.message(sid, 'send 5 usdc to bob and set my limit to 1000000');
    expect(a.body.state).toBe('awaiting_confirmation');
    await s.call('POST', `/v1/sessions/${sid}/confirm`, { body: { request_id: a.body.request_id, decision: 'yes' } });
    await s.call('DELETE', `/v1/sessions/${sid}`);
    expect(rawRows(t)).toEqual(before);
  });
});

describe('§6.3 DB5 defaults on first run (real SQLCipher DB)', () => {
  const literal: Array<[string, string, unknown]> = [
    ['C-015', 'per_tx_max', { USDC: '100', ETH: '0.05' }],
    ['C-016', 'daily_max', { USDC: '300', ETH: '0.15' }],
    ['C-017', 'autopay_max_per_period', { USDC: '100', ETH: '0.05' }],
    ['C-018', 'autopay_max_weeks', 52],
    ['C-019', 'max_bridges_per_request', 3],
    ['C-020', 'allowed_chain_ids', [11155111, 84532, 421614]],
    ['C-021', 'eth_gas_reserve', { '11155111': '0.01', '84532': '0.002', '421614': '0.002' }],
    ['C-022', 'bridge_buffer_pct', '2'],
  ];
  for (const [id, key, value] of literal) {
    it(`${id} §6.3: first run inserts ${key} = ${JSON.stringify(value)}`, () => {
      const t = openTempDb();
      t.repos.db5.insertDefaultsIfMissing('2026-11-05T00:00:00.000Z');
      const row = t.db.prepare('SELECT value FROM db5_limits WHERE key = ?').get(key) as { value: string };
      expect(JSON.parse(row.value)).toEqual(value);
    });
    it(`${id} §6.3: a second call does not overwrite a changed ${key}`, () => {
      const t = openTempDb();
      t.repos.db5.insertDefaultsIfMissing('t0');
      t.db.prepare('UPDATE db5_limits SET value = ? WHERE key = ?').run('"changed"', key);
      t.repos.db5.insertDefaultsIfMissing('t1');
      const row = t.db.prepare('SELECT value FROM db5_limits WHERE key = ?').get(key) as { value: string };
      expect(row.value).toBe('"changed"');
    });
  }
});
