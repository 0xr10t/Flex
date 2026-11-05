// Implements: §7.1 DB3 address placeholders (session-scoped), §7.3 placeholder minting with collision retry
// (`address_`/`group_` + 8 hex), §9.5 silent-reuse marking, §9.6 step 10 group + member rows.
// Owner: Lane A.

import type { Db3AddressPlaceholders, Db3Row } from '../../contracts/repos.js';
import type { Address, ChainId, GroupPh, RecipientPh, RecipientSource } from '../../contracts/types.js';
import type { Database } from '../database.js';
import { mintWithRetry, type RepoOptions } from './common.js';

interface Raw {
  placeholder: string;
  session_id: string;
  request_id: string;
  kind: string;
  name: string | null;
  address: string | null;
  ens_name: string | null;
  chain_id: number | null;
  group_placeholder: string | null;
  source: string;
  reused_from_chain_id: number | null;
  created_at: string;
}

const fromRaw = (r: Raw): Db3Row => ({
  placeholder: r.placeholder as RecipientPh,
  session_id: r.session_id,
  request_id: r.request_id,
  kind: r.kind as Db3Row['kind'],
  name: r.name,
  address: r.address as Address | null,
  ens_name: r.ens_name,
  chain_id: r.chain_id as ChainId | null,
  group_placeholder: r.group_placeholder as GroupPh | null,
  source: r.source as RecipientSource,
  reused_from_chain_id: r.reused_from_chain_id as ChainId | null,
  created_at: r.created_at,
});

export function createDb3(db: Database, opts: RepoOptions): Db3AddressPlaceholders {
  const insert = db.prepare(
    `INSERT INTO db3_address_placeholders
       (placeholder, session_id, request_id, kind, name, address, ens_name, chain_id, group_placeholder, source,
        reused_from_chain_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  );
  const getStmt = db.prepare('SELECT * FROM db3_address_placeholders WHERE placeholder = ?');
  const members = db.prepare(
    "SELECT * FROM db3_address_placeholders WHERE group_placeholder = ? AND kind = 'member' ORDER BY rowid",
  );
  const setReused = db.prepare('UPDATE db3_address_placeholders SET reused_from_chain_id = ? WHERE placeholder = ?');

  return {
    mint(row) {
      // §7.1: name is never NULL for kind 'single'.
      if (row.kind === 'single' && row.name === null) throw new Error('db3: single rows need a name');
      return mintWithRetry(
        () => (row.kind === 'group' ? opts.newPlaceholder('group') : opts.newPlaceholder('address')) as RecipientPh,
        (ph) =>
          insert.run(
            ph,
            row.session_id,
            row.request_id,
            row.kind,
            row.name,
            row.address,
            row.ens_name,
            row.chain_id,
            row.group_placeholder,
            row.source,
            opts.now(),
          ),
      );
    },
    get(placeholder) {
      const r = getStmt.get(placeholder) as Raw | undefined;
      return r ? fromRaw(r) : undefined;
    },
    listMembers(group_placeholder) {
      return (members.all(group_placeholder) as Raw[]).map(fromRaw);
    },
    setReusedFromChain(placeholder, chain_id) {
      const res = setReused.run(chain_id, placeholder);
      if (res.changes === 0) throw new Error('db3 row not found');
    },
  };
}
