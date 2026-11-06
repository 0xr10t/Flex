// Independent SQ-CHAT-01 review: real HTTP/session/SQLCipher, fixture-only model and external services.
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import type { FixtureCall } from '../fakes/llm.js';
import { Harness, loadFixture, MIHIR, type Resp } from './harness.js';

const made: Harness[] = [];
const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
const route = (intent: 'wallet' | 'chat') => call('chat_route', { intent });
const chat = (reply = 'An explanation, with no wallet action.') => call('chat', { reply });
const failure = (name: FixtureCall['name']): FixtureCall[] => [call(name, null), { ...call(name, null), attempt: 2 }];
function payment(name = 'mihir'): FixtureCall[] {
  const calls = structuredClone(loadFixture('A-55').calls);
  calls.forEach((item) => {
    item.match = '';
  });
  calls[2]!.output = { spans: [{ text: name, kind: 'name', role: 'payee' }] };
  return calls;
}
function make(id: string, calls: FixtureCall[], enabled: boolean | undefined = true): Harness {
  const h = new Harness(`general-chat-review-${id}`, { calls }, {});
  if (enabled !== undefined) h.config.chat = { enabled, think: true };
  h.config.llm.think = false;
  made.push(h);
  return h;
}
const TABLES = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db4_balances',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_sessions',
  'db8_prompts',
  'db8_history',
  'handoff_journal',
];
const snapshot = (h: Harness) => Object.fromEntries(TABLES.map((name) => [name, h.rows(`SELECT * FROM ${name}`)]));
const respond = (h: Harness, pending: Resp, text: string, channel: 'answers' | 'messages') =>
  channel === 'answers' ? h.answer(pending, { text }) : h.say(text);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const h of made.splice(0)) await h.finish({ allowUnused: true });
});

