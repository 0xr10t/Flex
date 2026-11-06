// In-memory fakes of src/contracts/repos.ts for unit tests of lanes B, C, D (and runner tests in A).
// Implements the same semantics the contract documents: §7.3 minting, §7.4 clearing, §7.1 DB2 invariant,
// §10.1 pending window, §11.3 V-15 today rule. Owned by the Orchestrator.

import { randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type {
  AddContactResult,
  Db1AmountPlaceholders,
  Db1Row,
  Db2AddressBook,
  Db2Row,
  Db3AddressPlaceholders,
  Db3Row,
  Db4Balances,
  Db4Row,
  Db5Limits,
  Db6Insert,
  Db6Row,
  Db6SpendLog,
  Db7Autopays,
  Db7Row,
  Db8HistoryRow,
  Db8Session,
  Db8SessionRow,
  HandoffJournalRow,
  Repos,
} from '../../src/contracts/repos.js';
import type { Address, AmountPh, ChainId, GroupPh, Limits, RecipientPh, Token } from '../../src/contracts/types.js';

export const DEFAULT_LIMITS: Limits = {
  per_tx_max: { USDC: '100', ETH: '0.05' },
  daily_max: { USDC: '300', ETH: '0.15' },
  autopay_max_per_period: { USDC: '100', ETH: '0.05' },
  autopay_max_weeks: 52,
  max_bridges_per_request: 3,
  allowed_chain_ids: [11155111, 84532, 421614],
  eth_gas_reserve: { '11155111': '0.01', '84532': '0.002', '421614': '0.002' },
  bridge_buffer_pct: '0',
  max_group_size: 100,
};

export const CHAIN_NAMES: Record<ChainId, string> = {
  11155111: 'Sepolia',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
};

const hex = (n: number): string => randomBytes(n).toString('hex');
const nowIso = (): string => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
export const nameKey = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

export interface FakeRepos extends Repos {
  /** Raw tables for assertions. */
  tables: {
    db1: Map<string, Db1Row>;
    db2: Db2Row[];
    db3: Map<string, Db3Row>;
    db4: Map<string, Db4Row>;
    db5: Limits;
    db6: Db6Row[];
    db7: Map<string, Db7Row>;
    db8_sessions: Map<string, Db8SessionRow>;
    db8_prompts: Array<{ session_id: string; request_id: string; kind: string; text: string; created_at: string }>;
    db8_history: Db8HistoryRow[];
    handoffs: Map<string, HandoffJournalRow>;
  };
  vacuumCount: number;
}

export function createFakeRepos(seed?: { limits?: Limits }): FakeRepos {
  const t: FakeRepos['tables'] = {
    db1: new Map(),
    db2: [],
    db3: new Map(),
    db4: new Map(),
    db5: clone(seed?.limits ?? DEFAULT_LIMITS),
    db6: [],
    db7: new Map(),
    db8_sessions: new Map(),
    db8_prompts: [],
    db8_history: [],
    handoffs: new Map(),
  };
  let db2Id = 1;
  let db6Id = 1;
  let db8hId = 1;

  const db1: Db1AmountPlaceholders = {
    mint(row) {
      for (let i = 0; i < 5; i++) {
        const ph = `amount_${hex(4)}` as AmountPh;
        if (!t.db1.has(ph)) {
          t.db1.set(ph, { ...row, placeholder: ph, created_at: nowIso() });
          return ph;
        }
      }
      throw new Error('placeholder collision');
    },
    get: (ph) => clone(t.db1.get(ph)),
    listByRequest: (rid) => [...t.db1.values()].filter((r) => r.request_id === rid).map(clone),
    update(ph, patch) {
      const r = t.db1.get(ph);
      if (!r) throw new Error('db1 row not found');
      Object.assign(r, patch);
    },
  };

  const invariantOk = (name_key: string, address: Address): AddContactResult | null => {
    const sameName = t.db2.filter((r) => r.name_key === name_key);
    if (sameName.some((r) => r.address !== address)) return { ok: false, reason: 'name_taken' };
    const sameAddr = t.db2.filter((r) => r.address === address);
    if (sameAddr.some((r) => r.name_key !== name_key)) return { ok: false, reason: 'address_has_other_name' };
    return null;
  };

  const db2: Db2AddressBook = {
    findByNameKey: (k) => t.db2.filter((r) => r.name_key === k).map(clone),
    findByAddress: (a) => t.db2.filter((r) => r.address === a).map(clone),
    findByEnsName: (e) => t.db2.filter((r) => r.ens_name === e).map(clone),
    listAll: () => t.db2.map(clone),
    addContact({ name, address, chain_ids, ens_name }) {
      const k = nameKey(name);
      const bad = invariantOk(k, address);
      if (bad) return bad;
      const rows: Db2Row[] = [];
      for (const chain_id of chain_ids) {
        if (t.db2.some((r) => r.name_key === k && r.chain_id === chain_id)) continue;
        const row: Db2Row = {
          id: db2Id++,
          name,
          name_key: k,
          chain_id,
          chain: CHAIN_NAMES[chain_id],
          address,
          ens_name,
          added_at: nowIso(),
          added_by: 'user_confirmed',
        };
        t.db2.push(row);
        rows.push(clone(row));
      }
      return { ok: true, rows };
    },
    updateAddressForName(k, address) {
      const other = t.db2.filter((r) => r.address === address && r.name_key !== k);
      if (other.length > 0) return { ok: false, reason: 'address_has_other_name' };
      const rows = t.db2.filter((r) => r.name_key === k);
      for (const r of rows) r.address = address;
      return { ok: true, rows: rows.map(clone) };
    },
  };

  const db3: Db3AddressPlaceholders = {
    mint(row) {
      for (let i = 0; i < 5; i++) {
        const ph = (row.kind === 'group' ? `group_${hex(4)}` : `address_${hex(4)}`) as RecipientPh;
        if (!t.db3.has(ph)) {
          t.db3.set(ph, { ...row, placeholder: ph, reused_from_chain_id: null, created_at: nowIso() });
          return ph;
        }
      }
      throw new Error('placeholder collision');
    },
    get: (ph) => clone(t.db3.get(ph)),
    listMembers: (g: GroupPh) => [...t.db3.values()].filter((r) => r.group_placeholder === g).map(clone),
    setReusedFromChain(ph, chain_id) {
      const r = t.db3.get(ph);
      if (!r) throw new Error('db3 row not found');
      r.reused_from_chain_id = chain_id;
    },
  };

  const k4 = (c: ChainId, tok: Token): string => `${c}:${tok}`;
  const db4: Db4Balances = {
    upsertOk(row, updated_at) {
      t.db4.set(k4(row.chain_id, row.token), { ...row, status: 'ok', updated_at });
    },
    markUnavailable(chain_id, chain, updated_at) {
      for (const token of ['ETH', 'USDC'] as const) {
        const old = t.db4.get(k4(chain_id, token));
        t.db4.set(k4(chain_id, token), {
          chain_id,
          chain,
          token,
          balance: old?.balance ?? '0',
          base_units: old?.base_units ?? '0',
          status: 'unavailable',
          updated_at,
        });
      }
    },
    get: (c, tok) => clone(t.db4.get(k4(c, tok))),
    listAll: () => [...t.db4.values()].map(clone),
  };

  const db5: Db5Limits = {
    insertDefaultsIfMissing() {
      /* defaults already present */
    },
    getAll: () => clone(t.db5),
    putAll(limits) {
      t.db5 = clone(limits);
    },
  };

  const db6: Db6SpendLog = {
    insertMany(rows: Db6Insert[]) {
      for (const r of rows) t.db6.push({ ...r, id: db6Id++ });
    },
    hasRequest: (rid) => t.db6.some((r) => r.request_id === rid),
    listByRequest: (rid) => t.db6.filter((r) => r.request_id === rid).map(clone),
    hasTxHash: (h) => t.db6.some((r) => r.tx_hash !== null && r.tx_hash.toLowerCase() === h.toLowerCase()),
    applyIntentResult({ request_id, step, status, tx_hash, executed_at, bridge_fee_eth }) {
      let n = 0;
      for (const r of t.db6) {
        if (r.request_id === request_id && r.step === step && r.status !== 'executed') {
          if (r.kind === 'bridge_fee' && bridge_fee_eth !== undefined) r.amount = bridge_fee_eth;
          r.status = status;
          r.tx_hash = tx_hash;
          r.executed_at = executed_at;
          n++;
        }
      }
      return n;
    },
    pendingRecent(chain_id, token, now_utc) {
      const cutoff = DateTime.fromISO(now_utc, { zone: 'utc' }).minus({ minutes: 10 });
      return t.db6
        .filter(
          (r) =>
            r.status === 'pending' &&
            r.chain_id === chain_id &&
            r.token === token &&
            (r.kind === 'payment' ||
              r.kind === 'bridge_out' ||
              r.kind === 'bridge_fee' ||
              r.kind === 'autopay_prefund') &&
            DateTime.fromISO(r.created_at, { zone: 'utc' }) > cutoff,
        )
        .map(clone);
    },
    spentToday(token, timezone, now_utc) {
      const today = DateTime.fromISO(now_utc, { zone: 'utc' }).setZone(timezone).toISODate();
      const localDate = (iso: string | null): string | null =>
        iso === null ? null : DateTime.fromISO(iso, { zone: 'utc' }).setZone(timezone).toISODate();
      return t.db6
        .filter(
          (r) =>
            r.counts_toward_limit &&
            r.token === token &&
            ((r.status === 'pending' && localDate(r.created_at) === today) ||
              (r.status === 'executed' && localDate(r.executed_at) === today)),
        )
        .map(clone);
    },
  };

  const db7: Db7Autopays = {
    insertPending(row, now) {
      t.db7.set(row.autopay_id, {
        ...row,
        delegate_address: null,
        cre_job_id: null,
        plan_id: null,
        executor_address: null,
        fee: row.fee ?? null,
        recipients_json: row.recipients_json ?? null,
        display_json: row.display_json ?? null,
        status: 'pending',
        created_at: now,
        updated_at: now,
      });
    },
    get: (id) => clone(t.db7.get(id)),
    findByRecipient: (a, status) =>
      [...t.db7.values()]
        .filter(
          (r) =>
            (r.recipient_address.toLowerCase() === a.toLowerCase() ||
              (JSON.parse(r.recipients_json ?? '[]') as Array<{ recipient: string }>).some(
                (p) => p.recipient.toLowerCase() === a.toLowerCase(),
              )) &&
            (status === undefined || r.status === status),
        )
        .map(clone),
    listByRequest: (rid) => [...t.db7.values()].filter((r) => r.request_id === rid).map(clone),
    update(id, patch, now) {
      const r = t.db7.get(id);
      if (!r) throw new Error('db7 row not found');
      Object.assign(r, patch, { updated_at: now });
    },
  };

  const db8: Db8Session = {
    insertSession: (row) => void t.db8_sessions.set(row.session_id, clone(row)),
    getSession: (id) => clone(t.db8_sessions.get(id)),
    insertPrompt: (row) => void t.db8_prompts.push(clone(row)),
    appendHistory: (row) => void t.db8_history.push({ ...row, id: db8hId++ }),
    hasHistory: (sid, rid) => t.db8_history.some((r) => r.session_id === sid && r.request_id === rid),
    recentHistory: (sid, limit) =>
      t.db8_history
        .filter((r) => r.session_id === sid)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit)
        .map(clone),
  };

  const fake: FakeRepos = {
    db1,
    db2,
    db3,
    db4,
    db5,
    db6,
    db7,
    db8,
    handoffs: {
      insert(row) {
        if (t.handoffs.has(row.request_id)) throw new Error('duplicate handoff');
        t.handoffs.set(row.request_id, clone(row));
      },
      get: (id) => clone(t.handoffs.get(id)),
      update(id, patch) {
        const row = t.handoffs.get(id);
        if (row) Object.assign(row, clone(patch));
      },
    },
    tables: t,
    vacuumCount: 0,
    clearSessionStores() {
      t.db1.clear();
      t.db3.clear();
      t.db8_prompts.length = 0;
      t.db8_history.length = 0;
      t.db8_sessions.clear();
      for (const row of t.handoffs.values()) row.history = null;
      fake.vacuumCount++;
    },
    transaction: <T>(fn: () => T): T => fn(),
  };
  return fake;
}

