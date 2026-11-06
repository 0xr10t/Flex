// Lane A unit tests: §17.1 session lifecycle, the request runner over the step registry (src/contracts/step.ts
// runner semantics, every StepResult kind), §9.7 / §13.4 attempts → TOO_MANY_RETRIES, §17.3 confirmation/answer/
// cancel table, §8.14 step 6 HANDOFF_FAILED retries, §13.3 fixed replies, §15 error responses, §14.1 409 rules,
// §18 metrics lines.
import { describe, expect, it } from 'vitest';
import { CHIPS, ERROR_MESSAGE, REPLY } from '../../../src/contracts/catalog.js';
import { LOG_ALLOWED_FIELDS } from '../../../src/contracts/io.js';
import { LlmFailed } from '../../../src/contracts/llm.js';
import type { StepResult } from '../../../src/contracts/step.js';
import type { AgentResponse, Question } from '../../../src/contracts/types.js';
import { CANCEL_TEXTS, CONFIRM_NO_TEXTS, CONFIRM_YES_TEXTS } from '../../../src/contracts/static-tables.js';
import { MAX_ATTEMPTS, MAX_HANDOFF_ATTEMPTS, type SessionResult } from '../../../src/session/manager.js';
import { openTempDb } from './helpers.js';
import { SUMMARY, makeHarness, msg, question, stepNames, type Harness } from './session-harness.js';
import { FixtureLlmClient } from '../../fakes/llm.js';

const ALL = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];

function body(r: SessionResult): AgentResponse {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r.body;
}

async function open(h: Harness): Promise<string> {
  return (await h.manager.openSession('Asia/Kolkata')).session_id;
}

/** Opens a session and runs a message up to the S11 summary. */
async function toConfirmation(h: Harness): Promise<{ sid: string; rid: string }> {
  const sid = await open(h);
  const r = body(await h.manager.handleMessage(sid, msg('send 50 usdc to aradhya')));
  expect(r.state).toBe('awaiting_confirmation');
  return { sid, rid: r.request_id };
}

/** Opens a session and pauses S3 on a question. */
async function toQuestion(h: Harness, q: Question = question()): Promise<{ sid: string; rid: string; q: Question }> {
  // S3 asks on its first run only; when re-entered after the answer it continues.
  let asked = false;
  h.set('s3', {
    step: async () => {
      if (asked) return { kind: 'continue' };
      asked = true;
      return { kind: 'question', question: q };
    },
  });
  const sid = await open(h);
  const r = body(await h.manager.handleMessage(sid, msg('send 50 to aradhya')));
  expect(r.state).toBe('awaiting_answer');
  return { sid, rid: r.request_id, q };
}

const finals = (h: Harness): string[] =>
  h.log.lines.filter((l) => l.event === 'request_final').map((l) => l.state ?? '');

