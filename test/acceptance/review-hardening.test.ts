// Regression tests for the end-to-end Codex review. Real SQLCipher and HTTP, fixture model and executor.
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionReport, HandoffEnvelope } from '../../src/contracts/types.js';
import { openDatabase } from '../../src/db/open.js';
import { createRepos } from '../../src/db/repos/index.js';
import { applyReport } from '../../src/server/reports.js';
import { Harness, harness, loadFixture } from './harness.js';
import { DELEGATE } from './seed.js';

const live = new Set<Harness>();
async function make(id = 'A-55') {
  const h = await harness(id);
  live.add(h);
  return h;
}
afterEach(async () => {
  for (const h of live) await h.finish({ allowUnused: true });
  live.clear();
});
const tx = `0x${'cf'.repeat(32)}`;
function result(h: Harness, envelope: HandoffEnvelope = h.envelope): ExecutionReport {
  const first = envelope.intents[0]!;
  return {
    kind: 'intent_result',
    request_id: envelope.request_id,
    step: first.step,
    status: 'executed',
    tx_hash: tx,
    executed_at: h.nowIso,
    ...(first.intent_id === 'k'
      ? { autopay: { autopay_id: first.autopay_id, delegate_address: DELEGATE, cre_job_id: 'review-job' } }
      : {}),
  };
}
const pay = 'send 10 usdc to mihir';
const repeat = 'pay mihir 10 usdc every month on the 31st for 3 months';

