// Lane A unit tests (gap fill for session.test.ts): every StepResult kind from an AnswerHandler, step_state across
// re-entry, §9.7 TOO_MANY_RETRIES sequence, §8.14 step 6 hand-off attempts, the whole §17.3 word table, §13.3
// literal texts, §17.2 history, §7.4 / §16.4 session clearing on a real SQLCipher DB.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE, REPLY } from '../../../src/contracts/catalog.js';
import type { StepResult } from '../../../src/contracts/step.js';
import type { Address, AgentResponse, HandoffEnvelope, Question } from '../../../src/contracts/types.js';
import { CANCEL_TEXTS, CONFIRM_NO_TEXTS, CONFIRM_YES_TEXTS } from '../../../src/contracts/static-tables.js';
import type { SessionResult } from '../../../src/session/manager.js';
import { createLogger } from '../../../src/util/logger.js';
import { openTempDb } from './helpers.js';
import { SUMMARY, makeHarness, msg, question, stepNames, type Harness } from './session-harness.js';

const A1 = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E' as Address;

function body(r: SessionResult): AgentResponse {
  if (r.kind !== 'ok') throw new Error(`expected ok, got ${r.kind}`);
  return r.body;
}
const open = (h: Pick<Harness, 'manager'>): string => h.manager.openSession('Asia/Kolkata').session_id;
const finals = (h: Harness): string[] =>
  h.log.lines.filter((l) => l.event === 'request_final').map((l) => l.state ?? '');
const text = (s: string): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: s }];

async function toConfirmation(h: Harness): Promise<{ sid: string; rid: string }> {
  const sid = open(h);
  const r = body(await h.manager.handleMessage(sid, msg('send 50 usdc to aradhya')));
  expect(r.state).toBe('awaiting_confirmation');
  return { sid, rid: r.request_id };
}

/** Pauses `step` (default S3) on a question the first time it runs; re-entry continues. */
async function toQuestion(
  h: Harness,
  q: Question = question(),
  stepName: 's3' | 's11' = 's3',
): Promise<{ sid: string; rid: string; q: Question }> {
  let asked = false;
  h.set(stepName, {
    step: async () => {
      if (asked) return stepName === 's11' ? { kind: 'summary', summary: SUMMARY } : { kind: 'continue' };
      asked = true;
      return { kind: 'question', question: q };
    },
  });
  const sid = open(h);
  const r = body(await h.manager.handleMessage(sid, msg('send 50 to aradhya')));
  expect(r.state).toBe('awaiting_answer');
  return { sid, rid: r.request_id, q };
}

const answerText = (h: Harness, sid: string, q: Question): Promise<SessionResult> =>
  h.manager.handleAnswer(sid, { question_id: q.question_id, text: 'x' });

