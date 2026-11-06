// Guard test: C-026 src/db/schema.sql creates every §7.1 table with each CHECK constraint, verbatim from the spec.
import { describe, expect, it } from 'vitest';
import { openTempDb } from '../A/helpers.js';

const TABLES = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db4_balances',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_sessions',
  'db8_prompts',
  'db8_history',
];

// Every CHECK constraint of §7.1, per table (whitespace-normalised before comparison).
const CHECKS: Record<string, string[]> = {
  db1_amount_placeholders: [
    "CHECK (placeholder GLOB 'amount_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')",
    "CHECK (token IN ('USDC','ETH'))",
    "CHECK (source IN ('user','derived','untrusted'))",
    'CHECK (confirmed IN (0,1))',
  ],
  db2_address_book: ["CHECK (added_by = 'user_confirmed')", 'UNIQUE (name_key, chain_id)'],
  db3_address_placeholders: [
    "CHECK (kind IN ('single','group','member'))",
    "CHECK (source IN ('user','contact','ens','untrusted','session'))",
  ],
  db4_balances: [
    "CHECK (token IN ('USDC','ETH'))",
    "CHECK (status IN ('ok','unavailable'))",
    'PRIMARY KEY (chain_id, token)',
  ],
  db5_limits: [],
  db6_spend_log: [
    "CHECK (kind IN ('payment','bridge_out','bridge_buffer','bridge_fee','autopay_prefund','autopay_payment','autopay_fee'))",
    'CHECK (counts_toward_limit IN (0,1))',
    "CHECK (status IN ('pending','executed','failed'))",
  ],
  db7_autopays: ["CHECK (status IN ('pending','active','cancelled','ended','failed'))"],
  db8_sessions: [],
  db8_prompts: ["CHECK (kind IN ('typed','pasted','answer'))"],
  db8_history: [],
};

const norm = (s: string): string => s.replace(/\s+/g, ' ').toLowerCase();

describe('C-026 §7.1 schema.sql', () => {
  const t = openTempDb();
  const rows = t.db.prepare('SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL').all() as Array<{
    type: string;
    name: string;
    sql: string;
  }>;
  const sqlOf = (name: string): string => norm(rows.find((r) => r.type === 'table' && r.name === name)?.sql ?? '');

  it('C-026 §7.1: all 10 tables exist (DB1-DB8, DB8 has three)', () => {
    const names = rows.filter((r) => r.type === 'table' && !r.name.startsWith('sqlite_')).map((r) => r.name);
    for (const tbl of TABLES) expect(names, tbl).toContain(tbl);
  });

  it.each(Object.entries(CHECKS))('C-026 §7.1: %s carries every CHECK constraint from the spec', (tbl, checks) => {
    const sql = sqlOf(tbl);
    expect(sql, tbl).not.toBe('');
    for (const c of checks) expect(sql, `${tbl}: ${c}`).toContain(norm(c));
  });

  it('C-026 §7.1: db2_by_address index exists on db2_address_book(address)', () => {
    const idx = rows.find((r) => r.type === 'index' && r.name === 'db2_by_address');
    expect(norm(idx?.sql ?? '')).toContain('on db2_address_book(address)');
  });

  it('C-026 §7.1: primary keys and key columns', () => {
    expect(sqlOf('db1_amount_placeholders')).toContain('placeholder text primary key');
    expect(sqlOf('db2_address_book')).toContain('id integer primary key autoincrement');
    expect(sqlOf('db3_address_placeholders')).toContain('placeholder text primary key');
    expect(sqlOf('db5_limits')).toContain('key text primary key');
    expect(sqlOf('db7_autopays')).toContain('autopay_id text primary key');
    expect(sqlOf('db8_sessions')).toContain('session_id text primary key');
  });

  it('C-026 §7.1: the CHECKs are enforced (bad token / bad added_by rejected)', () => {
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO db1_amount_placeholders VALUES ('amount_00000000','s','r','1','DAI','user','phrase',1,'t')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      t.db
        .prepare(
          "INSERT INTO db2_address_book (name,name_key,chain_id,chain,address,added_at,added_by) VALUES ('a','a',1,'c','0x','t','x')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