describe('§17.1 session lifecycle', () => {
  it('C-410 / C-339: openSession returns ses_<12hex>, stores the DB8 session row with its timezone', async () => {
    const h = makeHarness();
    const { session_id } = await h.manager.openSession('Europe/Berlin');
    expect(session_id).toMatch(/^ses_[0-9a-f]{12}$/);
    expect(h.repos.db8.getSession(session_id)).toMatchObject({ timezone: 'Europe/Berlin' });
    expect(h.manager.openSessionId()).toBe(session_id);
  });

  it('C-339: an invalid IANA timezone is refused', async () => {
    await expect(makeHarness().manager.openSession('Mars/Olympus')).rejects.toThrow();
  });

  it('C-410 / C-452 §20.1 session: opening a session closes the previous one (one open session, I-08)', async () => {
    const h = makeHarness();
    const first = await open(h);
    const second = await open(h);
    expect(second).not.toBe(first);
    expect(h.repos.vacuumCount).toBe(1);
    expect((await h.manager.handleMessage(first, msg('hi'))).kind).toBe('not_found');
    expect(body(await h.manager.handleMessage(second, msg('hi'))).session_id).toBe(second);
  });

  it('C-340: closeSession → true and clears; unknown id → false', async () => {
    const h = makeHarness();
    const sid = await open(h);
    expect(await h.manager.closeSession('ses_000000000000')).toBe(false);
    expect(await h.manager.closeSession(sid)).toBe(true);
    expect(h.repos.vacuumCount).toBe(1);
    expect(h.manager.openSessionId()).toBeNull();
    expect(await h.manager.closeSession(sid)).toBe(false);
  });

  it('C-340: a session left in DB8 by a crashed process can be closed (clears the stores)', async () => {
    const h = makeHarness();
    h.repos.db8.insertSession({ session_id: 'ses_aaaaaaaaaaaa', timezone: 'UTC', opened_at: 't' });
    expect(await h.manager.closeSession('ses_aaaaaaaaaaaa')).toBe(true);
    expect(h.repos.vacuumCount).toBe(1);
  });

  it('C-411 / C-452: close clears every row of DB1, DB3 and DB8 and nothing else (real SQLCipher DB)', async () => {
    const t = openTempDb();
    t.repos.db5.insertDefaultsIfMissing('t');
    const h = makeHarness({ repos: t.repos });
    const sid = (await h.manager.openSession('Asia/Kolkata')).session_id;
    h.set('s3', {
      step: async (ctx) => {
        ctx.repos.db1.mint({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          amount: '50',
          token: 'USDC',
          source: 'user',
          origin: 'phrase',
          confirmed: true,
        });
        return { kind: 'continue' };
      },
    });
    h.set('s12', {
      step: async (ctx) => {
        ctx.repos.db6.insertMany([
          {
request_id: ctx.req.request_id,
step: 0,
kind: 'payment',
counts_toward_limit: true,
chain_id: 84532,
token: 'USDC',
recipient_address: '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
intent_id: 'i',
autopay_id: null,
status: 'pending',
tx_hash: null,
created_at: '2026-11-05T17:30:00.000Z',
executed_at: null,
amount: '50'
},
        ]);
        ctx.repos.db8.appendHistory({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          payments_json: '[]',
          handed_off_at: 't',
        });
        return { kind: 'continue' };
      },
    });
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    body(await h.manager.handleConfirm(sid, r.request_id, 'yes'));
    t.repos.db2.addContact({
      name: 'Mihir',
      address: '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0',
      chain_ids: [84532],
      ens_name: null,
    });
    const n = (table: string): number => (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
    expect(n('db1_amount_placeholders')).toBe(1);
    expect(n('db8_history')).toBe(1);
    expect(await h.manager.closeSession(sid)).toBe(true);
    for (const table of [
      'db1_amount_placeholders',
      'db3_address_placeholders',
      'db8_prompts',
      'db8_history',
      'db8_sessions',
    ]) {
      expect(n(table), table).toBe(0);
    }
    // Handed-off request unaffected: DB6 row, DB2, DB5 stay.
    expect(n('db6_spend_log')).toBe(1);
    expect(n('db2_address_book')).toBe(1);
    expect(n('db5_limits')).toBe(9);
  });

  it('C-411: a request in progress is abandoned as DISCARDED when the session closes', async () => {
    const h = makeHarness();
    const { sid } = await toQuestion(h);
    await h.manager.closeSession(sid);
    expect(finals(h)).toEqual(['DISCARDED']);
  });

  it('C-411 / R1-F1: a request whose step is still running when the session closes: the close waits, the call completes normally, then the request is DISCARDED', async () => {
    const h = makeHarness();
    const sid = await open(h);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const inS5 = new Promise<void>((r) => {
      started = r;
    });
    h.set('s5', {
      step: () =>
        new Promise<StepResult>((resolve) => {
          release = () => resolve({ kind: 'continue' });
          started();
        }),
    });
    const pending = h.manager.handleMessage(sid, msg('x'));
    await inS5;
    let closed = false;
    const closing = h.manager.closeSession(sid).then((r) => {
      closed = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false); // still waiting for the call in flight
    // new calls on the closing session get not_found
    expect((await h.manager.handleMessage(sid, msg('y'))).kind).toBe('not_found');
    release();
    // the in-flight call completes normally (reaches its summary)
    expect(body(await pending).state).toBe('awaiting_confirmation');
    expect(await closing).toBe(true);
    expect(finals(h)).toEqual(['DISCARDED']);
    expect(stepNames(h.calls)).toContain('s11');
    expect(h.manager.openSessionId()).toBeNull();
  });

  it('R1-F1: openSession over an open session waits for the call in flight, too', async () => {
    const h = makeHarness();
    const sid = await open(h);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const inS5 = new Promise<void>((r) => {
      started = r;
    });
    h.set('s5', {
      step: () =>
        new Promise<StepResult>((resolve) => {
          release = () => resolve({ kind: 'continue' });
          started();
        }),
    });
    const pending = h.manager.handleMessage(sid, msg('x'));
    await inS5;
    const opening = h.manager.openSession('Asia/Kolkata');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.manager.openSessionId()).not.toBeNull();
    release();
    expect(body(await pending).state).toBe('awaiting_confirmation');
    const second = (await opening).session_id;
    expect(second).not.toBe(sid);
    expect(finals(h)).toEqual(['DISCARDED']);
    expect(h.manager.openSessionId()).toBe(second);
  });

  it('C-410: no idle timeout — the session still works days later', async () => {
    const h = makeHarness();
    const sid = await open(h);
    h.clock.iso = '2026-11-20T00:00:00.000Z';
    expect(body(await h.manager.handleMessage(sid, msg('x'))).state).toBe('awaiting_confirmation');
  });

  it('C-338: calls for an unknown or closed session → not_found', async () => {
    const h = makeHarness();
    expect((await h.manager.handleMessage('ses_000000000000', msg('x'))).kind).toBe('not_found');
    expect((await h.manager.handleAnswer('ses_000000000000', { question_id: 'q', text: 'x' })).kind).toBe('not_found');
    expect((await h.manager.handleConfirm('ses_000000000000', 'r', 'yes')).kind).toBe('not_found');
    expect((await h.manager.handleCancel('ses_000000000000', 'r')).kind).toBe('not_found');
  });
});

describe('runner over the registry (src/contracts/step.ts semantics)', () => {
  it('§3.3: a new message runs S0…S11 in order and stops at the S11 summary (S12 only after "yes")', async () => {
    const h = makeHarness();
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(stepNames(h.calls)).toEqual(ALL);
    expect(r).toEqual({
      session_id: sid,
      request_id: expect.stringMatching(/^req_[0-9a-f]{12}$/) as unknown as string,
      state: 'awaiting_confirmation',
      messages: [],
      summary: SUMMARY,
    });
  });

  it('§8.0: request states advance per step (BALANCES_REFRESHED … VALIDATED → AWAITING_CONFIRMATION)', async () => {
    const h = makeHarness();
    const seen: string[] = [];
    for (const s of ['s1', 's4', 's11'] as const) {
      h.set(s, {
        step: async (ctx) => {
          seen.push(ctx.req.state);
          return s === 's11' ? { kind: 'summary', summary: SUMMARY } : { kind: 'continue' };
        },
      });
    }
    const sid = await open(h);
    await h.manager.handleMessage(sid, msg('x'));
    expect(seen).toEqual(['BALANCES_REFRESHED', 'AMOUNTS_MASKED', 'VALIDATED']);
    expect(h.contexts.at(-1)?.req.state).toBe('AWAITING_CONFIRMATION');
  });

  it('C-050: StepContext carries the in-memory request, the DB5 snapshot, the session timezone and its clock', async () => {
    const h = makeHarness();
    await h.manager.openSession('America/New_York');
    const sid = h.manager.openSessionId() as string;
    await h.manager.handleMessage(sid, msg('pay 5'));
    const ctx = h.contexts[0];
    expect(ctx?.req.input?.text).toBe('pay 5');
    expect(ctx?.req.session_id).toBe(sid);
    expect(ctx?.timezone).toBe('America/New_York');
    expect(ctx?.now().zoneName).toBe('America/New_York');
    expect(ctx?.now().toUTC().toISO()).toBe('2026-11-05T17:30:00.000Z');
    expect(ctx?.limits).toEqual(h.repos.db5.getAll());
    // One request object for the whole run.
    expect(new Set(h.contexts.map((c) => c.req)).size).toBe(1);
  });

  it('C-050: the runner itself writes no typed/pasted prompt (S1 does, §8.2 step 6)', async () => {
    const h = makeHarness();
    const sid = await open(h);
    await h.manager.handleMessage(sid, msg('send 50 usdc'));
    expect(h.repos.tables.db8_prompts).toEqual([]);
  });

  it('question → awaiting_answer; the answer goes to the asking step’s AnswerHandler; continue re-enters THE SAME step (S0–S2 not rerun)', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    const r = body(await h.manager.handleAnswer(sid, { question_id: q.question_id, chip_id: 'USDC' }));
    expect(r.state).toBe('awaiting_confirmation');
    expect(stepNames(h.calls)).toEqual([
      's0',
      's1',
      's2',
      's3',
      's3:answer',
      's3',
      's4',
      's5',
      's6',
      's7',
      's8',
      's9',
      's10',
      's11',
    ]);
    const ans = h.calls.find((c) => c.kind === 'answer');
    expect(ans?.question).toEqual(q);
    expect(ans?.answer).toEqual({ kind: 'chip', chip_id: 'USDC' });
  });

  it('awaiting_answer response carries the §13.4 question; prepended messages come first', async () => {
    const h = makeHarness();
    const q = question('Q_WHO_IS');
    h.set('s4', {
      step: async (ctx) => {
        ctx.req.prepend_messages.push('balance line');
        return { kind: 'continue' };
      },
    });
    h.set('s6', { step: async () => ({ kind: 'question', question: q }) });
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(r).toMatchObject({
      state: 'awaiting_answer',
      question: q,
      messages: [{ type: 'text', text: 'balance line' }],
    });
    expect(r.summary).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it('C-039 §7.2: the session manager writes each answer to db8_prompts (kind answer)', async () => {
    const h = makeHarness();
    const { sid, rid, q } = await toQuestion(h);
    const interpreter = new FixtureLlmClient({
      calls: [{ name: 'conversation', match: 'usdc please', output: { intent: 'clarify', value: null } }],
    });
    h.llm.call = interpreter.call.bind(interpreter);
    const response = body(await h.manager.handleAnswer(sid, { question_id: q.question_id, text: 'usdc please' }));
    expect(response.question).toEqual(q);
    expect(interpreter.remaining()).toEqual([]);
    expect(h.repos.tables.db8_prompts).toEqual([
      { session_id: sid, request_id: rid, kind: 'answer', text: 'usdc please', created_at: '2026-11-05T17:30:00.000Z' },
    ]);
  });

  it('AnswerHandler returning a new question pauses again on the same step; its id is the one now accepted', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    const q2 = question('Q_AMOUNT_PRECISION');
    h.set('s3', { onAnswer: async () => ({ kind: 'question', question: q2 }) });
    const r = body(await h.manager.handleAnswer(sid, { question_id: q.question_id, chip_id: 'unoffered' }));
    expect(r.question).toEqual(q2);
    expect((await h.manager.handleAnswer(sid, { question_id: q.question_id, chip_id: 'unoffered' })).kind).toBe(
      'conflict',
    );
    expect((await h.manager.handleAnswer(sid, { question_id: q2.question_id, chip_id: 'unoffered' })).kind).toBe('ok');
  });

  it("'answer' → request ANSWERED, state done, messages returned", async () => {
    const h = makeHarness();
    h.set('s4', { step: async () => ({ kind: 'answer', messages: ['You have 80 USDC on Base Sepolia.'] }) });
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('balance?')));
    expect(r).toMatchObject({ state: 'done', messages: [{ type: 'text', text: 'You have 80 USDC on Base Sepolia.' }] });
    expect(stepNames(h.calls)).toEqual(['s0', 's1', 's2', 's3', 's4']);
    expect(finals(h)).toEqual(['ANSWERED']);
  });

  it("C-396: 'error' → state error, catalog message with params, request FAILED", async () => {
    const h = makeHarness();
    h.set('s10', {
      step: async () => ({ kind: 'error', code: 'LIMIT_DAILY', params: { token: 'USDC', remaining: '20' } }),
    });
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(r).toEqual({
      session_id: sid,
      request_id: r.request_id,
      state: 'error',
      messages: [],
      error: { code: 'LIMIT_DAILY', message: ERROR_MESSAGE.LIMIT_DAILY({ token: 'USDC', remaining: '20' }) },
    });
    expect(finals(h)).toEqual(['FAILED']);
    expect(h.log.lines.find((l) => l.event === 'request_final')?.error_code).toBe('LIMIT_DAILY');
  });

  it("C-396: 'error' with final_state ANSWERED (refusal) → request ANSWERED", async () => {
    const h = makeHarness();
    h.set('s4', { step: async () => ({ kind: 'error', code: 'UNSUPPORTED_REQUEST', final_state: 'ANSWERED' }) });
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('swap')));
    expect(r.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(finals(h)).toEqual(['ANSWERED']);
  });

  it("'error' whose catalog params are missing is a bug → INTERNAL_ERROR (§11.1)", async () => {
    const h = makeHarness();
    h.set('s9', { step: async () => ({ kind: 'error', code: 'NO_GAS' }) });
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(r.error).toEqual({ code: 'INTERNAL_ERROR', message: ERROR_MESSAGE.INTERNAL_ERROR({}) });
  });

  it("'discard' → DISCARDED with the step's messages, or CANCELLED by default (SQ-15)", async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h, question('Q_LIMIT_OVERRIDE'));
    h.set('s3', { onAnswer: async () => ({ kind: 'discard' }) });
    const r = body(await h.manager.handleAnswer(sid, { question_id: q.question_id, chip_id: 'no' }));
    expect(r).toMatchObject({ state: 'done', messages: [{ type: 'text', text: REPLY.CANCELLED() }] });
    expect(finals(h)).toEqual(['DISCARDED']);

    const h2 = makeHarness();
    h2.set('s6', { step: async () => ({ kind: 'discard', messages: ['custom'] }) });
    const sid2 = await open(h2);
    expect(body(await h2.manager.handleMessage(sid2, msg('x'))).messages).toEqual([{ type: 'text', text: 'custom' }]);
  });

  it('LlmFailed thrown by a step or handler → MODEL_FAILED; any other exception → INTERNAL_ERROR', async () => {
    const h = makeHarness();
    h.set('s3', {
      step: async () => {
        throw new LlmFailed('amounts');
      },
    });
    const sid = await open(h);
    expect(body(await h.manager.handleMessage(sid, msg('x'))).error?.code).toBe('MODEL_FAILED');
    h.set('s3', {
      step: async () => {
        throw new Error('bug with secret 0xabc');
      },
    });
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(r.error).toEqual({ code: 'INTERNAL_ERROR', message: ERROR_MESSAGE.INTERNAL_ERROR({}) });
    expect(JSON.stringify(h.log.lines)).not.toContain('0xabc');
  });

  it('§14.4: model unavailable → every request fails with MODEL_FAILED and no step runs', async () => {
    const h = makeHarness();
    h.llm.available = false;
    const sid = await open(h);
    const r = body(await h.manager.handleMessage(sid, msg('x')));
    expect(r.error).toEqual({ code: 'MODEL_FAILED', message: ERROR_MESSAGE.MODEL_FAILED({}) });
    expect(h.calls).toEqual([]);
  });

  it('§0 / SQ-19: uncovered results → UNSUPPORTED_REQUEST with an unsupported_state log line', async () => {
    // summary from a step other than S11
    const h1 = makeHarness();
    h1.set('s5', { step: async () => ({ kind: 'summary', summary: SUMMARY }) });
    let sid = await open(h1);
    expect(body(await h1.manager.handleMessage(sid, msg('x'))).error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(h1.log.lines.some((l) => l.event === 'unsupported_state' && l.rule_id === 's5:summary')).toBe(true);
    // S11 returning continue
    const h2 = makeHarness();
    h2.set('s11', { step: async () => ({ kind: 'continue' }) });
    sid = await open(h2);
    expect(body(await h2.manager.handleMessage(sid, msg('x'))).error?.code).toBe('UNSUPPORTED_REQUEST');
    // a paused step without an AnswerHandler
    const h3 = makeHarness();
    const { sid: sid3, q } = await toQuestion(h3);
    h3.set('s3', { onAnswer: undefined });
    expect(
      body(await h3.manager.handleAnswer(sid3, { question_id: q.question_id, chip_id: 'unoffered' })).error?.code,
    ).toBe('UNSUPPORTED_REQUEST');
  });
});