describe('StepResult kinds returned by an AnswerHandler', () => {
  it('§3.3 answer: request ANSWERED, state done, messages returned', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    h.set('s3', { onAnswer: async () => ({ kind: 'answer', messages: ['Your balance is 5 USDC.'] }) });
    const r = body(await answerText(h, sid, q));
    expect(r).toMatchObject({ state: 'done', messages: text('Your balance is 5 USDC.') });
    expect(finals(h)).toEqual(['ANSWERED']);
  });

  it('§3.3 error: request FAILED with the catalog message; final_state ANSWERED honoured', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    h.set('s3', { onAnswer: async () => ({ kind: 'error', code: 'INTERNAL_ERROR' }) });
    const r = body(await answerText(h, sid, q));
    expect(r.error).toEqual({ code: 'INTERNAL_ERROR', message: ERROR_MESSAGE.INTERNAL_ERROR({}) });
    expect(finals(h)).toEqual(['FAILED']);

    const h2 = makeHarness();
    const b = await toQuestion(h2);
    h2.set('s3', { onAnswer: async () => ({ kind: 'error', code: 'INTERNAL_ERROR', final_state: 'ANSWERED' }) });
    await answerText(h2, b.sid, b.q);
    expect(finals(h2)).toEqual(['ANSWERED']);
  });

  it('§3.3 discard: request DISCARDED; the handler messages, or CANCELLED by default', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    h.set('s3', { onAnswer: async () => ({ kind: 'discard', messages: ['custom'] }) });
    expect(body(await answerText(h, sid, q)).messages).toEqual(text('custom'));
    expect(finals(h)).toEqual(['DISCARDED']);
  });

  it('§3.3 question with another code: pauses again on the same step, the new id is the one accepted', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h, question('Q_TOKEN'));
    const next = question('Q_WHO_IS');
    h.set('s3', { onAnswer: async () => ({ kind: 'question', question: next }) });
    const r = body(await answerText(h, sid, q));
    expect(r.state).toBe('awaiting_answer');
    expect(r.question?.question_id).toBe(next.question_id);
    expect((await answerText(h, sid, q)).kind).toBe('conflict');
  });

  it('§3.3 summary from an AnswerHandler of S11: request AWAITING_CONFIRMATION with the summary', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h, question('Q_ENS_CHANGED'), 's11');
    h.set('s11', { onAnswer: async () => ({ kind: 'summary', summary: SUMMARY }) });
    const r = body(await answerText(h, sid, q));
    expect(r.state).toBe('awaiting_confirmation');
    expect(r.summary).toEqual(SUMMARY);
  });

  it('§0 / SQ-19 summary from an AnswerHandler of any other step: UNSUPPORTED_REQUEST', async () => {
    const h = makeHarness();
    const { sid, q } = await toQuestion(h);
    h.set('s3', { onAnswer: async () => ({ kind: 'summary', summary: SUMMARY }) });
    const r = body(await answerText(h, sid, q));
    expect(r.state).toBe('error');
    expect(r.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(h.log.lines.some((l) => l.event === 'unsupported_state')).toBe(true);
  });

  it('§3.3 continue: re-enters the SAME step, then proceeds to the next steps; S0–S2 are not rerun; step_state survives', async () => {
    const h = makeHarness();
    const seen: unknown[] = [];
    let runs = 0;
    const q = question();
    h.set('s3', {
      step: async (ctx) => {
        runs++;
        seen.push({ ...ctx.req.step_state });
        if (runs === 1) {
          (ctx.req.step_state as Record<string, unknown>).progress = 'half';
          return { kind: 'question', question: q };
        }
        return { kind: 'continue' };
      },
      onAnswer: async (ctx) => {
        (ctx.req.step_state as Record<string, unknown>).answered = true;
        return { kind: 'continue' };
      },
    });
    const sid = open(h);
    await h.manager.handleMessage(sid, msg('send'));
    const r = body(await answerText(h, sid, q));
    expect(seen).toEqual([{}, { progress: 'half', answered: true }]);
    expect(r.state).toBe('awaiting_confirmation');
    const names = stepNames(h.calls);
    expect(names.filter((n) => n === 's0' || n === 's1' || n === 's2')).toEqual(['s0', 's1', 's2']);
    expect(names.indexOf('s4')).toBeGreaterThan(names.lastIndexOf('s3'));
  });
});

describe('§9.7 TOO_MANY_RETRIES', () => {
  const rising = (h: Harness): void =>
    h.set('s3', {
      onAnswer: async (_c, q) => ({ kind: 'question', question: { ...question(q.code), attempt: q.attempt + 1 } }),
    });

  for (const via of ['answers', 'messages'] as const) {
    it(`C-201 / C-389 / C-420: via ${via}: attempts 1–4 are asked, the handler's attempt 5 ends FAILED, no question returned, a later message starts a new request`, async () => {
      const h = makeHarness();
      let current = question('Q_AMOUNT_MISSING', 1);
      const { sid, rid } = await toQuestion(h, current);
      rising(h);
      const send = (): Promise<SessionResult> =>
        via === 'answers'
          ? h.manager.handleAnswer(sid, { question_id: current.question_id, text: 'zero' })
          : h.manager.handleMessage(sid, msg('zero'));
      const asked: number[] = [current.attempt];
      for (let i = 0; i < 3; i++) {
        const r = body(await send());
        expect(r.state).toBe('awaiting_answer');
        current = r.question as Question;
        asked.push(current.attempt);
      }
      expect(asked).toEqual([1, 2, 3, 4]);
      const last = body(await send());
      expect(last.state).toBe('error');
      expect(last.error).toEqual({ code: 'TOO_MANY_RETRIES', message: ERROR_MESSAGE.TOO_MANY_RETRIES({}) });
      expect(last.question).toBeUndefined();
      expect(finals(h)).toEqual(['FAILED']);
      h.set('s3', { step: async () => ({ kind: 'continue' }) });
      const next = body(await h.manager.handleMessage(sid, msg('send 5 to bob')));
      expect(next.request_id).not.toBe(rid);
      expect(next.state).toBe('awaiting_confirmation');
    });
  }
});

