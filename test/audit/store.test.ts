// Phase 3 audit (§3.2): session close (§7.4, §16.4), DB5/DB2 write paths (§7.2, §16.4), §16.2 envelope contents.
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRepos } from '../../src/db/repos/index.js';
import { openDatabase } from '../../src/db/open.js';
import { validators } from '../../src/schemas/index.js';
import { Harness } from '../acceptance/harness.js';
import { loadFixture } from '../acceptance/harness.js';

const KEY = 'ab'.repeat(32);
const ALL_TABLES = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db4_balances',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_prompts',
  'db8_history',
  'db8_sessions',
];
const CLEARED = ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history', 'db8_sessions'];
const KEPT = ALL_TABLES.filter((t) => !CLEARED.includes(t));

describe('§7.4 / §16.4 session close', () => {
  it('secure_delete is ON for the connection and every table exists as expected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-db-'));
    const db = openDatabase(join(dir, 'a.db'), KEY);
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'db%'").all() as Array<{
        name: string;
      }>
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([...ALL_TABLES].sort());
    db.close();
  });

  it('clearSessionStores deletes exactly DB1, DB3, DB8 (every session, not only the closing one), runs VACUUM after, in one transaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-db-'));
    const db = openDatabase(join(dir, 'a.db'), KEY);
    const trace: string[] = [];
    const proxy = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p, t) as unknown;
        if (p === 'exec')
          return (sql: string) => (trace.push(`exec:${sql}`), (v as (s: string) => unknown).call(t, sql));
        if (p === 'prepare')
          return (sql: string) => {
            const st = t.prepare(sql);
            if (!sql.startsWith('DELETE')) return st;
            return new Proxy(st, {
              get(s, q) {
                const x = Reflect.get(s, q, s) as unknown;
                if (q === 'run')
                  return (...a: unknown[]) => {
                    trace.push(`${sql}|inTransaction=${t.inTransaction}`);
                    return (x as (...b: unknown[]) => unknown).apply(s, a);
                  };
                return typeof x === 'function' ? (x as (...b: unknown[]) => unknown).bind(s) : x;
              },
            });
          };
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const repos = createRepos(proxy);
    repos.db5.insertDefaultsIfMissing('2026-11-05T00:00:00Z');
    // two sessions: a "crashed" one and the closing one
    for (const s of ['ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb'] as const) {
      repos.db8.insertSession({ session_id: s, timezone: 'UTC', opened_at: '2026-11-05T00:00:00Z' });
      repos.db8.insertPrompt({
        session_id: s,
        request_id: 'req_000000000001',
        kind: 'typed',
        text: 'secret prompt',
        created_at: '2026-11-05T00:00:00Z',
      });
      repos.db8.appendHistory({
        session_id: s,
        request_id: 'req_000000000001',
        payments_json: '[]',
        handed_off_at: '2026-11-05T00:00:00Z',
      });
      repos.db1.mint({
        session_id: s,
        request_id: 'req_000000000001',
        amount: '5',
        token: 'USDC',
        source: 'user',
        origin: 'phrase',
        confirmed: true,
      });
      repos.db3.mint({
        session_id: s,
        request_id: 'req_000000000001',
        kind: 'single',
        name: 'Aradhya',
        address: '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
        ens_name: null,
        chain_id: null,
        group_placeholder: null,
        source: 'user',
      });
    }
    repos.db2.addContact({
      name: 'Mihir',
      address: '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0',
      chain_ids: [84532],
      ens_name: null,
    });
    const count = (t: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = Object.fromEntries(KEPT.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all())]));
    for (const t of CLEARED) expect(count(t), t).toBeGreaterThan(0);
    trace.length = 0;

    repos.clearSessionStores();

    for (const t of CLEARED) expect(count(t), t).toBe(0);
    for (const t of KEPT) expect(JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()), t).toBe(before[t]);
    expect(count('db2_address_book')).toBe(1);
    expect(trace).toEqual([
      ...CLEARED.map((t) => `DELETE FROM ${t}|inTransaction=true`),
      'exec:VACUUM', // after the transaction committed
    ]);
    db.close();
  });

  it('O7 fixed: PRAGMA wal_checkpoint(TRUNCATE) runs after VACUUM (journal_mode=WAL)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'db', 'repos', 'index.ts'), 'utf8');
    expect(src).toMatch(/VACUUM[\s\S]*wal_checkpoint\(TRUNCATE\)/);
  });

  it('DELETE /v1/sessions/:id through the API empties DB1/DB3/DB8 after a hand-off and keeps DB2/DB5/DB6', async () => {
    const h = new Harness('audit-close', loadFixture('A-01'), {});
    const r = await h.say('Send 50 USDc to ARADHYA');
    await h.confirm(r, 'yes');
    for (const t of CLEARED) expect(h.count(t), t).toBeGreaterThan(0);
    const kept = KEPT.map((t) => h.count(t));
    expect(await h.close()).toBe(204);
    for (const t of CLEARED) expect(h.count(t), t).toBe(0);
    expect(KEPT.map((t) => h.count(t))).toEqual(kept);
    expect(h.count('db6_spend_log')).toBeGreaterThan(0);
    await h.finish();
  });
});