describe('§9.7 / §13.4 attempts', () => {
  it('C-201 / C-389 / C-420: re-asks up to attempt 4; the 4th failed answer → TOO_MANY_RETRIES, FAILED', async () => {
    expect(MAX_ATTEMPTS).toBe(4);
    const h = makeHarness();
    let current: Question = { ...question('Q_AMOUNT_MISSING', 1), input: 'number' };
    const { sid } = await toQuestion(h, current);
    h.set('s3', {
      onAnswer: async (_ctx, q) => ({
        kind: 'question',
        question: { ...question(q.code), input: q.input, attempt: q.attempt + 1 },
      }),
    });
    for (const attempt of [2, 3, 4]) {
      const r = body(await h.manager.handleAnswer(sid, { question_id: current.question_id, text: '0' }));
      expect(r.state).toBe('awaiting_answer');
      expect(r.question?.attempt).toBe(attempt);
      current = r.question as Question;
    }
    const last = body(await h.manager.handleAnswer(sid, { question_id: current.question_id, text: '0' }));
    expect(last).toMatchObject({
      state: 'error',
      error: { code: 'TOO_MANY_RETRIES', message: "Let's start over. Nothing was sent." },
    });
    expect(last.question).toBeUndefined();
    expect(finals(h)).toEqual(['FAILED']);
    // The request is over: the old question id is stale now.
    expect((await h.manager.handleAnswer(sid, { question_id: current.question_id, text: 'x' })).kind).toBe('conflict');
  });

  it('C-420: free-text re-asks via the messages call count the same way', async () => {
    const h = makeHarness();
    const { sid } = await toQuestion(h, { ...question('Q_AMOUNT_MISSING', 4), input: 'number' });
    h.set('s3', { onAnswer: async (_c, q) => ({ kind: 'question', question: { ...q, attempt: q.attempt + 1 } }) });
    expect(body(await h.manager.handleMessage(sid, msg('0'))).error?.code).toBe('TOO_MANY_RETRIES');
  });
});

