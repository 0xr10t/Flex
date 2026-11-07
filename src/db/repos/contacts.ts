import { createHash } from 'node:crypto';
import type { ContactEdit, ContactRecord } from '@flex/protocol';
import type { ContactBook, Db2Row } from '../../contracts/repos.js';
import type { ChainId } from '../../contracts/types.js';
import { nameKey } from '../../lexical/text.js';
import type { Database } from '../database.js';
import type { RepoOptions } from './common.js';

function group(rows: Db2Row[]): ContactRecord {
  const first = rows[0]!;
  return {
    id: first.id,
    name: first.name,
    address: first.address,
    chain_ids: rows.map((r) => r.chain_id).sort((a, b) => a - b),
    ens_name: first.ens_name,
    version: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  };
}

/** User-initiated edits preserve the DB2 identity invariants in one immediate transaction. */
export function createContactBook(db: Database, opts: RepoOptions): ContactBook {
  const byId = db.prepare('SELECT * FROM db2_address_book WHERE id = ?');
  const byKey = db.prepare('SELECT * FROM db2_address_book WHERE name_key = ? ORDER BY id');
  const rowsFor = (id: number): Db2Row[] => {
    const row = byId.get(id) as Db2Row | undefined;
    return row ? (byKey.all(row.name_key) as Db2Row[]) : [];
  };
  const edit = db.transaction((id: number, draft: ContactEdit): ReturnType<ContactBook['edit']> => {
    const rows = rowsFor(id);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    const current = group(rows);
    if (current.version !== draft.version) return { ok: false, reason: 'stale' };
    const oldKey = rows[0]!.name_key;
    const key = nameKey(draft.name);
    if (key !== oldKey && byKey.get(key)) return { ok: false, reason: 'name_taken' };
    if (
      db
        .prepare('SELECT 1 FROM db2_address_book WHERE lower(address) = lower(?) AND name_key <> ? LIMIT 1')
        .get(draft.address, oldKey)
    )
      return { ok: false, reason: 'address_has_other_name' };
    const ens = current.address.toLowerCase() === draft.address.toLowerCase() ? current.ens_name : null;
    db.prepare('UPDATE db2_address_book SET name = ?, name_key = ?, address = ?, ens_name = ? WHERE name_key = ?').run(
      draft.name,
      key,
      draft.address,
      ens,
      oldKey,
    );
    const remove = db.prepare('DELETE FROM db2_address_book WHERE id = ?');
    for (const row of rows) if (!draft.chain_ids.includes(row.chain_id)) remove.run(row.id);
    const insert =
      db.prepare(`INSERT INTO db2_address_book (name, name_key, chain_id, chain, address, ens_name, added_at, added_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user_confirmed')`);
    for (const chain of draft.chain_ids) {
      if (!rows.some((r) => r.chain_id === chain))
        insert.run(draft.name, key, chain, opts.chainName(chain as ChainId), draft.address, ens, opts.now());
    }
    return { ok: true, contact: group(byKey.all(key) as Db2Row[]) };
  });
  return {
    get(id) {
      const rows = rowsFor(id);
      return rows.length ? group(rows) : undefined;
    },
    list(limit, offset) {
      const keys = db
        .prepare('SELECT name_key FROM db2_address_book GROUP BY name_key ORDER BY name_key LIMIT ? OFFSET ?')
        .all(limit, offset) as Array<{ name_key: string }>;
      const total = (db.prepare('SELECT COUNT(DISTINCT name_key) AS n FROM db2_address_book').get() as { n: number }).n;
      return { contacts: keys.map(({ name_key }) => group(byKey.all(name_key) as Db2Row[])), total };
    },
    edit: (id, draft) => edit.immediate(id, draft),
  };
}
