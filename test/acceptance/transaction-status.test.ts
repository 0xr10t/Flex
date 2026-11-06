// Real HTTP/session/pipeline/SQLCipher, deterministic model and execution adapters; no external calls.
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionClient } from '../../src/contracts/io.js';
import { Harness, loadFixture, BASE, ARB, addr, type Resp } from './harness.js';
import type { FixtureCall } from '../fakes/llm.js';

const made: Harness[] = [];
const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
const text = (r: Resp) => r.body.messages.map((message) => message.text).join('\n');
const TX = `0x${'ab'.repeat(32)}`;

function payment(name = 'mihir'): FixtureCall[] {
  const calls = structuredClone(loadFixture('A-55').calls);
  calls.forEach((entry) => {
    entry.match = '';
  });
  calls[2]!.output = { spans: [{ text: name, kind: 'name', role: 'payee' }] };
  const pairing = calls[3]!.output as { payments: Array<{ chain: number | string }> };
  pairing.payments[0]!.chain = BASE;
  return calls;
}

function make(id: string, calls = payment()) {
  const h = new Harness(`transaction-status-${id}`, { calls }, {});
  made.push(h);
  return h;
}

function snapshot(h: Harness) {
  return {
    database: h.snapshot([
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
    ]),
    model: h.llm.recorded.length,
    rpc: h.rpc.calls.length,
    submissions: structuredClone(h.exec.submissions),
  };
}

afterEach(async () => {
  for (const h of made.splice(0)) await h.finish();
});

