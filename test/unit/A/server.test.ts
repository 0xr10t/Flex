// Lane A unit tests: §14.1 HTTP API over Fastify `inject` (auth on every route, body limits and validation,
// AgentResponse, session/message/answer/confirm/cancel routes, 404/409 rules, health), §16.4 token separation,
// §18 no URL/body in logs. No socket is opened.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CHIPS, ERROR_MESSAGE, REPLY } from '../../../src/contracts/catalog.js';
import { LOG_ALLOWED_FIELDS } from '../../../src/contracts/io.js';
import type { StepResult } from '../../../src/contracts/step.js';
import type { AgentRequest } from '../../../src/contracts/types.js';
import { createApp, MAX_BODY_BYTES } from '../../../src/server/app.js';
import { isBase64 } from '../../../src/server/bodies.js';
import { testConfig } from '../../fakes/context.js';
import { REPORT_TOKEN, UI_TOKEN, makeServer, type ServerHarness } from './server-harness.js';
import { question } from './session-harness.js';

const STUB_REGISTRY_ROUTES: Array<['GET' | 'POST' | 'PUT' | 'DELETE', string]> = [
  ['POST', '/v1/sessions'],
  ['DELETE', '/v1/sessions/ses_000000000000'],
  ['POST', '/v1/sessions/ses_000000000000/messages'],
  ['POST', '/v1/sessions/ses_000000000000/answers'],
  ['POST', '/v1/sessions/ses_000000000000/confirm'],
  ['POST', '/v1/sessions/ses_000000000000/cancel'],
  ['GET', '/v1/settings/limits'],
  ['PUT', '/v1/settings/limits'],
  ['GET', '/v1/health'],
];
const REPORTS = '/v1/execution/reports';

let s: ServerHarness;
beforeEach(() => {
  s = makeServer();
});

describe('§14.1 / §16.4 bearer tokens', () => {
  for (const [method, url] of STUB_REGISTRY_ROUTES) {
    it(`C-336 §14.1: ${method} ${url} needs the UI token (none / wrong / non-Bearer / report token → 401)`, async () => {
      expect((await s.call(method, url, { token: null })).status).toBe(401);
      expect((await s.call(method, url, { token: 'x'.repeat(UI_TOKEN.length) })).status).toBe(401);
      expect((await s.call(method, url, { token: UI_TOKEN, scheme: 'Basic' })).status).toBe(401);
      expect((await s.call(method, url, { token: REPORT_TOKEN })).status).toBe(401);
      expect((await s.call(method, url, { token: UI_TOKEN })).status).not.toBe(401);
    });
  }

  it('C-336: the reports route needs the report token (none / wrong / non-Bearer → 401)', async () => {
    expect((await s.call('POST', REPORTS, { token: null })).status).toBe(401);
    expect((await s.call('POST', REPORTS, { token: 'y'.repeat(REPORT_TOKEN.length) })).status).toBe(401);
    expect((await s.call('POST', REPORTS, { token: REPORT_TOKEN, scheme: 'Token' })).status).toBe(401);
    expect((await s.call('POST', REPORTS, { token: REPORT_TOKEN })).status).not.toBe(401);
  });

  it('C-336: an unknown path also needs a token (401 without, 404 with)', async () => {
    expect((await s.call('GET', '/v1/nothing', { token: null })).status).toBe(401);
    expect((await s.call('GET', '/v1/nothing')).status).toBe(404);
  });

  it('C-350 §16.4: the reports route refuses the UI token and takes the report token', async () => {
    const body = { kind: 'intent_result', request_id: 'req_ffffffffffff', step: 0, status: 'failed' };
    expect((await s.call('POST', REPORTS, { token: UI_TOKEN, body })).status).toBe(401);
    expect((await s.call('POST', REPORTS, { token: REPORT_TOKEN, body })).status).toBe(404);
  });

  it('C-407 §16.4: createApp throws when the UI and report tokens are equal', () => {
    expect(() =>
      createApp({
        repos: s.repos,
        llm: s.llm,
        rpc: {} as never,
        ens: {} as never,
        subnames: {} as never,
        exec: {} as never,
        fetcher: {} as never,
        log: s.log,
        config: testConfig(),
        registry: {} as never,
        tokens: { ui: UI_TOKEN, report: UI_TOKEN },
      }),
    ).toThrow();
  });
});