describe('§17.3 confirmation, answers and cancellation', () => {
  it('C-421: awaiting an answer + messages call → a native literal reaches the pending field handler', async () => {
    const h = makeHarness();
    const { sid, rid } = await toQuestion(h, { ...question('Q_TOKEN'), chips: [CHIPS.USDC, CHIPS.ETH] });
    const r = body(await h.manager.handleMessage(sid, msg('ETH')));
    expect(r.request_id).toBe(rid);
    expect(h.calls.find((c) => c.kind === 'answer')?.answer).toEqual({ kind: 'text', text: 'ETH' });
    expect(r.state).toBe('awaiting_confirmation');
  });

  it('C-342: answers with a wrong/stale question_id → conflict; answers while awaiting confirmation → conflict', async () => {
    const h = makeHarness();
    const { sid } = await toQuestion(h);
    expect((await h.manager.handleAnswer(sid, { question_id: 'q_000000000000', text: 'x' })).kind).toBe('conflict');
    const h2 = makeHarness();
    const c = await toConfirmation(h2);
    expect((await h2.manager.handleAnswer(c.sid, { question_id: 'q_000000000000', text: 'yes' })).kind).toBe(
      'conflict',
    );
  });

  it('C-342: chip, text and selected_ids answers reach the handler as typed Answers', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h, question('Q_GROUP_MEMBERS'));
    await h.manager.handleAnswer(sid, { question_id: q.question_id, selected_ids: ['a', 'b'] });
    expect(h.calls.find((c) => c.kind === 'answer')?.answer).toEqual({ kind: 'selected', selected_ids: ['a', 'b'] });
  });

  for (const text of CANCEL_TEXTS) {
    it(`C-422 / C-394: "${text}" (any case, padded) while awaiting an answer → DISCARDED, CANCELLED`, async () => {
      const h = makeHarness();
      const { sid, rid } = await toQuestion(h);
      const r = body(await h.manager.handleMessage(sid, msg(`  ${text.toUpperCase()} `)));
      expect(r).toEqual({
        session_id: sid,
        request_id: rid,
        state: 'done',
        messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }],
      });
      expect(h.calls.some((c) => c.kind === 'answer')).toBe(false);
      expect(finals(h)).toEqual(['DISCARDED']);
    });
  }

  it('C-422: "cancel" sent as a text answer through the answers call → DISCARDED, CANCELLED', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    const r = body(await h.manager.handleAnswer(sid, { question_id: q.question_id, text: 'Cancel' }));
    expect(r.messages).toEqual([{ type: 'text', text: REPLY.CANCELLED() }]);
  });

  it('C-422 / C-344: the cancel endpoint while awaiting an answer or a confirmation → DISCARDED, CANCELLED', async () => {
    const h = makeHarness();
    const a = await toQuestion(h);
    expect(body(await h.manager.handleCancel(a.sid, a.rid)).messages).toEqual([
      { type: 'text', text: REPLY.CANCELLED() },
    ]);
    const h2 = makeHarness();
    const c = await toConfirmation(h2);
    expect(body(await h2.manager.handleCancel(c.sid, c.rid))).toMatchObject({ state: 'done' });
    expect(finals(h2)).toEqual(['DISCARDED']);
    expect(h2.calls.some((x) => x.step === 's12')).toBe(false);
  });

  it('SQ-A-01 F-8: cancel with no matching active request -> 200 done "Cancelled. Nothing was sent.", nothing changes, repeatable', async () => {
    const h = makeHarness();
    const sid = await open(h);
    for (let n = 0; n < 2; n++) {
      const r = body(await h.manager.handleCancel(sid, 'req_000000000000'));
      expect(r).toEqual({
        session_id: sid,
        request_id: 'req_000000000000',
        state: 'done',
        messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }],
      });
      expect(r.error).toBeUndefined();
    }
    expect(h.log.lines.some((l) => l.event === 'unsupported_state')).toBe(false);
    const c = await toConfirmation(h);
    expect(body(await h.manager.handleCancel(c.sid, 'req_000000000000'))).toMatchObject({
      state: 'done',
      messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }],
    });
    expect(finals(h)).toEqual([]);
    // the real pending request is still confirmable
    expect(body(await h.manager.handleConfirm(c.sid, c.rid, 'yes')).state).toBe('done');
  });

  it('SQ-A-01 F-8: cancel of an ended (ANSWERED) request -> "Cancelled. Nothing was sent.", request unchanged', async () => {
    const h = makeHarness();
    h.set('s4', { step: async () => ({ kind: 'error', code: 'UNSUPPORTED_REQUEST', final_state: 'ANSWERED' }) });
    const sid = await open(h);
    const first = body(await h.manager.handleMessage(sid, msg('swap my eth for usdc')));
    expect(finals(h)).toEqual(['ANSWERED']);
    const r = body(await h.manager.handleCancel(sid, first.request_id));
    expect(r).toEqual({
      session_id: sid,
      request_id: first.request_id,
      state: 'done',
      messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }],
    });
    expect(finals(h)).toEqual(['ANSWERED']);
    expect(h.log.lines.some((l) => l.event === 'unsupported_state')).toBe(false);
  });

  it('SQ-A-01 F-8: cancel of a DISCARDED request (second cancel) -> same reply, no new final', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleCancel(sid, rid);
    const r = body(await h.manager.handleCancel(sid, rid));
    expect(r.state).toBe('done');
    expect(r.messages).toEqual([{ type: 'text', text: 'Cancelled. Nothing was sent.' }]);
    expect(finals(h)).toEqual(['DISCARDED']);
  });

  it('SQ-A-01 F-8: cancel of a HANDED_OFF request -> "already sent to your wallet" reply, state stays HANDED_OFF', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleConfirm(sid, rid, 'yes');
    expect(finals(h)).toEqual(['HANDED_OFF']);
    const r = body(await h.manager.handleCancel(sid, rid));
    expect(r).toEqual({
      session_id: sid,
      request_id: rid,
      state: 'done',
      messages: [
        { type: 'text', text: "That was already sent to your wallet for signing, so it can't be cancelled here." },
      ],
    });
    expect(finals(h)).toEqual(['HANDED_OFF']);
    expect(h.log.lines.some((l) => l.event === 'unsupported_state')).toBe(false);
  });

  it('C-423: confirm yes → S12 hand-off; HANDED_OFF; reply "Sent to your wallet for signing."', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    const r = body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect(r).toEqual({
      session_id: sid,
      request_id: rid,
      state: 'done',
      messages: [{ type: 'text', text: 'Sent to your wallet for signing.' }],
    });
    expect(stepNames(h.calls)).toEqual([...ALL, 's12']);
    expect(finals(h)).toEqual(['HANDED_OFF']);
    expect(h.contexts.at(-1)?.req.handoff_attempts).toBe(1);
  });

  for (const text of CONFIRM_YES_TEXTS) {
    it(`C-423: text "${text}" while awaiting confirmation → S12`, async () => {
      const h = makeHarness();
      const { sid } = await toConfirmation(h);
      const r = body(await h.manager.handleMessage(sid, msg(` ${text.toUpperCase()} `)));
      expect(r.messages).toEqual([{ type: 'text', text: REPLY.HANDED_OFF() }]);
    });
  }

  it('C-424 / C-303: confirm no → DISCARDED; reply "OK, I\'ve dropped that…"', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    const r = body(await h.manager.handleConfirm(sid, rid, 'no'));
    expect(r.messages).toEqual([{ type: 'text', text: "OK, I've dropped that. Tell me what you'd like instead." }]);
    expect(finals(h)).toEqual(['DISCARDED']);
  });

  for (const text of CONFIRM_NO_TEXTS.filter((t) => t !== 'stop')) {
    it(`C-424: text "${text}" while awaiting confirmation → DISCARDED + "OK, I've dropped that…"`, async () => {
      const h = makeHarness();
      const { sid } = await toConfirmation(h);
      const r = body(await h.manager.handleMessage(sid, msg(text)));
      expect(r.messages).toEqual([{ type: 'text', text: REPLY.USER_SAID_NO() }]);
      expect(h.calls.some((c) => c.step === 's12')).toBe(false);
    });
  }

  it('C-422 / SQ-18: "stop" while awaiting confirmation → the cancel row wins (CANCELLED)', async () => {
    const h = makeHarness();
    const { sid } = await toConfirmation(h);
    expect(body(await h.manager.handleMessage(sid, msg('stop'))).messages).toEqual([
      { type: 'text', text: REPLY.CANCELLED() },
    ]);
  });

  it('C-425 / C-305: a complete new request while awaiting confirmation replaces the pending request', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    const r = body(await h.manager.handleMessage(sid, msg('send 20 usdc to mihir on base')));
    expect(r.request_id).not.toBe(rid);
    expect(r.state).toBe('awaiting_confirmation');
    expect(r.messages).toEqual([
      { type: 'text', text: 'I dropped the previous plan and started on your new request.' },
    ]);
    expect(h.contexts.at(-1)?.req.input?.text).toBe('send 20 usdc to mihir on base');
    expect(finals(h)).toEqual(['DISCARDED']);
    expect((await h.manager.handleConfirm(sid, rid, 'yes')).kind).toBe('conflict');
  });

  it('SQ-CV-02: an edit cannot inherit fields when the stub summary has no validated draft rows', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    const response = body(await h.manager.handleMessage(sid, msg('actually send 20 to mihir')));
    expect(response.request_id).toBe(rid);
    expect(response.state).toBe('awaiting_confirmation');
    expect(response.summary).toEqual(SUMMARY);
    expect(finals(h)).toEqual([]);
    expect(h.calls.some((call) => call.step === 's12')).toBe(false);
  });

  it('C-343: confirm outside AWAITING_CONFIRMATION/HANDOFF_FAILED, or for another request → conflict', async () => {
    const h = makeHarness();
    const sid = await open(h);
    expect((await h.manager.handleConfirm(sid, 'req_000000000000', 'yes')).kind).toBe('conflict');
    const a = await toQuestion(h);
    expect((await h.manager.handleConfirm(a.sid, a.rid, 'yes')).kind).toBe('conflict');
    const h2 = makeHarness();
    const c = await toConfirmation(h2);
    expect((await h2.manager.handleConfirm(c.sid, 'req_000000000000', 'yes')).kind).toBe('conflict');
    await h2.manager.handleConfirm(c.sid, c.rid, 'yes');
    expect((await h2.manager.handleConfirm(c.sid, c.rid, 'yes')).kind).toBe('conflict');
  });

  it('C-427: discarded and cancelled requests keep their DB1 rows but the runner never writes db8_history', async () => {
    const h = makeHarness();
    h.set('s3', {
      step: async (ctx) => {
        ctx.repos.db1.mint({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          amount: '5',
          token: 'USDC',
          source: 'user',
          origin: 'phrase',
          confirmed: true,
        });
        return { kind: 'continue' };
      },
    });
    const c = await toConfirmation(h);
    await h.manager.handleConfirm(c.sid, c.rid, 'no');
    const c2 = body(await h.manager.handleMessage(c.sid, msg('again')));
    await h.manager.handleCancel(c.sid, c2.request_id);
    expect(h.repos.tables.db1.size).toBe(2);
    expect(h.repos.tables.db8_history).toEqual([]);
  });
});