describe('SQ-CHAT-01 independent HTTP boundaries', () => {
  it.each([false, undefined])(
    'disabled/absent chat (%s) preserves the original wallet call sequence',
    async (enabled) => {
      const h = make(`disabled-${String(enabled)}`, payment(), enabled);
      if (enabled === undefined) delete h.config.chat;
      expect((await h.say('send 10 usdc to mihir')).body.state).toBe('awaiting_confirmation');
      expect(h.llm.names()).toEqual(['amounts', 'request_type', 'spans', 'payments']);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it('keeps generic follow-ups in bounded in-memory history, with no wallet or durable storage changes', async () => {
    const h = make('idle-history', [route('chat'), chat('USDC is a token.'), route('chat'), chat('More context.')]);
    await h.open();
    const before = snapshot(h);
    const first = await h.say('What is USDC?');
    const second = await h.say('Tell me more');
    expect(first.body.state).toBe('done');
    expect(second.body.state).toBe('done');
    expect(second.body.request_id).not.toBe(first.body.request_id);
    expect(h.llm.recorded[0]).toMatchObject({ name: 'chat_route', think: false });
    expect(h.llm.recorded[1]).toMatchObject({ name: 'chat', think: true });
    expect(JSON.parse(h.llm.recorded[2]!.user).recent_chat).toEqual([
      { user: 'What is USDC?', assistant: 'USDC is a token.' },
    ]);
    expect(snapshot(h)).toEqual(before);
    expect(h.rpc.calls).toEqual([]);
    expect(h.ens.calls).toEqual([]);
    expect(h.fetcher.calls).toEqual([]);
    expect(h.exec.submissions).toEqual([]);
    expect((await h.confirm(second, 'yes')).http).toBe(409);
  });

  it.each(['answers', 'messages'] as const)(
    'preserves a pending Q_WHO_IS and attempt through general chat on /%s, then accepts a literal answer',
    async (channel) => {
      const native = payment('Yash');
      const h = make(`question-${channel}`, [
        route('wallet'),
        ...native.slice(0, 3),
        route('chat'),
        chat('An address identifies the intended wallet.'),
        native[3]!,
      ]);
      const pending = await h.say('send 10 usdc to Yash');
      expect(pending.body.question?.code).toBe('Q_WHO_IS');
      const before = snapshot(h);
      const explained = await respond(h, pending, 'Why do you need an address?', channel);
      expect(explained.body.question).toEqual(pending.body.question);
      expect(explained.body.request_id).toBe(pending.body.request_id);
      expect(explained.body.state).toBe('awaiting_answer');
      expect(snapshot(h)).toEqual(before);
      const context = JSON.parse(h.llm.recorded.find((r) => r.name === 'chat')!.user).wallet_context;
      expect(context).toMatchObject({ state: 'AWAITING_ANSWER', question_code: 'Q_WHO_IS' });
      expect(context).not.toHaveProperty('question_text');
      expect(JSON.stringify(context)).not.toContain(MIHIR);
      const summary = await h.answer(explained, { text: MIHIR });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(h.llm.names()).toEqual([
        'chat_route',
        'amounts',
        'request_type',
        'spans',
        'chat_route',
        'chat',
        'payments',
      ]);
      expect(h.exec.submissions).toHaveLength(0);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents[0]).toMatchObject({ recipient: MIHIR, amount: { value: '10' } });
    },
  );

  it('explains the current corrected summary without replacing it or acquiring consent', async () => {
    const native = payment('Yash');
    const h = make('corrected-summary', [
      route('wallet'),
      ...native.slice(0, 3),
      route('wallet'),
      call('conversation', { intent: 'recipient', value: 'mihir' }),
      native[3]!,
      route('chat'),
      chat('The current recipient is Mihir.'),
    ]);
    const question = await h.say('send 10 usdc to Yash');
    const summary = await h.answer(question, { text: 'pay mihir instead' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    const before = snapshot(h);
    const explained = await h.say('Explain the current recipient and amount');
    expect(explained.body.request_id).toBe(summary.body.request_id);
    expect(explained.body.summary).toEqual(summary.body.summary);
    expect(snapshot(h)).toEqual(before);
    expect(h.exec.submissions).toHaveLength(0);
    const context = JSON.parse(h.llm.recorded.find((r) => r.name === 'chat')!.user).wallet_context;
    expect(context.original_request).toContain('Yash');
    expect(context.pending_summary).toEqual({ text: summary.body.summary!.text, notes: summary.body.summary!.notes });
    expect(context.pending_summary.text).toContain('Mihir');
    expect(context.pending_summary.text).not.toContain('Yash');
    const calls = h.llm.recorded.length;
    expect((await h.say('yes')).body.state).toBe('done');
    expect(h.llm.recorded).toHaveLength(calls);
    expect(h.exec.submissions).toHaveLength(1);
    expect(h.envelope.intents[0]).toMatchObject({ recipient: MIHIR, amount: { value: '10' } });
  });

  it.each(['chat_route', 'chat'] as const)(
    'a %s failure preserves a pending wallet question and never falls through to extraction',
    async (failedCall) => {
      const native = payment('Yash');
      const h = make(`failure-${failedCall}`, [
        route('wallet'),
        ...native.slice(0, 3),
        ...(failedCall === 'chat' ? [route('chat')] : []),
        ...failure(failedCall),
        route('chat'),
        chat('Recovered.'),
      ]);
      const pending = await h.say('send 10 usdc to Yash');
      const before = snapshot(h);
      const failed = await h.answer(pending, { text: 'Explain this please' });
      expect(failed.body.question).toEqual(pending.body.question);
      expect(failed.body.request_id).toBe(pending.body.request_id);
      expect(failed.body.messages[0]?.text).toContain("couldn't answer");
      expect(snapshot(h)).toEqual(before);
      await h.answer(failed, { text: 'Try explaining again' });
      expect(JSON.parse(h.llm.recorded.at(-1)!.user).recent_chat).toEqual([]);
      expect(h.llm.names().filter((name) => name === 'amounts')).toHaveLength(1);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it('a secret-bearing reply is discarded and cannot contaminate later history', async () => {
    const secret = 'ab'.repeat(32);
    const h = make('unsafe-output', [route('chat'), chat(secret), route('chat'), chat('Safe reply.')]);
    const first = await h.say('Explain a token');
    expect(JSON.stringify(first.body)).not.toContain(secret);
    expect(first.body.messages[0]?.text).toContain("couldn't answer");
    await h.say('Please explain again');
    expect(JSON.parse(h.llm.recorded.at(-1)!.user).recent_chat).toEqual([]);
    expect(h.count('db8_prompts')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('retains the original timeout error and immutable submitted envelope during explanations', async () => {
    const h = make('timeout-explanation', [
      route('wallet'),
      ...payment(),
      route('chat'),
      chat('Submission may have reached the wallet.'),
    ]);
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const summary = await h.say('send 10 usdc to mihir');
    const failed = await h.confirm(summary, 'yes');
    expect(failed.body.error?.code).toBe('EXECUTION_UNAVAILABLE');
    const sent = structuredClone(h.exec.submissions[0]);
    const before = snapshot(h);
    const explained = await h.say('Did anything happen to my submission?');
    expect(explained.body.request_id).toBe(summary.body.request_id);
    expect(explained.body.state).toBe('error');
    expect(explained.body.error).toEqual(failed.body.error);
    expect(snapshot(h)).toEqual(before);
    expect(h.exec.submissions).toEqual([sent]);
    const context = JSON.parse(h.llm.recorded.at(-1)!.user).wallet_context;
    expect(context.state).toBe('HANDOFF_FAILED');
    expect(context.last_error).toBe('EXECUTION_UNAVAILABLE');
    expect(context.pending_summary).toBeNull();
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toEqual([sent, sent]);
  });

  it('marks older history omitted after trimming and clears the flag and memory on a new session', async () => {
    const calls = Array.from({ length: 9 }, (_, i) => [route('chat'), chat(`Explanation ${i}.`)]).flat();
    const h = make('history-limit', calls);
    for (let i = 0; i < 8; i++) await h.say(`Question number ${i}?`);
    const last = JSON.parse(h.llm.recorded.at(-1)!.user);
    expect(last.recent_chat).toHaveLength(6);
    expect(last.recent_chat[0].user).toBe('Question number 1?');
    expect(last.older_chat_omitted).toBe(true);
    expect(h.count('db8_prompts')).toBe(0);
    expect(await h.close()).toBe(204);
    await h.open();
    await h.say('A fresh question');
    const fresh = JSON.parse(h.llm.recorded.at(-1)!.user);
    expect(fresh.recent_chat).toEqual([]);
    expect(fresh.older_chat_omitted).toBe(false);
  });

  it.each(['chat_route', 'chat'] as const)(
    'serializes %s, rejects stale/busy calls and waits for it on close',
    async (blockedCall) => {
      const native = payment('Yash');
      const h = make(`closing-${blockedCall}`, [route('wallet'), ...native.slice(0, 3), route('chat'), chat()]);
      const pending = await h.say('send 10 usdc to Yash');
      const beforeCalls = h.llm.recorded.length;
      const stale = await h.http('POST', `/v1/sessions/${h.sessionId}/answers`, {
        body: { question_id: 'q_000000000000', text: 'Explain' },
      });
      expect(stale.status).toBe(409);
      expect(h.llm.recorded).toHaveLength(beforeCalls);
      const entered = deferred(),
        release = deferred();
      const real = h.llm.call.bind(h.llm);
      h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
        if (args.name === blockedCall) {
          entered.resolve();
          await release.promise;
        }
        return real<T>(args);
      };
      const running = h.answer(pending, { text: 'Explain this question' });
      await entered.promise;
      expect((await h.say('Another question')).http).toBe(409);
      let closed = false;
      const closing = h.close().then((status) => {
        closed = true;
        return status;
      });
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(closed).toBe(false);
        expect((await h.say('cancel')).http).toBe(404);
      } finally {
        release.resolve();
      }
      expect((await running).body.question).toEqual(pending.body.question);
      expect(await closing).toBe(204);
      for (const name of ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'])
        expect(h.count(name)).toBe(0);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it.each(['answers', 'messages'] as const)(
    'guards raw and encoded URL secrets before inference/storage on /%s',
    async (channel) => {
      const secret = 'ab'.repeat(32);
      const encoded = [...secret].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
      for (const text of [secret, `What is https://example.org/?key=${encoded}`]) {
        const native = payment('Yash');
        const h = make(`secrets-${channel}`, [route('wallet'), ...native.slice(0, 3)]);
        const pending = await h.say('send 10 usdc to Yash');
        const before = h.llm.recorded.length;
        const prompts = h.rows('SELECT * FROM db8_prompts');
        expect((await respond(h, pending, text, channel)).body.error?.code).toBe('SECRET_DETECTED');
        expect(h.llm.recorded).toHaveLength(before);
        expect(h.rows('SELECT * FROM db8_prompts')).toEqual(prompts);
        expect(h.fetcher.calls).toEqual([]);
        expect(h.exec.submissions).toHaveLength(0);
      }
    },
  );

  it('sends a URL-only pending answer through S1 without exposing its URL to either chat classifier', async () => {
    const native = payment('Yash');
    const h = make('url-answer', [route('wallet'), ...native.slice(0, 3)]);
    const pending = await h.say('send 10 usdc to Yash');
    const before = h.llm.recorded.length;
    const response = await h.answer(pending, { text: 'https://example.org/invoice' });
    expect(response.body.request_id).not.toBe(pending.body.request_id);
    expect(response.body.error?.code).toBe('URL_FETCH_FAILED');
    expect(h.llm.recorded).toHaveLength(before);
    expect(h.fetcher.calls).toEqual(['https://example.org/invoice']);
    expect(h.exec.submissions).toHaveLength(0);
  });
});
