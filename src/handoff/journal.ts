import type { Repos } from '../contracts/repos.js';

/** Called for a 2xx or a valid execution callback; retrying this never duplicates history. */
export function acceptHandoff(repos: Repos, request_id: string): void {
  const row = repos.handoffs.get(request_id);
  if (!row) return; // v1 databases have spend rows but no submission journal.
  repos.transaction(() => {
    repos.handoffs.update(request_id, { status: 'accepted' });
    if (row.history !== null && repos.db8.getSession(row.history.session_id) !== undefined) {
      repos.db8.appendHistory(row.history);
    }
    repos.handoffs.update(request_id, { history: null });
  });
}

/** A definite rejection releases reservations. Confirmed execution always wins over a late rejection. */
export function rejectHandoff(repos: Repos, request_id: string, now: string): void {
  const row = repos.handoffs.get(request_id);
  if (!row || row.status === 'accepted') return;
  repos.transaction(() => {
    for (const it of row.envelope.intents) {
      repos.db6.applyIntentResult({ request_id, step: it.step, status: 'failed', tx_hash: null, executed_at: null });
      if (it.intent_id === 'k' && repos.db7.get(it.autopay_id)?.status === 'pending') {
        repos.db7.update(it.autopay_id, { status: 'failed' }, now);
      }
    }
    repos.handoffs.update(request_id, { status: 'rejected', history: null });
  });
}