describe('transaction status follow-ups', () => {
  it.each([false, true])('explains local capture even with chat enabled=%s and Ollama offline', async (enabled) => {
    const h = make(`capture-${String(enabled)}`);
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    expect(done.body.state).toBe('done');
    (h.exec as ExecutionClient).wasCapturedLocally = (id) => id === done.body.request_id;
    h.config.chat = { enabled, think: true };
    h.llm.available = false;
    const before = snapshot(h);
    for (const question of ['did the transaction go through?', 'Was it successful?', 'Did it go through?']) {
      const reply = await h.say(question);
      expect(reply.body.reply_source).toBe('local');
      expect(reply.body.error).toBeUndefined();
      expect(text(reply)).toBe('No. Your payment plan was captured locally. Nothing was signed or broadcast.');
    }
    expect(snapshot(h)).toEqual(before);
    expect((await h.confirm(done, 'yes')).http).toBe(409);
  });

  it('distinguishes acceptance from completion, then reads authenticated execution reports and their hash', async () => {
    const h = make('reported');
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    const pending = await h.say('Did it go through?');
    expect(text(pending)).toContain('accepted the request, but I have not received confirmation');
    const report = {
      kind: 'intent_result',
      request_id: done.body.request_id,
      step: 0,
      status: 'executed',
      tx_hash: TX,
      executed_at: h.nowIso,
    };
    expect(await h.report(report, null)).toBe(401);
    expect(text(await h.say('Is it confirmed?'))).not.toContain(TX);
    expect(await h.report(report)).toBe(204);
    const before = snapshot(h);
    const reply = await h.say('Did it go through?');
    expect(text(reply)).toContain('all payment and bridge steps in this request completed');
    expect(text(reply)).toContain(TX);
    expect(snapshot(h)).toEqual(before);
  });

  it('shows a reported failure without resubmitting the payment', async () => {
    const h = make('failed');
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    expect(
      await h.report({
        kind: 'intent_result',
        request_id: done.body.request_id,
        step: 0,
        status: 'failed',
        tx_hash: TX,
      }),
    ).toBe(204);
    const before = snapshot(h);
    expect(text(await h.say('Did my payment fail?'))).toContain('Your wallet reported a failure');
    expect(snapshot(h)).toEqual(before);
  });

  it('does not turn a successful bridge into a successful destination payment', async () => {
    const h = make('partial');
    h.setBalances({ [BASE]: { USDC: '2', ETH: '0.1' }, [ARB]: { USDC: '60', ETH: '0.1' } });
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    expect(h.envelope.intents.map((intent) => intent.intent_id)).toEqual(['j', 'i']);
    expect(
      await h.report({
        kind: 'intent_result',
        request_id: done.body.request_id,
        step: 0,
        status: 'executed',
        tx_hash: TX,
        executed_at: h.nowIso,
        bridge_fee_eth: '0.0001',
      }),
    ).toBe(204);
    const partial = await h.say('Did it go through?');
    expect(text(partial)).toContain('only partly complete');
    expect(text(partial)).toContain('Payment on Base Sepolia: no completion report received');
    expect(await h.report({ kind: 'intent_result', request_id: done.body.request_id, step: 1, status: 'failed' })).toBe(
      204,
    );
    const failed = await h.say('Did it go through?');
    expect(text(failed)).toContain('only partly complete');
    expect(text(failed)).toContain('Payment on Base Sepolia: your wallet reported failure');
    expect(h.exec.submissions).toHaveLength(1);
  });

  it('preserves an unconfirmed summary and still requires an explicit yes', async () => {
    const h = make('summary');
    const pending = await h.say('send 10 usdc to mihir on base');
    const before = snapshot(h);
    const reply = await h.say('Did it go through?');
    expect(text(reply)).toContain('waiting for your confirmation');
    expect(reply.body.summary).toEqual(pending.body.summary);
    expect(reply.body.request_id).toBe(pending.body.request_id);
    expect(reply.body.state).toBe('awaiting_confirmation');
    expect(snapshot(h)).toEqual(before);
    expect((await h.confirm(reply, 'yes')).body.state).toBe('done');
  });

  it.each(['messages', 'answers'])('preserves the pending recipient question on /%s', async (channel) => {
    const h = make(`question-${channel}`, payment('Yash').slice(0, 3));
    const pending = await h.say('send 10 usdc to Yash on base');
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const before = snapshot(h);
    const reply =
      channel === 'answers'
        ? await h.answer(pending, { text: 'Did it go through?' })
        : await h.say('Did it go through?');
    expect(text(reply)).toContain('still need your answer');
    expect(reply.body.question).toEqual(pending.body.question);
    expect(reply.body.request_id).toBe(pending.body.request_id);
    expect(snapshot(h)).toEqual(before);
  });

  it('preserves uncertainty and retry state after timeouts, including exhausted retries', async () => {
    const h = make('timeout');
    h.exec.fallback = { status: 'unavailable', cause: 'timeout' };
    const summary = await h.say('send 10 usdc to mihir on base');
    for (let i = 0; i < 3; i++) {
      const failed = await h.confirm(summary, 'yes');
      expect(failed.body.error?.code).toBe('EXECUTION_UNAVAILABLE');
      const before = snapshot(h);
      const reply = await h.say('Did it go through?');
      expect(text(reply)).toContain('may have received it');
      expect(text(reply)).not.toContain('Nothing was signed or broadcast');
      if (i < 2) {
        expect(reply.body.request_id).toBe(summary.body.request_id);
        expect(reply.body.error).toEqual(failed.body.error);
      }
      expect(snapshot(h)).toEqual(before);
    }
  });

  it('distinguishes wallet rejection from an uncertain handoff', async () => {
    const h = make('rejected');
    h.exec.fallback = { status: 'rejected', message: 'Rejected by test wallet' };
    await h.sayAndConfirm('send 10 usdc to mihir on base');
    const before = snapshot(h);
    expect(text(await h.say('Did it go through?'))).toContain('wallet rejected this request');
    expect(snapshot(h)).toEqual(before);
  });

  it('remembers the last payment through unrelated requests and clears it on account/session changes', async () => {
    const h = make('memory', [
      ...payment(),
      call('amounts', { amounts: [] }),
      call('request_type', { request_type: 'unsupported', actions: [], also_balance: false }),
    ]);
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    (h.exec as ExecutionClient).wasCapturedLocally = (id) => id === done.body.request_id;
    await h.say('Show my balance');
    expect((await h.say('Stake my tokens')).body.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(text(await h.say('Did it go through?'))).toContain('captured locally');
    h.config.wallet.address = addr(99);
    await h.open();
    const before = snapshot(h);
    expect(text(await h.say('Did the transaction go through?'))).toBe(
      'I have no payment request to check in this session.',
    );
    expect(snapshot(h)).toEqual(before);
  });

  it('supplies capture status to general chat for less common wording without giving it transaction hashes', async () => {
    const h = make('chat-context', [
      ...payment(),
      call('chat_route', { intent: 'chat' }),
      call('chat', { reply: 'Nothing was broadcast in this demo.' }),
    ]);
    const done = await h.sayAndConfirm('send 10 usdc to mihir on base');
    (h.exec as ExecutionClient).wasCapturedLocally = (id) => id === done.body.request_id;
    h.config.chat = { enabled: true, think: true };
    await h.say('Explain what happened after I clicked confirm.');
    const context = JSON.parse(h.llm.recorded.at(-1)!.user).wallet_context;
    expect(context.transaction_status).toContain('captured locally');
    expect(context.transaction_status).not.toContain(TX);
    expect(h.exec.submissions).toHaveLength(1);
  });
});