describe('§14.1 bodies', () => {
  it('C-337: a body over 20 MB → 413 (just over MAX_BODY_BYTES)', async () => {
    expect(MAX_BODY_BYTES).toBe(20 * 1024 * 1024);
    const sid = await s.openSession();
    const raw = `{"text":"${'a'.repeat(MAX_BODY_BYTES)}"}`;
    const r = await s.call('POST', `/v1/sessions/${sid}/messages`, { raw });
    expect(r.status).toBe(413);
    expect(r.text).not.toContain('aaaa');
  });

  it('C-337: malformed JSON → 400 and no error text or body is echoed', async () => {
    const r = await s.call('POST', '/v1/sessions', { raw: '{"timezone": "Secret-Zone-Marker' });
    expect(r.status).toBe(400);
    expect(r.text).not.toContain('Secret-Zone-Marker');
    expect(Object.keys(r.json).sort()).toEqual(['error', 'statusCode']);
  });

  it('C-337: base64 attachments are accepted; a non-base64 attachment → 400', async () => {
    const sid = await s.openSession();
    const att = (base64: string): unknown => ({
      text: 'hi',
      attachments: [{ filename: 'a.png', mime: 'image/png', base64 }],
    });
    const good = await s.call('POST', `/v1/sessions/${sid}/messages`, {
      body: att(Buffer.from('hello bytes').toString('base64')),
    });
    expect(good.status).toBe(200);
    const bad = await s.call('POST', `/v1/sessions/${sid}/messages`, { body: att('not base64!!*') });
    expect(bad.status).toBe(400);
  });
});

describe('SQ-A-08 / C-337 base64 attachments', () => {
  const attach = (base64: string): unknown => ({
    text: 'hi',
    attachments: [{ filename: 'a.bin', mime: 'x/y', base64 }],
  });

  for (const bad of ['=', 'A', 'AB=', 'A===', 'AAA=A', 'aGVs\nbG8=', 'aGVsbG8=\r\n', 'aGk= ', 'a-k=']) {
    it(`C-337 SQ-A-08: ${JSON.stringify(bad)} → 400`, async () => {
      expect(isBase64(bad)).toBe(false);
      const sid = await s.openSession();
      expect((await s.call('POST', `/v1/sessions/${sid}/messages`, { body: attach(bad) })).status).toBe(400);
    });
  }

  for (const good of ['', 'aGk=', 'aGVsbG8=']) {
    it(`C-337 SQ-A-08: ${JSON.stringify(good)} → accepted`, async () => {
      expect(isBase64(good)).toBe(true);
      const sid = await s.openSession();
      expect((await s.call('POST', `/v1/sessions/${sid}/messages`, { body: attach(good) })).status).toBe(200);
    });
  }

  it('C-337 SQ-A-08: a real upload of about 15 MB of base64 (under the 20 MB limit) answers 200', async () => {
    const sid = await s.openSession();
    const b64 = Buffer.alloc(11 * 1024 * 1024, 7).toString('base64');
    expect(b64.length).toBeGreaterThan(14 * 1024 * 1024);
    expect(b64.length + 200).toBeLessThan(MAX_BODY_BYTES);
    const r = await s.call('POST', `/v1/sessions/${sid}/messages`, { body: attach(b64) });
    expect(r.status).toBe(200);
  });
});

describe('§14.1 AgentResponse over HTTP', () => {
  it('C-338: awaiting_confirmation → HTTP 200 with the AgentResponse shape', async () => {
    const sid = await s.openSession();
    const r = await s.message(sid);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ session_id: sid, state: 'awaiting_confirmation' });
    expect(r.body.request_id).toMatch(/^req_[0-9a-f]{12}$/);
    expect(r.body.summary?.text).toBe('Send 50 USDC');
    expect(Array.isArray(r.body.messages)).toBe(true);
  });

  it('C-338: awaiting_answer → HTTP 200 carrying the question', async () => {
    const q = question();
    s.set('s3', { step: async () => ({ kind: 'question', question: q }) });
    const sid = await s.openSession();
    const r = await s.message(sid);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('awaiting_answer');
    expect(r.body.question?.question_id).toBe(q.question_id);
  });

  it('C-338: done → HTTP 200 with the messages', async () => {
    s.set('s4', { step: async () => ({ kind: 'answer', messages: ['Your balance is 5 USDC.'] }) });
    const sid = await s.openSession();
    const r = await s.message(sid);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('done');
    expect(r.body.messages).toEqual([{ type: 'text', text: 'Your balance is 5 USDC.' }]);
  });

  it('C-338: error → HTTP 200 with error.code and error.message; internal text is never echoed', async () => {
    s.set('s5', {
      step: async () => {
        throw new Error('secret internal detail 0xdeadbeef');
      },
    });
    const sid = await s.openSession();
    const r = await s.message(sid);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('error');
    expect(r.body.error).toEqual({ code: 'INTERNAL_ERROR', message: ERROR_MESSAGE.INTERNAL_ERROR({}) });
    expect(JSON.stringify(r.body)).not.toContain('secret internal detail');
  });

  it('C-338: unknown paths → 404 and the body never echoes the request', async () => {
    const r = await s.call('POST', '/v1/unknown/path?secret=1', { body: { text: 'SECRET-BODY' } });
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('SECRET-BODY');
    expect(r.text).not.toContain('secret=1');
  });

  it('C-338: an unexpected server exception → 500 with status text only', async () => {
    s.repos.db5.getAll = () => {
      throw new Error('db exploded with /private/path');
    };
    const r = await s.call('GET', '/v1/settings/limits');
    expect(r.status).toBe(500);
    expect(r.text).not.toContain('exploded');
    expect(r.text).not.toContain('/private/path');
  });
});

