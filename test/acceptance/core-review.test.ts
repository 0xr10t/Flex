// Independent review regressions through Fastify, the real pipeline and SQLCipher; all external IO is faked.
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import type { SubmitResult } from '../../src/contracts/io.js';
import type { ExecutionReport } from '../../src/contracts/types.js';
import type { FixtureFile } from '../fakes/llm.js';
import { Harness, loadFixture, BASE, MIHIR, ARADHYA } from './harness.js';
import { seedAutopay, seedSpend } from './seed.js';

const created: Harness[] = [];
const PAYMENT = 'Send 50 USDc to ARADHYA';
const AUTOPAY = 'pay mihir 10 usdc every friday for 8 weeks';
const stores = ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'];

function make(id: string, fixture: string | FixtureFile = 'A-01') {
  const h = new Harness(`core-review-${id}`, typeof fixture === 'string' ? loadFixture(fixture) : fixture, {});
  created.push(h);
  return h;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdExecution(h: Harness) {
  const entered = deferred();
  const result = deferred<SubmitResult>();
  h.exec.submit = async (envelope, idempotencyKey) => {
    h.exec.submissions.push({ envelope: structuredClone(envelope), idempotencyKey });
    entered.resolve();
    return result.promise;
  };
  return { entered: entered.promise, release: () => result.resolve({ status: 'accepted' }) };
}

afterEach(async () => {
  for (const h of created.splice(0)) await h.finish({ allowUnused: true });
});

describe('R1-F1 / R5-2 session lifecycle during real pipeline calls', () => {
  it.each(['close', 'replace'] as const)(
    'R1-F1 %s waits for S3 before clearing session placeholders',
    async (operation) => {
      const h = make(`s3-${operation}`);
      const entered = deferred();
      const release = deferred();
      const call = h.llm.call.bind(h.llm);
      h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
        const value = await call<T>(args);
        if (args.name === 'amounts') {
          entered.resolve();
          await release.promise;
        }
        return value;
      };
      const pending = h.say(PAYMENT);
      await entered.promise;
      const old = h.sessionId;
      let settled = false;
      const lifecycle = (operation === 'close' ? h.close() : h.open('UTC')).then((r) => {
        settled = true;
        return r;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        const concurrent = await h.http('POST', `/v1/sessions/${old}/messages`, { body: { text: 'stop' } });
        expect(concurrent.status).toBe(404);
      } finally {
        release.resolve();
      }
      const response = await pending;
      const closed = await lifecycle;
      expect(response.http).toBe(200);
      expect(response.body.state).toBe('awaiting_confirmation');
      expect(closed).toEqual(operation === 'close' ? 204 : expect.any(String));
      expect(stores.map((t) => h.count(t))).toEqual([0, 0, 0, 0]);
      expect(h.exec.submissions).toHaveLength(0);
      if (operation === 'replace') expect(h.sessionId).not.toBe(old);
    },
  );

  it.each([
    { operation: 'close', fixture: 'A-01', message: PAYMENT },
    { operation: 'replace', fixture: 'A-01', message: PAYMENT },
    { operation: 'close', fixture: 'A-08', message: AUTOPAY },
    { operation: 'replace', fixture: 'A-08', message: AUTOPAY },
  ])(
    'R1-F1 R5-2 $operation during $fixture hand-off preserves acceptance and persistent names',
    async ({ operation, fixture, message }) => {
      const h = make(`handoff-${operation}-${fixture}`, fixture);
      const summary = await h.say(message);
      expect(summary.body.state).toBe('awaiting_confirmation');
      const gate = holdExecution(h);
      const pending = h.confirm(summary, 'yes');
      await gate.entered;
      const old = h.sessionId;
      let settled = false;
      const lifecycle = (operation === 'close' ? h.close() : h.open('UTC')).then((r) => {
        settled = true;
        return r;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(h.count('db3_address_placeholders')).toBeGreaterThan(0);
        const peer = await h.http('POST', `/v1/sessions/${old}/confirm`, {
          body: { request_id: summary.body.request_id, decision: 'yes' },
        });
        expect(peer.status).toBe(404);
      } finally {
        gate.release();
      }
      const response = await pending;
      await lifecycle;
      expect(response.http).toBe(200);
      expect(response.body.messages).toContainEqual({ type: 'text', text: 'Sent to your wallet for signing.' });
      expect(h.exec.submissions).toHaveLength(1);
      expect(h.count('db6_spend_log')).toBe(1);
      expect(stores.map((t) => h.count(t))).toEqual([0, 0, 0, 0]);
      expect(
        (
          await h.http('POST', `/v1/sessions/${old}/confirm`, {
            body: { request_id: summary.body.request_id, decision: 'yes' },
          })
        ).status,
      ).toBe(404);
      if (fixture === 'A-08') {
        expect(h.rows('SELECT recipient_name, status FROM db7_autopays')).toEqual([
          { recipient_name: 'Mihir', status: 'pending' },
        ]);
      }
    },
  );
});

describe('R1-F3 earlier hand-off cancellation and SQ-R-06 timeout cancellation', () => {
  it.each(['payment', 'stop-autopay'] as const)(
    'R1-F3 cancel of an earlier %s remains truthful while a later request stays active',
    async (kind) => {
      const firstFixture = kind === 'payment' ? 'A-01' : 'A-11';
      const h = make(`old-cancel-${kind}`, {
        calls: [...loadFixture(firstFixture).calls, ...loadFixture('A-01').calls],
      });
      if (kind === 'stop-autopay') seedAutopay(h);
      const first = await h.say(kind === 'payment' ? PAYMENT : 'stop paying mihir');
      expect((await h.confirm(first, 'yes')).body.state).toBe('done');
      const next = await h.say(PAYMENT);
      expect(next.body.state).toBe('awaiting_confirmation');
      const response = await h.cancel(first);
      expect(response.body.messages).toEqual([
        { type: 'text', text: "That was already sent to your wallet for signing, so it can't be cancelled here." },
      ]);
      expect((await h.confirm(next, 'yes')).body.state).toBe('done');
      expect(h.exec.submissions).toHaveLength(2);
    },
  );

  it.each([
    { cause: 'timeout', mode: 'endpoint' },
    { cause: 'timeout', mode: 'text' },
    { cause: 'server_error', mode: 'endpoint' },
    { cause: 'server_error', mode: 'text' },
  ] as const)(
    'SQ-R-06 cancel after $cause via $mode gives the correct reply and prevents retry',
    async ({ cause, mode }) => {
      const h = make(`cancel-${cause}-${mode}`);
      h.exec.responses.push({ status: 'unavailable', cause });
      const summary = await h.say(PAYMENT);
      expect((await h.confirm(summary, 'yes')).body.error?.code).toBe('EXECUTION_UNAVAILABLE');
      const cancelled = mode === 'endpoint' ? await h.cancel(summary) : await h.say('stop');
      expect(cancelled.body.messages).toEqual([
        {
          type: 'text',
          text:
            cause === 'timeout'
              ? 'Cancelled here, but your wallet may already have received it. Check your wallet.'
              : 'Cancelled. Nothing was sent.',
        },
      ]);
      expect((await h.confirm(summary, 'yes')).http).toBe(409);
      expect(h.exec.submissions).toHaveLength(1);
    },
  );
});

describe('SQ-R-05 late autopay confirmation', () => {
  it('SQ-R-05 asks for a start, preserves prior answers, and requires a fresh summary confirmation', async () => {
    const h = make('late-start', 'A-09');
    const first = await h.say('pay mihir 10 usdc every friday');
    const count = await h.answer(first, { chipLabel: 'After a number of payments' });
    const summary = await h.answer(count, { text: '4' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    h.advance(12 * 60);
    const late = await h.confirm(summary, 'yes');
    expect(late.body.question?.code).toBe('Q_AUTOPAY_START');
    expect(h.exec.submissions).toHaveLength(0);
    const revised = await h.answer(late, { text: '2026-11-13' });
    expect(revised.body.state).toBe('awaiting_confirmation');
    expect(h.asked).toEqual(['Q_AUTOPAY_END', 'Q_AUTOPAY_COUNT', 'Q_AUTOPAY_START']);
    expect(h.exec.submissions).toHaveLength(0);
    expect(revised.body.summary?.lines.join(' ')).toContain('13 Nov 2026');
    expect((await h.confirm(revised, 'yes')).body.state).toBe('done');
    const k = h.envelope.intents.find((i) => i.intent_id === 'k');
    expect(k).toMatchObject({
      schedule: { start_date: '2026-11-13', end: { type: 'after_count', count: 4 } },
      limits: { total_cap: { value: '40' } },
    });
    if (k?.intent_id !== 'k') throw new Error('missing autopay');
    expect(Date.parse(k.schedule.first_occurrence)).toBeGreaterThan(h.clock.toMillis());
    expect(h.exec.submissions).toHaveLength(1);
  });

  it('B19 SQ-R-06 a late retry preserves its submitted envelope and the ambiguous-cancel warning', async () => {
    const h = make('late-timeout', 'A-08');
    const summary = await h.say(AUTOPAY);
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    await h.confirm(summary, 'yes');
    const original = structuredClone(h.envelope);
    h.advance(12 * 60);
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const late = await h.confirm(summary, 'yes');
    expect(late.body.error?.code).toBe('EXECUTION_UNAVAILABLE');
    expect(late.body.question).toBeUndefined();
    expect(h.envelope).toEqual(original);
    expect(h.exec.submissions.map((s) => s.idempotencyKey)).toEqual([original.request_id, original.request_id]);
    const cancelled = await h.cancel(late);
    expect(cancelled.body.messages[0]?.text).toBe(
      'Cancelled here, but your wallet may already have received it. Check your wallet.',
    );
    expect(h.exec.submissions).toHaveLength(2);
  });
});

describe('SQ-R-04 duplicate autopay reports', () => {
  it('SQ-R-04 replay inserts no spend and does not cause a false daily-limit question', async () => {
    const h = make('duplicate-report', 'A-55');
    const id = seedAutopay(h);
    const limits = h.repos.db5.getAll();
    limits.daily_max.USDC = '20';
    h.repos.db5.putAll(limits, h.nowIso);
    const report: ExecutionReport = {
      kind: 'autopay_payment',
      tx_hash: `0x${'aa'.repeat(32)}`,
      executed_at: h.nowIso,
      autopay: { autopay_id: id, amount: '10', token: 'USDC', chain_id: BASE },
    };
    expect(await h.report(report)).toBe(204);
    const first = h.rows('SELECT * FROM db6_spend_log');
    expect(first).toHaveLength(1);
    expect(await h.report(report)).toBe(204);
    expect(h.rows('SELECT * FROM db6_spend_log')).toEqual(first);
    expect((await h.say('send 10 usdc to mihir')).body.state).toBe('awaiting_confirmation');
  });

  it('SQ-R-04 a hash already used by an ordinary payment is also ignored', async () => {
    const h = make('duplicate-other-kind', { calls: [] });
    const id = seedAutopay(h);
    const tx_hash = `0x${'bb'.repeat(32)}`;
    seedSpend(h, { amount: '10', tx_hash });
    const before = h.rows('SELECT * FROM db6_spend_log');
    expect(
      await h.report({
        kind: 'autopay_payment',
        tx_hash,
        executed_at: h.nowIso,
        autopay: { autopay_id: id, amount: '10', token: 'USDC', chain_id: BASE },
      }),
    ).toBe(204);
    expect(h.rows('SELECT * FROM db6_spend_log')).toEqual(before);
  });
});

describe('R1-F2 and R4-F2 consent through the request runner', () => {
  it('R1-F2 every amount keeps its own retries through HTTP, and only the chosen pairing is submitted', async () => {
    const h = make('pair-attempts', 'SQ-O-03');
    let response = await h.say('send 10 usdc and 20 usdc to mihir and aradhya');
    for (const recipient of ['Aradhya', 'Mihir']) {
      expect(response.body.question?.code).toBe('Q_PAIR_AMOUNT');
      expect(response.body.question?.attempt).toBe(1);
      for (const attempt of [2, 3, 4]) {
        response = await h.answer(response, { text: 'someone else' });
        expect(response.body.question?.code).toBe('Q_PAIR_AMOUNT');
        expect(response.body.question?.attempt).toBe(attempt);
      }
      response = await h.answer(response, { chipLabel: recipient });
    }
    expect(response.body.state).toBe('awaiting_confirmation');
    expect((await h.confirm(response, 'yes')).body.state).toBe('done');
    expect(h.envelope.intents).toMatchObject([
      { intent_id: 'i', recipient: ARADHYA, amount: { value: '10' } },
      { intent_id: 'i', recipient: MIHIR, amount: { value: '20' } },
    ]);
  });

  it('R4-F2 a report received while a limit question is open triggers consent to the newly broken limit', async () => {
    const h = make('override-report');
    const id = seedAutopay(h);
    const limits = h.repos.db5.getAll();
    limits.per_tx_max.USDC = '40';
    limits.daily_max.USDC = '60';
    h.repos.db5.putAll(limits, h.nowIso);
    const first = await h.say(PAYMENT);
    expect(first.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    expect(first.body.question?.text).toContain('per-payment limit of 40');
    expect(first.body.question?.text).not.toContain("today's limit");
    expect(
      await h.report({
        kind: 'autopay_payment',
        tx_hash: `0x${'cc'.repeat(32)}`,
        executed_at: h.nowIso,
        autopay: { autopay_id: id, chain_id: BASE, token: 'USDC', amount: '20' },
      }),
    ).toBe(204);
    const second = await h.answer(first, { chipLabel: 'Yes' });
    expect(second.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    expect(second.body.question?.text).toContain("today's limit of 60 (only 40 is left)");
    expect(h.exec.submissions).toHaveLength(0);
    const summary = await h.answer(second, { chipLabel: 'Yes' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.repos.db5.getAll()).toEqual(limits);
  });
});
