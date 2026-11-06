// Independent grading of durable delivery, callback authorization, consent freshness and answer screening.
// Real HTTP/SQLCipher and engine-level SQLITE_FULL; external model/RPC/execution remain fakes.
import { afterEach, describe, expect, it } from 'vitest';
import type { HandoffEnvelope, ExecutionReport, ChainId } from '../../src/contracts/types.js';
import { openDatabase } from '../../src/db/open.js';
import { createRepos } from '../../src/db/repos/index.js';
import { registry } from '../../src/pipeline/registry.js';
import { createApp } from '../../src/server/app.js';
import { CapturingLogger } from '../fakes/io.js';
import type { FixtureCall, FixtureFile } from '../fakes/llm.js';
import { ARADHYA, ARB, BASE, Harness, loadFixture, REPORT_TOKEN, SEPOLIA, UI_TOKEN } from './harness.js';
import { planIdFor, DELEGATE, seedAutopay, seedSpend } from './seed.js';

const live = new Set<Harness>();
const PAY = 'send 10 usdc to mihir';
const REPEAT = 'pay mihir 10 usdc every month on the 31st for 3 months';
const STOP = 'stop paying mihir';
const TX: `0x${string}` = `0x${'cd'.repeat(32)}`;

function make(fixtures: string[] | FixtureFile = ['A-55'], contacts = true): Harness {
  const fixture = Array.isArray(fixtures) ? { calls: fixtures.flatMap((id) => loadFixture(id).calls) } : fixtures;
  const h = new Harness('handoff-independent', fixture, { contacts });
  live.add(h);
  return h;
}

afterEach(async () => {
  for (const h of live) await h.finish({ allowUnused: true });
  live.clear();
});

function executed(envelope: HandoffEnvelope, at: string): ExecutionReport {
  const intent = envelope.intents[0]!;
  return {
    kind: 'intent_result',
    request_id: envelope.request_id,
    step: intent.step,
    status: 'executed',
    executed_at: at,
    tx_hash: TX,
    ...(intent.intent_id === 'k' || intent.intent_id === 'l'
      ? {
          autopay: {
            autopay_id: intent.autopay_id,
            ...(intent.intent_id === 'k' ? { plan_id: planIdFor(intent.autopay_id), executor_address: DELEGATE, chain_id: intent.chain_id, token: intent.token } : {}),
          },
        }
      : {}),
  };
}

function diskPressure(h: Harness, table: 'handoff_journal' | 'db8_history'): () => void {
  h.db.exec('CREATE TABLE independent_pressure (payload BLOB)');
  const max = h.db.pragma('max_page_count', { simple: true }) as number;
  const pages = h.db.pragma('page_count', { simple: true }) as number;
  // Leave room for the normal reservation/journal rows, but not the trigger's 1 MiB allocation.
  h.db.pragma(`max_page_count = ${pages + 8}`);
  h.db.exec(`CREATE TEMP TRIGGER independent_full BEFORE INSERT ON ${table}
    BEGIN INSERT INTO independent_pressure VALUES (zeroblob(1048576)); END`);
  return () => {
    h.db.pragma(`max_page_count = ${max}`);
    h.db.exec('DROP TRIGGER independent_full');
  };
}

async function confirmMonthly(h: Harness) {
  const question = await h.say(REPEAT);
  expect(question.body.question?.code).toBe('Q_AUTOPAY_MONTHLY');
  const summary = await h.answer(question, { chip: 'four_weeks' });
  expect(summary.body.state).toBe('awaiting_confirmation');
  return h.confirm(summary, 'yes');
}

