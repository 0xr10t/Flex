// Implements: §7.1 DB8 session store (db8_sessions, db8_prompts, db8_history), §7.2 written by the session
// manager (answers) / S1 (prompts) / S12 (history), §17.2 step 1 last 5 handed-off requests of the session.
// Owner: Lane A.

import type { Db8HistoryRow, Db8Session, Db8SessionRow } from '../../contracts/repos.js';
import type { Database } from '../database.js';

export function createDb8(db: Database): Db8Session {
  const insertSession = db.prepare('INSERT INTO db8_sessions (session_id, timezone, opened_at) VALUES (?, ?, ?)');
  const getSession = db.prepare('SELECT session_id, timezone, opened_at FROM db8_sessions WHERE session_id = ?');
  const insertPrompt = db.prepare(
    'INSERT INTO db8_prompts (session_id, request_id, kind, text, created_at) VALUES (?, ?, ?, ?, ?)',
  );
  const appendHistory = db.prepare(
    'INSERT INTO db8_history (session_id, request_id, payments_json, handed_off_at) VALUES (?, ?, ?, ?)',
  );
  const hasHistory = db.prepare('SELECT 1 FROM db8_history WHERE session_id = ? AND request_id = ? LIMIT 1');
  const recent = db.prepare('SELECT * FROM db8_history WHERE session_id = ? ORDER BY id DESC LIMIT ?');

  return {
    insertSession(row) {
      insertSession.run(row.session_id, row.timezone, row.opened_at);
    },
    getSession(session_id) {
      return getSession.get(session_id) as Db8SessionRow | undefined;
    },
    insertPrompt(row) {
      insertPrompt.run(row.session_id, row.request_id, row.kind, row.text, row.created_at);
    },
    appendHistory(row) {
      appendHistory.run(row.session_id, row.request_id, row.payments_json, row.handed_off_at);
    },
    hasHistory(session_id, request_id) {
      return hasHistory.get(session_id, request_id) !== undefined;
    },
    recentHistory(session_id, limit) {
      return recent.all(session_id, limit) as Db8HistoryRow[];
    },
  };
}