describe('§14.1 sessions', () => {
  it('C-339: POST /v1/sessions returns {session_id}', async () => {
    const r = await s.call('POST', '/v1/sessions', { body: { timezone: 'Asia/Kolkata' } });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(['session_id']);
    expect(r.json.session_id).toMatch(/^ses_[0-9a-f]{12}$/);
  });

  it('C-339: an invalid IANA timezone → 400; a missing timezone → 400', async () => {
    expect((await s.call('POST', '/v1/sessions', { body: { timezone: 'Mars/Olympus' } })).status).toBe(400);
    expect((await s.call('POST', '/v1/sessions', { body: {} })).status).toBe(400);
    expect((await s.call('POST', '/v1/sessions')).status).toBe(400);
    expect((await s.call('POST', '/v1/sessions', { body: { timezone: 5 } })).status).toBe(400);
  });

  it('C-339: a second POST closes the first session (404 afterwards; DB1/DB3/DB8 cleared)', async () => {
    const first = await s.openSession();
    s.repos.db1.mint({
      session_id: first,
      request_id: 'req_000000000001',
      amount: '5',
      token: 'USDC',
      source: 'user',
      origin: 'phrase',
      confirmed: true,
    });
    const second = await s.openSession('Europe/Paris');
    expect(second).not.toBe(first);
    expect((await s.message(first)).status).toBe(404);
    expect(s.repos.tables.db1.size).toBe(0);
    expect(s.repos.tables.db3.size).toBe(0);
    expect([...s.repos.tables.db8_sessions.keys()]).toEqual([second]);
    expect(s.repos.vacuumCount).toBeGreaterThan(0);
  });

  it('C-340: DELETE → 204 with an empty body; unknown → 404; the same id again → 404', async () => {
    const sid = await s.openSession();
    const del = await s.call('DELETE', `/v1/sessions/${sid}`);
    expect(del.status).toBe(204);
    expect(del.text).toBe('');
    expect((await s.call('DELETE', `/v1/sessions/${sid}`)).status).toBe(404);
    expect((await s.call('DELETE', '/v1/sessions/ses_ffffffffffff')).status).toBe(404);
  });
});