describe('§8.14 step 6 HANDOFF_FAILED attempts', () => {
  const UNAVAILABLE: StepResult = { kind: 'error', code: 'EXECUTION_UNAVAILABLE' };

  it('C-155 / C-426: attempts 1 and 2 → HANDOFF_FAILED, attempt 3 → FAILED; S12 called exactly 3 times on the same request and envelope', async () => {
    const h = makeHarness();
    const envelope: HandoffEnvelope = {
      version: '1',
      request_id: 'req_x',
      wallet_address: A1,
      created_at: '2026-11-05T17:30:00.000Z',
      intents: [],
    };
    const seen: Array<{ obj: unknown; rid: string; attempts: number; env: unknown }> = [];
    h.set('s12', {
      step: async (ctx) => {
        ctx.req.envelope ??= envelope;
        seen.push({ obj: ctx.req, rid: ctx.req.request_id, attempts: ctx.req.handoff_attempts, env: ctx.req.envelope });
        return UNAVAILABLE;
      },
    });
    const { sid, rid } = await toConfirmation(h);
    const confirm = async (): Promise<AgentResponse> => body(await h.manager.handleConfirm(sid, rid, 'yes'));
    expect((await confirm()).error?.code).toBe('EXECUTION_UNAVAILABLE');
    expect(finals(h)).toEqual([]);
    expect((await confirm()).error?.code).toBe('EXECUTION_UNAVAILABLE');
    expect(finals(h)).toEqual([]);
    expect((await confirm()).error?.code).toBe('EXECUTION_UNAVAILABLE');
    expect(finals(h)).toEqual(['FAILED']);
    expect(seen).toHaveLength(3);
    expect(seen.map((x) => x.attempts)).toEqual([1, 2, 3]);
    expect(new Set(seen.map((x) => x.obj)).size).toBe(1);
    expect(new Set(seen.map((x) => x.rid))).toEqual(new Set([rid]));
    expect(new Set(seen.map((x) => x.env))).toEqual(new Set([envelope]));
    expect((await h.manager.handleConfirm(sid, rid, 'yes')).kind).toBe('conflict');
    expect(h.calls.filter((c) => c.step === 's12')).toHaveLength(3);
  });
});

describe('§17.3 word table (mixed case, padded)', () => {
  const mixed = (w: string): string => `  ${[...w].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c)).join('')}\t `;

  it('C-422 §17.3: the lists are exactly the spec words', () => {
    expect(CANCEL_TEXTS).toEqual(['cancel', 'stop', 'abort', 'never mind', 'nevermind', 'forget it']);
    for (const w of ['yes', 'y', 'confirm', 'go ahead', 'ok', 'okay', 'do it', 'send it']) {
      expect(CONFIRM_YES_TEXTS).toContain(w);
    }
    for (const w of ['no', 'n', "don't", 'dont']) expect(CONFIRM_NO_TEXTS).toContain(w);
  });

  for (const w of CANCEL_TEXTS) {
    it(`C-422: "${w}" while awaiting an answer → CANCELLED`, async () => {
      const h = makeHarness();
      const { sid } = await toQuestion(h);
      expect(body(await h.manager.handleMessage(sid, msg(mixed(w)))).messages).toEqual(text(REPLY.CANCELLED()));
    });
    it(`C-422: "${w}" while awaiting confirmation → CANCELLED (no S12)`, async () => {
      const h = makeHarness();
      const { sid } = await toConfirmation(h);
      expect(body(await h.manager.handleMessage(sid, msg(mixed(w)))).messages).toEqual(text(REPLY.CANCELLED()));
      expect(h.calls.some((c) => c.step === 's12')).toBe(false);
      expect(finals(h)).toEqual(['DISCARDED']);
    });
  }

  for (const w of CONFIRM_YES_TEXTS) {
    it(`C-423: "${w}" (mixed case, padded) while awaiting confirmation → hand-off`, async () => {
      const h = makeHarness();
      const { sid } = await toConfirmation(h);
      expect(body(await h.manager.handleMessage(sid, msg(mixed(w)))).messages).toEqual(text(REPLY.HANDED_OFF()));
    });
  }

  for (const w of CONFIRM_NO_TEXTS.filter((x) => x !== 'stop')) {
    it(`C-424: "${w}" (mixed case, padded) while awaiting confirmation → dropped`, async () => {
      const h = makeHarness();
      const { sid } = await toConfirmation(h);
      expect(body(await h.manager.handleMessage(sid, msg(mixed(w)))).messages).toEqual(text(REPLY.USER_SAID_NO()));
    });
  }

  it('C-422 / SQ-18: "stop" is in both lists; CANCELLED wins', async () => {
    const h = makeHarness();
    const { sid } = await toConfirmation(h);
    expect(body(await h.manager.handleMessage(sid, msg(' STOP '))).messages).toEqual(text(REPLY.CANCELLED()));
  });

  for (const other of ['yes please', 'ok thanks', 'nope', 'cancel it', 'send 20 to mihir', '']) {
    it(`C-425: "${other}" while awaiting confirmation → previous DISCARDED, new request, PENDING_REPLACED first`, async () => {
      const h = makeHarness();
      const { sid, rid } = await toConfirmation(h);
      const r = body(await h.manager.handleMessage(sid, msg(other)));
      expect(r.request_id).not.toBe(rid);
      expect(r.messages[0]).toEqual({ type: 'text', text: REPLY.PENDING_REPLACED() });
      expect(finals(h)[0]).toBe('DISCARDED');
      expect(h.calls.some((c) => c.step === 's12')).toBe(false);
    });
  }
});

