// Durable, encrypted submission identity. This is an additive v2 table, not a change to the v1 spec DDL.
import type { HandoffJournal, HandoffJournalRow } from '../../contracts/repos.js';
import type { Database } from '../database.js';

export function createHandoffs(db: Database): HandoffJournal {
  const insert = db.prepare(
    'INSERT INTO handoff_journal (request_id, envelope_json, status, history_json) VALUES (?, ?, ?, ?)',
  );
  const get = db.prepare('SELECT * FROM handoff_journal WHERE request_id = ?');
  return {
    insert(row) {
      insert.run(
        row.request_id,
        JSON.stringify(row.envelope),
        row.status,
        row.history === null ? null : JSON.stringify(row.history),
      );
    },
    get(request_id) {
      const row = get.get(request_id) as
        | {
            request_id: string;
            envelope_json: string;
            status: HandoffJournalRow['status'];
            history_json: string | null;
          }
        | undefined;
      if (!row) return undefined;
      return {
        request_id: row.request_id,
        envelope: JSON.parse(row.envelope_json) as HandoffJournalRow['envelope'],
        status: row.status,
        history: row.history_json === null ? null : (JSON.parse(row.history_json) as HandoffJournalRow['history']),
      };
    },
    update(request_id, patch) {
      if (patch.status !== undefined)
        db.prepare('UPDATE handoff_journal SET status = ? WHERE request_id = ?').run(patch.status, request_id);
      if (patch.history !== undefined)
        db.prepare('UPDATE handoff_journal SET history_json = ? WHERE request_id = ?').run(
          patch.history === null ? null : JSON.stringify(patch.history),
          request_id,
        );
    },
  };
}