/** Seeds a DB2 contact on the given chains (test setup helper; bypasses no invariant). */
export function seedContact(
  repos: FakeRepos,
  name: string,
  address: Address,
  chain_ids: ChainId[],
  ens_name: string | null = null,
): void {
  const r = repos.db2.addContact({ name, address, chain_ids, ens_name });
  if (!r.ok) throw new Error(`seedContact: ${r.reason}`);
}

/** Seeds DB4 balances: { [chain_id]: { USDC?: "80", ETH?: "0.1" } } with status ok. */
export function seedBalances(
  repos: FakeRepos,
  balances: Partial<Record<ChainId, Partial<Record<Token, string>>>>,
  updated_at = nowIso(),
): void {
  for (const [cid, toks] of Object.entries(balances)) {
    const chain_id = Number(cid) as ChainId;
    for (const [token, balance] of Object.entries(toks ?? {})) {
      const decimals = token === 'USDC' ? 6 : 18;
      repos.db4.upsertOk(
        {
          chain_id,
          chain: CHAIN_NAMES[chain_id],
          token: token as Token,
          balance,
          base_units: toBaseUnits(balance, decimals),
        },
        updated_at,
      );
    }
  }
}

/** Test-only decimal → base units (string math, no floats). */
export function toBaseUnits(decimal: string, decimals: number): string {
  const [i = '0', f = ''] = decimal.split('.');
  return (
    BigInt(i) * 10n ** BigInt(decimals) +
    BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')
  ).toString();
}