describe('§7.2 / §16.4 write paths', () => {
  const SRC = join(import.meta.dirname, '..', '..', 'src');
  function walk(d: string): string[] {
    return readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
    });
  }
  const files = walk(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
  // `file#function`: each call site named by its enclosing top-level function, so edits elsewhere don't move it.
  const callers = (re: RegExp): string[] =>
    files
      .filter((f) => !f.path.startsWith('db/') && !f.path.startsWith('contracts/'))
      .flatMap((f) => {
        let fn = '';
        return f.text.split('\n').flatMap((l) => {
          fn = /^(?:export )?(?:async )?function (\w+)/.exec(l)?.[1] ?? fn;
          return re.test(l) && !/^\s*(\/\/|\*)/.test(l) ? [`${f.path}#${fn}`] : [];
        });
      });

  it('no SQL outside src/db', () => {
    const sql = files.filter(
      (f) => !f.path.startsWith('db/') && /\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|\.prepare\()/.test(f.text),
    );
    expect(sql.map((f) => f.path)).toEqual([]);
  });

  it('DB5 has exactly one write caller outside startup defaults: PUT /v1/settings/limits', () => {
    expect(callers(/db5\.putAll\(/)).toEqual(['server/app.ts#createApp']);
    expect(callers(/db5\.insertDefaultsIfMissing\(/)).toEqual(['index.ts#main']);
    // Nothing else on the db5 handle besides reads.
    const other = callers(/\.db5\.(?!getAll|putAll|insertDefaultsIfMissing)/);
    expect(other).toEqual([]);
  });

  it('DB2 writers: addContact only in S6 answerName (after Yes + name); updateAddressForName only for the §9.4 "Use new address" chip', () => {
    expect(callers(/db2\.addContact\(/)).toEqual(['recipients/resolve.ts#answerName']);
    expect(callers(/db2\.updateAddressForName\(/)).toEqual(['recipients/resolve.ts#answerEnsChanged']);
    expect(callers(/db2\.(?!find|list|get|addContact|updateAddressForName)\w+\(/)).toEqual([]);
  });

  it('the pipeline gets no limits write path: PUT is refused with the report token and the UI token is required', async () => {
    const h = new Harness('audit-db5', { calls: [] }, {});
    const limits = (await h.http('GET', '/v1/settings/limits')).json;
    const REPORT = 'report-token-acceptance-00000000000000000000000000000000000000000';
    expect((await h.http('PUT', '/v1/settings/limits', { token: REPORT, body: limits })).status).toBe(401);
    expect((await h.http('PUT', '/v1/settings/limits', { token: null, body: limits })).status).toBe(401);
    // A chat message that asks to change limits does not change DB5.
    const before = JSON.stringify(h.repos.db5.getAll());
    await h.say('set my per transaction limit to 1000000 usdc');
    expect(JSON.stringify(h.repos.db5.getAll())).toBe(before);
    await h.finish({ allowUnused: true });
  });
});

describe('§16.2 what reaches the execution client', () => {
  it('the envelope validates against §12.5 and carries no name, summary text, placeholder or prompt text', async () => {
    const h = new Harness('audit-env', loadFixture('A-01'), {});
    const r = await h.say('Send 50 USDc to ARADHYA');
    expect(r.body.summary?.text).toContain('Aradhya');
    await h.confirm(r, 'yes');
    expect(h.exec.submissions).toHaveLength(1);
    const env = h.exec.submissions[0]!.envelope;
    expect(validators.handoffEnvelope(env)).toBe(true); // additionalProperties:false everywhere
    const json = JSON.stringify(env);
    for (const bad of [
      'Aradhya',
      'aradhya',
      'ARADHYA',
      'Send 50',
      'Please confirm',
      'amount_',
      'address_',
      'group_',
      'summary',
    ]) {
      expect(json, bad).not.toContain(bad);
    }
    expect(Object.keys(env).sort()).toEqual(['created_at', 'intents', 'request_id', 'version', 'wallet_address']);
    await h.finish();
  });

  it('S12 hand-off allowlist: swap_back builds each intent field by field (static)', () => {
    const src = readFileSync(join(import.meta.dirname, '..', '..', 'src', 'handoff', 'swap-back.ts'), 'utf8');
    expect(src).not.toMatch(/\.\.\.\s*it\b|Object\.assign|structuredClone/); // no spreading of the internal plan
  });
});