describe('§13.3 fixed replies', () => {
  it('C-303 / C-304 / C-305: the literal texts', () => {
    expect(REPLY.USER_SAID_NO()).toBe("OK, I've dropped that. Tell me what you'd like instead.");
    expect(REPLY.CANCELLED()).toBe('Cancelled. Nothing was sent.');
    expect(REPLY.PENDING_REPLACED()).toBe('I dropped the previous plan and started on your new request.');
    expect(REPLY.HANDED_OFF()).toBe('Sent to your wallet for signing.');
  });

  it('C-304: cancel via the cancel endpoint replies exactly "Cancelled. Nothing was sent."', async () => {
    const h = makeHarness();
    const { sid, rid } = await toConfirmation(h);
    expect(body(await h.manager.handleCancel(sid, rid)).messages).toEqual(text('Cancelled. Nothing was sent.'));
  });
});

describe('§7.4 / §17.2 / §16.4 on a real SQLCipher DB', () => {
  it('C-427: a discarded or cancelled request keeps its DB1 and DB3 rows and db8_history stays empty; a handed-off request shows in recentHistory', async () => {
    const t = openTempDb();
    t.repos.db5.insertDefaultsIfMissing('t');
    const h = makeHarness({ repos: t.repos });
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
        ctx.repos.db3.mint({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          ens_name: null,
          chain_id: null,
          group_placeholder: null,
          source: 'contact',
          kind: 'single',
          name: 'Mihir',
          address: A1,
        });
        return { kind: 'continue' };
      },
    });
    h.set('s12', {
      step: async (ctx) => {
        ctx.repos.db8.appendHistory({
          session_id: ctx.req.session_id,
          request_id: ctx.req.request_id,
          payments_json: '[{"recipient":"address_aaaaaaaa"}]',
          handed_off_at: '2026-11-05T17:31:00.000Z',
        });
        return { kind: 'continue' };
      },
    });
    const n = (table: string): number => (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
    const sid = open(h);
    const a = body(await h.manager.handleMessage(sid, msg('one')));
    await h.manager.handleConfirm(sid, a.request_id, 'no');
    const b = body(await h.manager.handleMessage(sid, msg('two')));
    await h.manager.handleCancel(sid, b.request_id);
    expect(n('db1_amount_placeholders')).toBe(2);
    expect(n('db3_address_placeholders')).toBe(2);
    expect(n('db8_history')).toBe(0);
    const c = body(await h.manager.handleMessage(sid, msg('three')));
    await h.manager.handleConfirm(sid, c.request_id, 'yes');
    expect(t.repos.db8.recentHistory(sid, 5).map((r) => r.request_id)).toEqual([c.request_id]);
  });

  it('C-412 §17.2: recentHistory(session, 5) returns the last 5 of 7 rows, most recent first, only for that session', () => {
    const t = openTempDb();
    for (const id of ['ses_aaaaaaaaaaaa', 'ses_bbbbbbbbbbbb']) {
      t.repos.db8.insertSession({ session_id: id, timezone: 'UTC', opened_at: 't' });
    }
    for (let i = 1; i <= 7; i++) {
      t.repos.db8.appendHistory({
        session_id: 'ses_aaaaaaaaaaaa',
        request_id: `req_00000000000${i}`,
        payments_json: '[]',
        handed_off_at: `2026-11-05T10:0${i}:00.000Z`,
      });
      if (i === 4) {
        t.repos.db8.appendHistory({
          session_id: 'ses_bbbbbbbbbbbb',
          request_id: 'req_0000000000bb',
          payments_json: '[]',
          handed_off_at: '2026-11-05T10:04:30.000Z',
        });
      }
    }
    expect(t.repos.db8.recentHistory('ses_aaaaaaaaaaaa', 5).map((r) => r.request_id)).toEqual([
      'req_000000000007',
      'req_000000000006',
      'req_000000000005',
      'req_000000000004',
      'req_000000000003',
    ]);
    expect(t.repos.db8.recentHistory('ses_bbbbbbbbbbbb', 5).map((r) => r.request_id)).toEqual(['req_0000000000bb']);
  });

  const SESSION_TABLES = [
    'db1_amount_placeholders',
    'db3_address_placeholders',
    'db8_prompts',
    'db8_history',
    'db8_sessions',
  ];
  const KEPT_TABLES = ['db2_address_book', 'db4_balances', 'db5_limits', 'db6_spend_log', 'db7_autopays'];

  function seedEverything(t: ReturnType<typeof openTempDb>, sid: string, rid: string): void {
    const r = t.repos;
    r.db5.insertDefaultsIfMissing('t');
    r.db1.mint({
      session_id: sid,
      request_id: rid,
      amount: '5',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
    r.db3.mint({
      session_id: sid,
      request_id: rid,
      ens_name: null,
      chain_id: null,
      group_placeholder: null,
      source: 'contact',
      kind: 'single',
      name: 'Mihir',
      address: A1,
    });
    r.db8.insertPrompt({ session_id: sid, request_id: rid, kind: 'typed', text: 'hello', created_at: 't' });
    r.db8.appendHistory({ session_id: sid, request_id: rid, payments_json: '[]', handed_off_at: 't' });
    r.db2.addContact({ name: 'Mihir', address: A1, chain_ids: [84532], ens_name: null });
    r.db4.upsertOk({ chain_id: 84532, chain: 'Base Sepolia', token: 'USDC', balance: '1', base_units: '1000000' }, 't');
    r.db6.insertMany([
      {
        request_id: rid,
        step: 0,
        kind: 'payment',
        counts_toward_limit: true,
        chain_id: 84532,
        token: 'USDC',
        amount: '5',
        recipient_address: A1,
        intent_id: 'i',
        autopay_id: null,
        status: 'pending',
        tx_hash: null,
        created_at: 't',
        executed_at: null,
      },
    ]);
    r.db7.insertPending(
      {
        autopay_id: 'ap_00000000000a',
        request_id: rid,
        recipient_name: 'Mihir',
        recipient_address: A1,
        chain_id: 84532,
        token: 'USDC',
        amount_per_payment: '5',
        schedule_json: '{}',
      },
      't',
    );
  }

  it('C-411 / C-048 / C-408: close empties DB1, DB3, db8_prompts, db8_history, db8_sessions and leaves DB2, DB4–DB7 identical; secure_delete is 1 and VACUUM ran', async () => {
    const t = openTempDb();
    const h = makeHarness({ repos: t.repos });
    const sid = open(h);
    seedEverything(t, sid, 'req_000000000001');
    const count = (table: string): number => (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
    const snap = (table: string): unknown => t.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all();
    for (const table of SESSION_TABLES) expect(count(table), table).toBeGreaterThan(0);
    const before = KEPT_TABLES.map(snap);
    const vacuums: unknown[] = [];
    const originalExec = t.db.exec.bind(t.db);
    t.db.exec = ((sql: string) => {
      if (/^\s*VACUUM/i.test(sql)) vacuums.push(t.db.pragma('secure_delete', { simple: true }));
      return originalExec(sql);
    }) as typeof t.db.exec;
    expect(h.manager.closeSession(sid)).toBe(true);
    for (const table of SESSION_TABLES) expect(count(table), table).toBe(0);
    expect(KEPT_TABLES.map(snap)).toEqual(before);
    expect(vacuums).toEqual([1]);
  });

  it('C-411: a row of a crashed earlier session is cleared too when that session id is closed', () => {
    const t = openTempDb();
    const h = makeHarness({ repos: t.repos });
    t.repos.db8.insertSession({ session_id: 'ses_cccccccccccc', timezone: 'UTC', opened_at: 't' });
    seedEverything(t, 'ses_cccccccccccc', 'req_00000000000c');
    expect(h.manager.closeSession('ses_cccccccccccc')).toBe(true);
    for (const table of SESSION_TABLES) {
      expect((t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n, table).toBe(0);
    }
    expect((t.db.prepare('SELECT count(*) n FROM db6_spend_log').get() as { n: number }).n).toBe(1);
    expect(h.manager.closeSession('ses_cccccccccccc')).toBe(false);
  });
});

describe('SQ-A-05 / C-340 closing a leftover session id', () => {
  const count = (t: ReturnType<typeof openTempDb>, table: string): number =>
    (t.db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;

  it('SQ-A-05 / C-340 §7.4: with a session open, another id in db8_sessions → false, nothing cleared, the open session still works; closing it wipes the leftover too', async () => {
    const t = openTempDb();
    t.repos.db5.insertDefaultsIfMissing('t');
    const h = makeHarness({ repos: t.repos });
    const sid = open(h);
    const a = body(await h.manager.handleMessage(sid, msg('hello')));
    t.repos.db1.mint({
      session_id: sid,
      request_id: a.request_id,
      amount: '5',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
    t.repos.db8.insertSession({ session_id: 'ses_dddddddddddd', timezone: 'UTC', opened_at: 't' });
    t.repos.db8.insertPrompt({
      session_id: 'ses_dddddddddddd',
      request_id: 'req_0000000000dd',
      kind: 'typed',
      text: 'old',
      created_at: 't',
    });
    const before = [count(t, 'db1_amount_placeholders'), count(t, 'db8_sessions'), count(t, 'db8_prompts')];

    expect(h.manager.closeSession('ses_dddddddddddd')).toBe(false);
    expect([count(t, 'db1_amount_placeholders'), count(t, 'db8_sessions'), count(t, 'db8_prompts')]).toEqual(before);
    expect(t.repos.db8.getSession('ses_dddddddddddd')).toBeDefined();
    expect(t.repos.db8.getSession(sid)).toBeDefined();
    expect(body(await h.manager.handleMessage(sid, msg('still here'))).state).toBe('awaiting_confirmation');

    expect(h.manager.closeSession(sid)).toBe(true);
    expect(count(t, 'db8_sessions')).toBe(0);
    expect(count(t, 'db8_prompts')).toBe(0);
    expect(count(t, 'db1_amount_placeholders')).toBe(0);
  });

  it('SQ-A-05 / C-340: with no session open, a leftover id still clears and returns true', () => {
    const t = openTempDb();
    const h = makeHarness({ repos: t.repos });
    t.repos.db8.insertSession({ session_id: 'ses_dddddddddddd', timezone: 'UTC', opened_at: 't' });
    expect(h.manager.closeSession('ses_dddddddddddd')).toBe(true);
    expect(count(t, 'db8_sessions')).toBe(0);
  });
});

describe('SQ-A-01 F-8 / §18 cancel with nothing to cancel', () => {
  it('SQ-A-01 F-8: no active request -> done reply and no unsupported_state log line', async () => {
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (c: string) => chunks.push(c) } });
    const h = makeHarness({ log });
    const sid = open(h);
    const r = body(await h.manager.handleCancel(sid, 'req_000000000000'));
    expect(r.state).toBe('done');
    expect(chunks.join('')).not.toContain('unsupported_state');
  });

  it('SQ-A-01 F-8: a wrong request_id while another request is active -> done reply, no log line, request unchanged', async () => {
    const chunks: string[] = [];
    const log = createLogger({ destination: { write: (c: string) => chunks.push(c) } });
    const h = makeHarness({ log });
    const { sid, rid } = await toConfirmation(h);
    const r = body(await h.manager.handleCancel(sid, 'req_000000000000'));
    expect(r.messages).toEqual(text('Cancelled. Nothing was sent.'));
    expect(chunks.join('')).not.toContain('unsupported_state');
    expect(body(await h.manager.handleConfirm(sid, rid, 'yes')).state).toBe('done');
  });
});