describe('§8.14 step 6 / §17.3 HANDOFF_FAILED', () => {
  function failingHandoff(h: Harness, results: StepResult[]): void {
    h.set('s12', { step: async () => results.shift() ?? { kind: 'continue' } });
  }
  const UNAVAILABLE: StepResult = { kind: 'error', code: 'EXECUTION_UNAVAILABLE' };

  it('C-155 / C-426: EXECUTION_UNAVAILABLE → HANDOFF_FAILED; confirm yes retries S12 on the same request', async () => {
    expect(MAX_HANDOFF_ATTEMPTS).toBe(3);
    const h = makeHarness();
    failingHandoff(h, [UNAVAILABLE]);
    const { sid, rid } = await toConfirmation(h);
    const r1 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect(r1).toMatchObject({
      state: 'error',
      error: { code: 'EXECUTION_UNAVAILABLE', message: "I couldn't reach your wallet. Confirm again to retry." },
    });
    expect(h.log.lines.some((l) => l.event === 'handoff_failed' && l.attempt === 1)).toBe(true);
    expect(finals(h)).toEqual([]);
    const r2 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect(r2.messages).toEqual([{ type: 'text', text: REPLY.HANDED_OFF() }]);
    const s12ctx = h.contexts.filter((_, i) => h.calls.filter((c) => c.kind === 'step')[i]?.step === 's12');
    expect(new Set(s12ctx.map((c) => c.req)).size).toBe(1);
    expect(s12ctx.at(-1)?.req.handoff_attempts).toBe(2);
    expect(finals(h)).toEqual(['HANDED_OFF']);
  });

  it('C-155 / C-426: up to 3 attempts in total; the 3rd failure → FAILED; a 4th confirm → conflict', async () => {
    const h = makeHarness();
    failingHandoff(h, [UNAVAILABLE, UNAVAILABLE, UNAVAILABLE, { kind: 'continue' }]);
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleConfirm(sid, rid, 'yes');
    await h.manager.handleConfirm(sid, rid, 'yes');
    const r3 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect(r3.error?.code).toBe('EXECUTION_UNAVAILABLE');
    expect(finals(h)).toEqual(['FAILED']);
    expect((await h.manager.handleConfirm(sid, rid, 'yes')).kind).toBe('conflict');
    expect(h.calls.filter((c) => c.step === 's12')).toHaveLength(3);
  });

  it('SQ-A-06 F-9: attempts 1-2 show the section 15 text; the 3rd failure shows the text for its cause', async () => {
    const cases: Array<['timeout' | 'server_error', string]> = [
      ['timeout', "I couldn't confirm your wallet received this after 3 tries. Check your wallet before trying again."],
      ['server_error', "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again later."],
    ];
    for (const [cause, final] of cases) {
      const h = makeHarness();
      const fail: StepResult = { kind: 'error', code: 'EXECUTION_UNAVAILABLE', params: { cause } };
      failingHandoff(h, [fail, fail, fail]);
      const { sid, rid } = await toConfirmation(h);
      const r1 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
      const r2 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
      const r3 = body(await h.manager.handleConfirm(sid, rid, 'yes'));
      expect(r1.error?.message).toBe("I couldn't reach your wallet. Confirm again to retry.");
      expect(r2.error?.message).toBe("I couldn't reach your wallet. Confirm again to retry.");
      expect(r3.error).toEqual({ code: 'EXECUTION_UNAVAILABLE', message: final });
      expect(finals(h)).toEqual(['FAILED']);
    }
  });

  it('C-343: in HANDOFF_FAILED only "yes" is accepted by confirm (no → conflict)', async () => {
    const h = makeHarness();
    failingHandoff(h, [UNAVAILABLE]);
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleConfirm(sid, rid, 'yes');
    expect((await h.manager.handleConfirm(sid, rid, 'no')).kind).toBe('conflict');
  });

  it('§8.14 step 5: EXECUTION_REJECTED → FAILED with the execution layer message', async () => {
    const h = makeHarness();
    failingHandoff(h, [{ kind: 'error', code: 'EXECUTION_REJECTED', params: { message: 'nonce too low' } }]);
    const { sid, rid } = await toConfirmation(h);
    const r = body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect(r.error).toEqual({ code: 'EXECUTION_REJECTED', message: "Your wallet couldn't accept this: nonce too low" });
    expect(finals(h)).toEqual(['FAILED']);
    expect((await h.manager.handleConfirm(sid, rid, 'yes')).kind).toBe('conflict');
  });

  it('SQ-A-01 F-8: the cancel endpoint still drops a HANDOFF_FAILED request -> DISCARDED', async () => {
    const h = makeHarness();
    failingHandoff(h, [UNAVAILABLE]);
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleConfirm(sid, rid, 'yes');
    expect(body(await h.manager.handleCancel(sid, rid)).messages).toEqual([{ type: 'text', text: REPLY.CANCELLED() }]);
    expect(finals(h)).toEqual(['DISCARDED']);
  });

  it('SQ-A-03: a message while HANDOFF_FAILED — cancel text cancels; other text → UNSUPPORTED_REQUEST, still retryable', async () => {
    const h = makeHarness();
    failingHandoff(h, [UNAVAILABLE]);
    const { sid, rid } = await toConfirmation(h);
    await h.manager.handleConfirm(sid, rid, 'yes');
    const r = body(await h.manager.handleMessage(sid, msg('yes')));
    expect(r).toMatchObject({ request_id: rid, state: 'error', error: { code: 'UNSUPPORTED_REQUEST' } });
    expect(h.log.lines.some((l) => l.rule_id === 'handoff_failed:message')).toBe(true);
    expect(body(await h.manager.handleConfirm(sid, rid, 'yes')).messages).toEqual([
      { type: 'text', text: REPLY.HANDED_OFF() },
    ]);

    const h2 = makeHarness();
    failingHandoff(h2, [UNAVAILABLE]);
    const c = await toConfirmation(h2);
    await h2.manager.handleConfirm(c.sid, c.rid, 'yes');
    expect(body(await h2.manager.handleMessage(c.sid, msg('never mind'))).messages).toEqual([
      { type: 'text', text: REPLY.CANCELLED() },
    ]);
  });
});