describe('C-340 DELETE with an empty JSON body', () => {
  const del = (sid: string, token: string | null = UI_TOKEN) =>
    s.app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${sid}`,
      headers: {
        ...(token !== null ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
        'content-length': '0',
      },
    });

  it('C-340: content-type application/json with content-length 0 → 204; an unknown id → 404', async () => {
    const sid = await s.openSession();
    expect((await del('ses_ffffffffffff')).statusCode).toBe(404);
    const r = await del(sid);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe('');
  });

  it('C-336 / C-340: a wrong or missing token on that request still gets 401 and closes nothing', async () => {
    const sid = await s.openSession();
    expect((await del(sid, 'z'.repeat(UI_TOKEN.length))).statusCode).toBe(401);
    expect((await del(sid, null)).statusCode).toBe(401);
    expect((await s.message(sid)).status).toBe(200);
  });

  it('SQ-A-05 / C-340: with a session open, DELETE of another id present in db8_sessions → 404 and the open session stays', async () => {
    const sid = await s.openSession();
    s.repos.db8.insertSession({ session_id: 'ses_dddddddddddd', timezone: 'UTC', opened_at: 't' });
    expect((await s.call('DELETE', '/v1/sessions/ses_dddddddddddd')).status).toBe(404);
    expect(s.repos.tables.db8_sessions.has('ses_dddddddddddd')).toBe(true);
    expect((await s.message(sid)).status).toBe(200);
  });
});

describe('§14.1 messages', () => {
  it('C-341: a message starts a new request', async () => {
    const sid = await s.openSession();
    const a = await s.message(sid, 'one');
    const b = await s.message(sid, 'two');
    expect(a.body.request_id).not.toBe(b.body.request_id);
  });

  it('C-341: omitted pasted_blocks / attachments / urls default to empty arrays in ctx.req.input', async () => {
    let seen: AgentRequest['input'] | undefined;
    s.set('s0', {
      step: async (ctx) => {
        seen = ctx.req.input;
        return { kind: 'continue' };
      },
    });
    const sid = await s.openSession();
    await s.message(sid, 'hello');
    expect(seen).toEqual({ text: 'hello', pasted_blocks: [], attachments: [], urls: [] });
  });

  it('C-341: given pasted_blocks / attachments / urls reach the step unchanged', async () => {
    let seen: AgentRequest['input'] | undefined;
    s.set('s0', {
      step: async (ctx) => {
        seen = ctx.req.input;
        return { kind: 'continue' };
      },
    });
    const sid = await s.openSession();
    const body = {
      text: 'hello',
      pasted_blocks: ['block'],
      attachments: [{ filename: 'f.txt', mime: 'text/plain', base64: 'aGk=' }],
      urls: ['https://example.invalid/x'],
    };
    await s.call('POST', `/v1/sessions/${sid}/messages`, { body });
    expect(seen).toEqual(body);
  });

  it('C-341: unknown session → 404; invalid body → 400', async () => {
    expect((await s.call('POST', '/v1/sessions/ses_ffffffffffff/messages', { body: { text: 'x' } })).status).toBe(404);
    const sid = await s.openSession();
    for (const body of [{}, { text: 5 }, { text: 'x', extra: 1 }, { text: 'x', urls: 'u' }, 'str', [1]]) {
      expect((await s.call('POST', `/v1/sessions/${sid}/messages`, { body })).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('§14.1 answers', () => {
  async function paused(): Promise<{ sid: string; rid: string; qid: string }> {
    const q = question();
    q.chips = [CHIPS.USDC, CHIPS.ETH];
    let asked = false;
    s.set('s3', {
      step: async () => {
        if (asked) return { kind: 'continue' };
        asked = true;
        return { kind: 'question', question: q };
      },
    });
    const sid = await s.openSession();
    const r = await s.message(sid);
    return { sid, rid: r.body.request_id, qid: q.question_id };
  }

  it('C-342: chip, text and selected_ids answers are accepted', async () => {
    for (const ans of [{ chip_id: 'usdc' }, { text: 'usdc' }, { selected_ids: ['a', 'b'] }]) {
      s = makeServer();
      const { sid, qid } = await paused();
      const r = await s.call('POST', `/v1/sessions/${sid}/answers`, { body: { question_id: qid, ...ans } });
      expect(r.status, JSON.stringify(ans)).toBe(200);
      expect(r.json.state).toBe('awaiting_confirmation');
    }
  });

  it('C-342: a stale question_id → 409', async () => {
    const { sid } = await paused();
    const r = await s.call('POST', `/v1/sessions/${sid}/answers`, {
      body: { question_id: 'q_000000000000', chip_id: 'usdc' },
    });
    expect(r.status).toBe(409);
  });

  it('C-342: no pending question → 409', async () => {
    const sid = await s.openSession();
    await s.message(sid);
    const r = await s.call('POST', `/v1/sessions/${sid}/answers`, {
      body: { question_id: 'q_000000000000', text: 'x' },
    });
    expect(r.status).toBe(409);
  });

  it('C-342: a body with two answer kinds, or none → 400', async () => {
    const { sid, qid } = await paused();
    const post = (body: unknown) => s.call('POST', `/v1/sessions/${sid}/answers`, { body });
    expect((await post({ question_id: qid, chip_id: 'a', text: 'b' })).status).toBe(400);
    expect((await post({ question_id: qid, text: 'b', selected_ids: [] })).status).toBe(400);
    expect((await post({ question_id: qid })).status).toBe(400);
    expect((await post({ chip_id: 'a' })).status).toBe(400);
  });
});

describe('§14.1 confirm', () => {
  const UNAVAILABLE: StepResult = { kind: 'error', code: 'EXECUTION_UNAVAILABLE' };

  it('C-343: yes → handed off; no → dropped', async () => {
    const sid = await s.openSession();
    const a = await s.message(sid);
    const yes = await s.call('POST', `/v1/sessions/${sid}/confirm`, {
      body: { request_id: a.body.request_id, decision: 'yes' },
    });
    expect(yes.status).toBe(200);
    expect(yes.json).toMatchObject({ state: 'done', messages: [{ type: 'text', text: REPLY.HANDED_OFF() }] });
    const b = await s.message(sid);
    const no = await s.call('POST', `/v1/sessions/${sid}/confirm`, {
      body: { request_id: b.body.request_id, decision: 'no' },
    });
    expect(no.json).toMatchObject({ state: 'done', messages: [{ type: 'text', text: REPLY.USER_SAID_NO() }] });
  });

  it('C-343: wrong state → 409; wrong request_id → 409', async () => {
    const sid = await s.openSession();
    const a = await s.message(sid);
    const wrong = await s.call('POST', `/v1/sessions/${sid}/confirm`, {
      body: { request_id: 'req_000000000000', decision: 'yes' },
    });
    expect(wrong.status).toBe(409);
    await s.call('POST', `/v1/sessions/${sid}/confirm`, { body: { request_id: a.body.request_id, decision: 'no' } });
    const again = await s.call('POST', `/v1/sessions/${sid}/confirm`, {
      body: { request_id: a.body.request_id, decision: 'yes' },
    });
    expect(again.status).toBe(409);
  });

  it('C-343: HANDOFF_FAILED: yes retries, no → 409', async () => {
    const results: StepResult[] = [UNAVAILABLE];
    s.set('s12', { step: async () => results.shift() ?? { kind: 'continue' } });
    const sid = await s.openSession();
    const a = await s.message(sid);
    const rid = a.body.request_id;
    const first = await s.call('POST', `/v1/sessions/${sid}/confirm`, { body: { request_id: rid, decision: 'yes' } });
    expect(first.json.state).toBe('error');
    const no = await s.call('POST', `/v1/sessions/${sid}/confirm`, { body: { request_id: rid, decision: 'no' } });
    expect(no.status).toBe(409);
    const retry = await s.call('POST', `/v1/sessions/${sid}/confirm`, { body: { request_id: rid, decision: 'yes' } });
    expect(retry.status).toBe(200);
    expect(retry.json.state).toBe('done');
  });

  it('C-343: a bad decision value or missing field → 400', async () => {
    const sid = await s.openSession();
    const a = await s.message(sid);
    const post = (body: unknown) => s.call('POST', `/v1/sessions/${sid}/confirm`, { body });
    expect((await post({ request_id: a.body.request_id, decision: 'maybe' })).status).toBe(400);
    expect((await post({ request_id: a.body.request_id, decision: 'YES' })).status).toBe(400);
    expect((await post({ request_id: a.body.request_id })).status).toBe(400);
    expect((await post({ decision: 'yes' })).status).toBe(400);
  });
});

describe('§14.1 cancel', () => {
  it('C-344: cancel of the active request → done with the CANCELLED text', async () => {
    const sid = await s.openSession();
    const a = await s.message(sid);
    const r = await s.call('POST', `/v1/sessions/${sid}/cancel`, { body: { request_id: a.body.request_id } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'done', messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }] });
  });

  it('C-344 / SQ-A-01 F-8: no active request → 200, state done, "Cancelled. Nothing was sent.", no error', async () => {
    const sid = await s.openSession();
    const r = await s.call('POST', `/v1/sessions/${sid}/cancel`, { body: { request_id: 'req_000000000000' } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ state: 'done', messages: [{ type: 'text', text: 'Cancelled. Nothing was sent.' }] });
    expect(r.json).not.toHaveProperty('error');
  });

  it('C-344: unknown session → 404; invalid body → 400', async () => {
    expect((await s.call('POST', '/v1/sessions/ses_ffffffffffff/cancel', { body: { request_id: 'r' } })).status).toBe(
      404,
    );
    const sid = await s.openSession();
    expect((await s.call('POST', `/v1/sessions/${sid}/cancel`, { body: {} })).status).toBe(400);
  });
});

describe('§14.1 one call per session at a time', () => {
  it('C-348: a second concurrent call on one session → 409; the first then completes 200', async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const inStep = new Promise<void>((r) => {
      started = r;
    });
    s.set('s4', {
      step: () =>
        new Promise<StepResult>((resolve) => {
          release = () => resolve({ kind: 'continue' });
          started();
        }),
    });
    const sid = await s.openSession();
    const first = s.message(sid, 'first');
    await inStep;
    const second = await s.message(sid, 'second');
    expect(second.status).toBe(409);
    release();
    const done = await first;
    expect(done.status).toBe(200);
    expect(done.body.state).toBe('awaiting_confirmation');
  });
});

describe('§14.1 / §14.4 health', () => {
  it('C-347: /v1/health → {ok:true, ollama:true, db:true}', async () => {
    const r = await s.call('GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, ollama: true, db: true });
  });

  it('C-347: ollama is false when modelAvailable returns false and when it throws', async () => {
    s.llm.modelAvailable = async () => false;
    expect((await s.call('GET', '/v1/health')).json).toEqual({ ok: true, ollama: false, db: true });
    s.llm.modelAvailable = async () => {
      throw new Error('connection refused');
    };
    const r = await s.call('GET', '/v1/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, ollama: false, db: true });
  });

  it('C-347: db is false when repos.db5.getAll throws', async () => {
    s.repos.db5.getAll = () => {
      throw new Error('locked');
    };
    expect((await s.call('GET', '/v1/health')).json).toEqual({ ok: true, ollama: true, db: false });
  });

  it('C-347 / C-336: health needs the UI token', async () => {
    expect((await s.call('GET', '/v1/health', { token: null })).status).toBe(401);
  });
});

describe('§18 the app logs no URL or body', () => {
  it('§18: after a run of calls, every log entry has only allowlisted fields and no request content', async () => {
    const sid = await s.openSession();
    const a = await s.call('POST', `/v1/sessions/${sid}/messages`, { body: { text: 'SECRET-TEXT-MARKER' } });
    await s.call('POST', `/v1/sessions/${sid}/cancel`, { body: { request_id: a.json.request_id } });
    await s.call('POST', '/v1/sessions', { raw: '{bad SECRET-JSON-MARKER' });
    await s.call('GET', '/v1/nothing?SECRET-URL-MARKER=1');
    await s.call('GET', '/v1/health', { token: 'wrong-SECRET-TOKEN-MARKER' });
    await s.call('DELETE', `/v1/sessions/${sid}`);
    expect(s.log.lines.length).toBeGreaterThan(0);
    for (const line of s.log.lines) {
      for (const k of Object.keys(line)) expect(LOG_ALLOWED_FIELDS, k).toContain(k);
    }
    expect(JSON.stringify(s.log.lines)).not.toMatch(/SECRET|usdc|Bearer/i);
  });
});

describe('§14.1 / §16.4 bind address', () => {
  it('C-407: main() calls app.listen with host 127.0.0.1 (no real socket)', async () => {
    const listen = vi.fn(async () => '');
    const close = vi.fn(async () => undefined);
    vi.resetModules();
    vi.doMock('../../../src/server/app.js', () => ({ createApp: () => ({ listen, close }) }));
    try {
      const { main } = await import('../../../src/index.js');
      const dir = mkdtempSync(join(tmpdir(), 'agent-a-main-'));
      const cfg = testConfig();
      cfg.db.path = join(dir, 'agent.db');
      cfg.auth.ui_token_file = join(dir, 'ui_token');
      cfg.auth.execution_report_token_file = join(dir, 'report_token');
      cfg.execution.outbound_token_file = join(dir, 'outbound_token');
      const cfgPath = join(dir, 'config.json');
      writeFileSync(cfgPath, JSON.stringify(cfg));
      let stored: string | null = null;
      const keyStore = {
        get: () => stored,
        set: (v: string) => {
          stored = v;
        },
      };
      const f = (): never => {
        throw new Error('unused');
      };
      const running = await main(
        {
          createLlm: () => s.llm,
          createRpc: () => ({}) as never,
          createFetcher: () => ({}) as never,
          createEns: () => ({}) as never,
          createSubnames: () => ({}) as never,
          createExecution: () => ({}) as never,
          registry: { get: f } as never,
        },
        { configPath: cfgPath, keyStore, logFile: join(dir, 'agent.log') },
      );
      expect(listen).toHaveBeenCalledTimes(1);
      expect(listen).toHaveBeenCalledWith({ host: '127.0.0.1', port: cfg.server.port });
      await running.close();
      expect(close).toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../../src/server/app.js');
      vi.resetModules();
    }
  });
});