describe('B19 independent durable submission fault tests', () => {
  it('real SQLITE_FULL during preparation rolls back the autopay and spend rows before any external call', async () => {
    const h = make(['A-58']);
    const monthly = await h.say(REPEAT);
    const summary = await h.answer(monthly, { chip: 'four_weeks' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    const restore = diskPressure(h, 'handoff_journal');
    const insert = h.repos.handoffs.insert.bind(h.repos.handoffs);
    let staged: number[] = [];
    let code: unknown;
    h.repos.handoffs.insert = (row) => {
      staged = [h.count('db6_spend_log'), h.count('db7_autopays')];
      try {
        insert(row);
      } catch (e) {
        code = (e as { code?: unknown }).code;
        throw e;
      }
    };
    try {
      const response = await h.confirm(summary, 'yes');
      expect(code).toBe('SQLITE_FULL');
      expect(staged).toEqual([0, 1]);
      expect(response.body.error?.code).toBe('INTERNAL_ERROR');
      expect(h.exec.submissions).toHaveLength(0);
      for (const table of ['db6_spend_log', 'db7_autopays', 'handoff_journal', 'db8_history', 'independent_pressure'])
        expect(h.count(table), table).toBe(0);
    } finally {
      restore();
    }
  });

  it('real post-accept SQLITE_FULL retains delivery identity across a cold reopen and fresh HTTP app', async () => {
    const h = make(['A-58']);
    const monthly = await h.say(REPEAT);
    const summary = await h.answer(monthly, { chip: 'four_weeks' });
    const restore = diskPressure(h, 'db8_history');
    const append = h.repos.db8.appendHistory.bind(h.repos.db8);
    let code: unknown;
    h.repos.db8.appendHistory = (row) => {
      try {
        append(row);
      } catch (e) {
        code = (e as { code?: unknown }).code;
        throw e;
      }
    };
    try {
      const response = await h.confirm(summary, 'yes');
      expect(code).toBe('SQLITE_FULL');
      expect(response.body.state).toBe('done');
      expect(response.body.messages).toContainEqual({ type: 'text', text: 'Sent to your wallet for signing.' });
      expect(h.exec.submissions).toHaveLength(1);
      expect(h.count('db6_spend_log')).toBe(0);
      expect(h.count('db7_autopays')).toBe(1);
      expect(h.count('db8_history')).toBe(0);
      expect(h.repos.handoffs.get(summary.body.request_id)?.status).toBe('submitted');
    } finally {
      restore();
    }
    const envelope = structuredClone(h.envelope);
    const callback = executed(envelope, h.nowIso);
    const path = h.db.name;
    const key = 'f1'.repeat(32);
    h.db.pragma(`rekey = '${key}'`);
    await h.finish();
    live.delete(h);
    const db = openDatabase(path, key);
    const repos = createRepos(db);
    // Startup clears session data; execution correlation must survive without the old session manager.
    repos.clearSessionStores();
    const app = createApp({
      repos,
      registry,
      config: h.config,
      llm: h.llm,
      rpc: h.rpc,
      ens: h.ens,
      subnames: h.subnames,
      exec: h.exec,
      fetcher: h.fetcher,
      log: new CapturingLogger(),
      clock: () => h.clock,
      tokens: { ui: UI_TOKEN, report: REPORT_TOKEN },
    });
    try {
      expect(repos.handoffs.get(envelope.request_id)).toMatchObject({ envelope, history: null });
      for (let i = 0; i < 2; i++) {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/execution/reports',
          headers: { authorization: `Bearer ${REPORT_TOKEN}` },
          payload: callback,
        });
        expect(response.statusCode).toBe(204);
      }
      expect(repos.db6.listByRequest(envelope.request_id)).toHaveLength(0);
      expect(repos.db7.get(callback.autopay!.autopay_id)?.status).toBe('active');
      expect(repos.handoffs.get(envelope.request_id)).toMatchObject({ status: 'accepted', history: null });
      expect(repos.db8.recentHistory(h.sessionId, 5)).toEqual([]);
      expect(repos.db8.getSession(h.sessionId)).toBeUndefined();
      expect(h.exec.submissions).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it('retries use the persisted envelope after memory mutation, policy changes, clock advance and RPC loss', async () => {
    const h = make();
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const submit = h.exec.submit.bind(h.exec);
    let changed = false;
    h.exec.submit = async (envelope, key) => {
      const response = await submit(envelope, key);
      if (!changed) {
        changed = true;
        const intent = envelope.intents[0]!;
        if (intent.intent_id === 'i') {
          intent.recipients[0]!.amount.value = '999';
          intent.recipients[0]!.amount.base_units = '999000000';
        }
      }
      return response;
    };
    const summary = await h.say(PAY);
    expect((await h.confirm(summary, 'yes')).body.error?.code).toBe('EXECUTION_UNAVAILABLE');
    const original = structuredClone(h.envelope);
    const calls = h.rpc.calls.length;
    const limits = h.repos.db5.getAll();
    h.repos.db5.putAll({ ...limits, allowed_chain_ids: [SEPOLIA] }, h.nowIso);
    for (const chain of [SEPOLIA, BASE, ARB]) h.rpc.down.add(chain);
    h.advance(30 * 24 * 60);
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toHaveLength(2);
    expect(h.exec.submissions[1]).toEqual({ envelope: original, idempotencyKey: original.request_id });
    expect(h.rpc.calls).toHaveLength(calls);
    expect(h.repos.db6.listByRequest(original.request_id)).toHaveLength(1);
    expect(h.repos.db6.listByRequest(original.request_id)[0]?.amount).toBe('10');
    expect(h.count('db8_history')).toBe(1);
  });
});

describe('B03/B04/G02 independent callback and replay tests', () => {
  it.each(['k', 'l'] as const)('an early %s result wins over a late rejected or timed-out response', async (kind) => {
    const h = make([kind === 'k' ? 'A-58' : 'A-12']);
    if (kind === 'l') seedAutopay(h);
    h.exec.responses.push(
      kind === 'k' ? { status: 'rejected', message: 'late refusal' } : { status: 'unavailable', cause: 'timeout' },
    );
    const submit = h.exec.submit.bind(h.exec);
    h.exec.submit = async (envelope, key) => {
      expect(h.repos.handoffs.get(key)?.envelope).toEqual(envelope);
      const response = await submit(envelope, key);
      expect(await h.report(executed(envelope, h.nowIso))).toBe(204);
      return response;
    };
    expect((await (kind === 'k' ? confirmMonthly(h) : h.sayAndConfirm(STOP))).body.state).toBe('done');
    const report = executed(h.envelope, h.nowIso);
    expect(h.repos.db7.get(report.autopay!.autopay_id)?.status).toBe(kind === 'k' ? 'active' : 'cancelled');
    expect(h.repos.handoffs.get(h.envelope.request_id)?.status).toBe('accepted');
    expect(h.count('db8_history')).toBe(1);
    expect(await h.report(report)).toBe(204);
    expect(h.count('db8_history')).toBe(1);
  });

  it('an l-only callback requires its exact submitted request, step and autopay', async () => {
    const h = make(['A-12']);
    const target = seedAutopay(h);
    const other = seedAutopay(h, { id: 'ap_0123456789ac', name: 'Aradhya', address: ARADHYA });
    await h.sayAndConfirm(STOP);
    const valid = executed(h.envelope, h.nowIso);
    expect(h.repos.db6.listByRequest(h.envelope.request_id)).toEqual([]);
    for (const forged of [
      { ...valid, request_id: 'req_ffffffffffff' },
      { ...valid, step: 15 },
      { ...valid, autopay: { autopay_id: other } },
    ]) {
      expect(await h.report(forged)).toBe(404);
      expect(h.repos.db7.get(target)?.status).toBe('active');
      expect(h.repos.db7.get(other)?.status).toBe('active');
    }
    expect(await h.report({ ...valid, status: 'failed' })).toBe(204);
    expect(h.repos.db7.get(target)?.status).toBe('active');
    expect(await h.report(valid)).toBe(204);
    expect(h.repos.db7.get(target)?.status).toBe('cancelled');
    expect(h.repos.db7.get(other)?.status).toBe('active');
  });

  it('real creation/cancellation followed by old creation and failed-result replays preserves terminal state', async () => {
    const h = make(['A-58', 'A-12']);
    await confirmMonthly(h);
    const created = executed(h.envelope, h.nowIso);
    expect(await h.report(created)).toBe(204);
    const spend = h.repos.db6.listByRequest(created.request_id!);
    await h.sayAndConfirm(STOP);
    expect(await h.report(executed(h.envelope, h.nowIso))).toBe(204);
    expect(await h.report(created)).toBe(204);
    expect(await h.report({ ...created, status: 'failed', tx_hash: undefined, executed_at: undefined })).toBe(204);
    expect(h.repos.db7.get(created.autopay!.autopay_id)?.status).toBe('cancelled');
    expect(h.repos.db6.listByRequest(created.request_id!)).toEqual(spend);
    expect(h.count('db8_history')).toBe(2);
  });
});

describe('B08 independent secret-answer regressions', () => {
  const key = `0x${'ab'.repeat(32)}`;
  const encodedUrl = `https://example.invalid/?key=${Array.from(key, (c) => `%${c.charCodeAt(0).toString(16)}`).join('')}`;
  it.each([
    ['answers', 'abandon '.repeat(12).trim()],
    ['messages', '{"crypto":{"ciphertext":"synthetic","kdf":"scrypt"}}'],
    ['answers', encodedUrl],
    ['messages', encodedUrl],
  ])('blocks a secret submitted through %s before storage or model work', async (channel, secret) => {
    const h = make(['A-01'], false);
    const question = await h.say('Send 50 USDc to ARADHYA');
    expect(question.body.question?.code).toBe('Q_WHO_IS');
    const calls = h.llm.names();
    const response = channel === 'answers' ? await h.answer(question, { text: secret }) : await h.say(secret);
    const stored = h.rows<{ text: string }>('SELECT text FROM db8_prompts').some((r) => r.text === secret);
    expect(
      response.body.error?.code,
      JSON.stringify({ state: response.body.state, question: response.body.question?.code, stored }),
    ).toBe('SECRET_DETECTED');
    expect(stored).toBe(false);
    expect(h.llm.names()).toEqual(calls);
    expect(h.exec.submissions).toHaveLength(0);
  });
});

describe('G03 independent confirmation freshness', () => {
  it('a newly restricted chain requires a new summary and a second confirmation', async () => {
    const h = make();
    const summary = await h.say(PAY);
    h.repos.db5.putAll({ ...h.repos.db5.getAll(), allowed_chain_ids: [ARB] }, h.nowIso);
    const revised = await h.confirm(summary, 'yes');
    expect(revised.body.state).toBe('awaiting_confirmation');
    expect(JSON.stringify(revised.body.summary)).toContain('Arbitrum Sepolia');
    expect(h.exec.submissions).toHaveLength(0);
    expect((await h.confirm(revised, 'yes')).body.state).toBe('done');
    expect(h.envelope.intents[0]).toMatchObject({ intent_id: 'i', chain_id: ARB });
  });

  it('fresh spend accounting changes the summary even when no limit is breached', async () => {
    const h = make();
    const summary = await h.say(PAY);
    seedSpend(h, { amount: '5' });
    const revised = await h.confirm(summary, 'yes');
    expect(revised.body.state).toBe('awaiting_confirmation');
    expect(revised.body.summary).not.toEqual(summary.body.summary);
    expect(h.exec.submissions).toHaveLength(0);
    expect((await h.confirm(revised, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toHaveLength(1);
  });

  it('a balance disappearing after the summary prevents the first submission', async () => {
    const h = make();
    const summary = await h.say(PAY);
    const calls = h.rpc.calls.length;
    h.setBalances({ [BASE]: { USDC: '0' }, [ARB]: { USDC: '0' }, [SEPOLIA]: { USDC: '0' } });
    const response = await h.confirm(summary, 'yes');
    expect(response.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    // Privacy fix 8: the "yes" reads DB4 (kept fresh in the background); it sends nothing to the RPC.
    expect(h.rpc.calls.length).toBe(calls);
    expect(h.exec.submissions).toHaveLength(0);
    expect(h.count('handoff_journal')).toBe(0);
  });
});

function chainFixture(chains: Array<ChainId | 'unstated'>): FixtureFile {
  const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
  const payments = chains.map((chain, i) => ({
    kind: 'i',
    amount: `$amount:${i}`,
    recipient: `$recipient:${i}`,
    chain,
    frequency: null,
    interval: null,
    times_per_week: null,
    days_of_week: null,
    day_of_month: null,
  }));
  return {
    calls: [
      call('amounts', {
        amounts: chains.map((_, i) => ({
          phrase: `${10 * (i + 1)} usdc`,
          number: String(10 * (i + 1)),
          relative: null,
          token: 'USDC',
          fiat: null,
          role: 'pay',
        })),
      }),
      call('request_type', { request_type: 'actions', actions: ['i'], also_balance: false }),
      call('spans', {
        spans: (chains.length === 1 ? ['Mihir'] : ['Aradhya', 'Mihir']).map((text) => ({
          text,
          kind: 'name',
          role: 'payee',
        })),
      }),
      call('payments', { payments }),
      call('payments', { payments }),
    ],
  };
}

describe('G01 independent prefix and suffix chain binding', () => {
  it.each([
    ['on arbitrum, send 10 usdc to Mihir', ['unstated']],
    ['on arbitrum, send 10 usdc to Aradhya and 20 usdc to Mihir', ['unstated', ARB]],
    ['send 10 usdc to Aradhya and 20 usdc to Mihir, on arbitrum', ['unstated', ARB]],
    ['on arbitrum, send 10 usdc to Aradhya; on base, send 20 usdc to Mihir', [BASE, BASE]],
  ] as Array<[string, Array<ChainId | 'unstated'>]>)('rejects lost chain meaning in %s', async (text, chains) => {
    const h = make(chainFixture(chains));
    const response = await h.say(text);
    expect(
      response.body.error?.code,
      JSON.stringify({ state: response.body.state, summary: response.body.summary }),
    ).toBe('PAIRING_FAILED');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it.each([
    ['on arbitrum, send 10 usdc to Mihir', [ARB]],
    ['on arbitrum, send 10 usdc to Aradhya and 20 usdc to Mihir', [ARB, ARB]],
    ['send 10 usdc to Aradhya and 20 usdc to Mihir, on arbitrum', [ARB, ARB]],
    ['on arbitrum, send 10 usdc to Aradhya; on base, send 20 usdc to Mihir', [ARB, BASE]],
  ] as Array<[string, ChainId[]]>)('accepts faithful explicit chains in %s', async (text, chains) => {
    const h = make(chainFixture(chains));
    expect((await h.sayAndConfirm(text)).body.state).toBe('done');
    expect(h.envelope.intents.flatMap((intent) => intent.intent_id === 'i' ? intent.recipients.map(() => intent.chain_id) : [])).toEqual(chains);
  });
});