describe('B19 / G02 durable submission and early reports', () => {
  it.each(['db6_spend_log', 'db7_autopays', 'handoff_journal'])(
    'a failing %s write prevents external submission',
    async (table) => {
      const h = await make('A-58');
      const summary = await h.say(repeat);
      expect(summary.body.state).toBe('awaiting_confirmation');
      h.db.exec(`CREATE TEMP TRIGGER fail_prepare BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'fault'); END`);
      const response = await h.confirm(summary, 'yes');
      expect(response.body.error?.code).toBe('INTERNAL_ERROR');
      expect(h.exec.submissions).toHaveLength(0);
      expect(h.count('db6_spend_log')).toBe(0);
      expect(h.count('db7_autopays')).toBe(0);
      expect(h.count('handoff_journal')).toBe(0);
    },
  );

  it('accepted submission survives a history fault, cold reopen, and callback retry', async () => {
    const h = await make('A-58');
    const summary = await h.say(repeat);
    h.db.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON db8_history BEGIN SELECT RAISE(ABORT, 'fault'); END");
    const response = await h.confirm(summary, 'yes');
    expect(response.body.state).toBe('done');
    expect(response.body.messages).toContainEqual({ type: 'text', text: 'Sent to your wallet for signing.' });
    expect(h.count('db6_spend_log')).toBe(1);
    expect(h.count('db7_autopays')).toBe(1);
    expect(h.count('db8_history')).toBe(0);
    const envelope = h.envelope;
    const callback = result(h);
    const path = h.db.name;
    const key = 'd8'.repeat(32);
    h.db.pragma(`rekey = '${key}'`);
    await h.finish();
    live.delete(h);
    const db = openDatabase(path, key);
    try {
      const repos = createRepos(db);
      expect(repos.handoffs.get(envelope.request_id)?.envelope).toEqual(envelope);
      expect(applyReport(repos, callback, h.nowIso)).toBe(204);
      expect(applyReport(repos, callback, h.nowIso)).toBe(204);
      expect(repos.db6.listByRequest(envelope.request_id)).toHaveLength(1);
      expect(repos.db6.listByRequest(envelope.request_id)[0]?.status).toBe('executed');
      expect(repos.db8.recentHistory(h.sessionId, 5)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('a callback before submit resolves is accepted and is not overwritten by the later 2xx', async () => {
    const h = await make();
    const submit = h.exec.submit.bind(h.exec);
    h.exec.submit = async (envelope, key) => {
      expect(h.repos.handoffs.get(key)?.envelope).toEqual(envelope);
      expect(await h.report(result(h, envelope))).toBe(204);
      return submit(envelope, key);
    };
    expect((await h.sayAndConfirm(pay)).body.state).toBe('done');
    expect(h.rows('SELECT status, tx_hash FROM db6_spend_log')).toEqual([{ status: 'executed', tx_hash: tx }]);
    expect(h.count('db8_history')).toBe(1);
  });

  it('closing a session erases deferred history without erasing the durable execution identity', async () => {
    const h = await make();
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const response = await h.sayAndConfirm(pay);
    const rid = response.body.request_id;
    expect(h.repos.handoffs.get(rid)?.history).not.toBeNull();
    await h.close();
    expect(h.repos.handoffs.get(rid)).toMatchObject({ history: null, status: 'submitted' });
    expect(await h.report(result(h))).toBe(204);
    expect(h.count('db8_history')).toBe(0);
    expect(h.count('db8_sessions')).toBe(0);
  });
});

describe('B03 / B04 exact callback correlation and replay', () => {
  it('rejects a nonexistent step and an unrelated autopay attached to an ordinary payment', async () => {
    const h = new Harness(
      'review-correlation',
      { calls: [...loadFixture('A-58').calls, ...loadFixture('A-55').calls] },
      {},
    );
    live.add(h);
    await h.sayAndConfirm(repeat);
    const creation = result(h);
    expect(await h.report(creation)).toBe(204);
    const autopay = creation.autopay!;
    await h.sayAndConfirm(pay);
    const ordinary = result(h);
    expect(await h.report({ ...ordinary, autopay })).toBe(404);
    expect(await h.report({ ...creation, step: 999 })).toBe(404);
    expect(h.repos.db7.get(autopay.autopay_id)?.status).toBe('active');
    expect(h.repos.db6.listByRequest(ordinary.request_id!)[0]?.status).toBe('pending');
  });

  it('an executed payment cannot be downgraded or lose its spend accounting on replay', async () => {
    const h = await make();
    await h.sayAndConfirm(pay);
    const executed = result(h);
    expect(await h.report(executed)).toBe(204);
    const before = h.repos.db6.listByRequest(executed.request_id!);
    expect(await h.report({ kind: 'intent_result', request_id: executed.request_id, step: 0, status: 'failed' })).toBe(
      204,
    );
    expect(h.repos.db6.listByRequest(executed.request_id!)).toEqual(before);
    expect(h.repos.db6.spentToday('USDC', 'Asia/Kolkata', h.nowIso).map((row) => row.amount)).toEqual(['10']);
  });

  it('creation or status replays cannot reactivate a cancelled autopay', async () => {
    const h = await make('A-58');
    await h.sayAndConfirm(repeat);
    const created = result(h);
    expect(await h.report(created)).toBe(204);
    const id = created.autopay!.autopay_id;
    expect(await h.report({ kind: 'autopay_status', autopay: { autopay_id: id, status: 'cancelled' } })).toBe(204);
    expect(await h.report(created)).toBe(204);
    expect(await h.report({ kind: 'autopay_status', autopay: { autopay_id: id, status: 'active' } })).toBe(204);
    expect(h.repos.db7.get(id)?.status).toBe('cancelled');
  });
});

describe('B08 answers are screened before persistence', () => {
  it.each(['answers', 'messages'] as const)('blocks a secret on /%s', async (channel) => {
    const h = await harness('A-01', { contacts: false });
    live.add(h);
    const initial = await h.say('Send 50 USDc to ARADHYA');
    expect(initial.body.question?.code).toBe('Q_WHO_IS');
    const secret = `0x${'ab'.repeat(32)}`;
    const names = h.llm.names();
    const response = channel === 'answers' ? await h.answer(initial, { text: secret }) : await h.say(secret);
    expect(response.body.error?.code).toBe('SECRET_DETECTED');
    expect(h.rows<{ text: string }>('SELECT text FROM db8_prompts').some((r) => r.text.includes(secret))).toBe(false);
    expect(h.llm.names()).toEqual(names);
    expect(h.exec.submissions).toHaveLength(0);
  });
});