describe('§14.1 one call per session at a time', () => {
  it('C-348: a second concurrent call for the same session → conflict', async () => {
    const h = makeHarness();
    const sid = await open(h);
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const inS4 = new Promise<void>((r) => {
      started = r;
    });
    h.set('s4', {
      step: () =>
        new Promise<StepResult>((resolve) => {
          release = () => resolve({ kind: 'continue' });
          started();
        }),
    });
    const first = h.manager.handleMessage(sid, msg('x'));
    await inS4;
    expect((await h.manager.handleMessage(sid, msg('y'))).kind).toBe('conflict');
    expect((await h.manager.handleCancel(sid, 'req_000000000000')).kind).toBe('conflict');
    release();
    expect(body(await first).state).toBe('awaiting_confirmation');
    // free again afterwards
    h.set('s4', { step: async () => ({ kind: 'continue' }) });
    expect((await h.manager.handleMessage(sid, msg('z'))).kind).toBe('ok');
  });
});

describe('§18 metrics in logs', () => {
  it('C-431: final states, question codes and hand-off failures are logged as events; only allowlisted fields', async () => {
    const h = makeHarness();
    const q = question('Q_WHO_IS');
    h.set('s6', { step: async () => ({ kind: 'question', question: q }) });
    const sid = await open(h);
    await h.manager.handleMessage(sid, msg('pay bob 5'));
    await h.manager.handleMessage(sid, msg('cancel'));
    expect(h.log.lines.find((l) => l.event === 'question')).toMatchObject({
      question_code: 'Q_WHO_IS',
      attempt: 1,
      step: 's6',
    });
    expect(finals(h)).toEqual(['DISCARDED']);
    for (const line of h.log.lines) {
      for (const k of Object.keys(line)) expect(LOG_ALLOWED_FIELDS, k).toContain(k);
    }
    expect(JSON.stringify(h.log.lines)).not.toContain('bob');
  });
});
