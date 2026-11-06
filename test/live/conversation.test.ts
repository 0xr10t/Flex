// Opt-in real-Ollama regressions for user-reported multi-turn failures. No network wallet or funds.
// Run separately from the 154-case benchmark: npm run test:live -- test/live/conversation.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { addr, ARB, BASE, Harness, MIHIR, type Resp } from '../acceptance/harness.js';
import { testConfig } from '../fakes/context.js';
import { liveModelConfig } from './model-config.js';

const RIYA = addr(44);
const directory = join(import.meta.dirname, 'results', 'conversation');
mkdirSync(directory, { recursive: true });
const results: unknown[] = [];
const tag = process.env.LIVE_TAG ?? 'latest';
const MODEL_CONFIG = liveModelConfig(testConfig().llm);

async function scenario(
  id: string,
  check: (h: Harness, trace: Array<{ name: string; output: unknown }>) => Promise<void>,
) {
  const h = new Harness(
    `live-conversation-${id}`,
    { calls: [] },
    { balances: { [BASE]: { USDC: '2000', ETH: '0.1' } } },
  );
  h.addContact('Riya', RIYA, [BASE, ARB]);
  h.config.llm = { ...MODEL_CONFIG };
  const real = createOllamaClient(h.config, { info() {}, warn() {}, error() {} });
  const trace: Array<{ name: string; output: unknown; ms: number }> = [];
  const turns: Array<{ channel: string; text: string; response: Resp }> = [];
  h.llm.modelAvailable = () => real.modelAvailable();
  h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
    const start = Date.now();
    const output = await real.call<T>(args);
    trace.push({ name: args.name, output, ms: Date.now() - start });
    return output;
  };
  const say = h.say.bind(h);
  h.say = async (...args) => {
    const response = await say(...args);
    turns.push({ channel: 'messages', text: args[0], response });
    return response;
  };
  const answer = h.answer.bind(h);
  h.answer = async (...args) => {
    const response = await answer(...args);
    const value = args[1];
    turns.push({ channel: 'answers', text: 'text' in value ? value.text : JSON.stringify(value), response });
    return response;
  };
  const start = Date.now();
  let passed = false;
  try {
    await h.open();
    await check(h, trace);
    passed = true;
  } finally {
    results.push({
      id,
      passed,
      llm_config: h.config.llm,
      ms: Date.now() - start,
      turns,
      trace,
      submissions: h.exec.submissions,
    });
    writeFileSync(join(directory, `${tag}.json`), JSON.stringify(results, null, 2));
    await h.finish({ allowUnused: true });
  }
}

describe('real-model conversational replies', () => {
  it('preserves 10 USD and a three-week, twice-weekly autopay when Yash changes to Riya', async () => {
    await scenario('recipient-and-amount', async (h, trace) => {
      const first = await h.say('Setup an autopay to yash for 3 weeks twice a week.');
      expect(first.body.question?.code).toBe('Q_AMOUNT_MISSING');
      const who = await h.answer(first, { text: '10 usd' });
      expect(who.body.question?.code).toBe('Q_WHO_IS');
      expect(who.body.question?.text).toContain('yash');
      const summary = await h.answer(who, { text: 'pay riya' });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('Riya');
      expect(summary.body.summary?.text).toContain('10 USDC');
      expect(summary.body.summary?.notes.join(' ')).toContain('10 usd');
      expect(trace.filter((call) => call.name === 'conversation').map((call) => call.output)).toEqual([
        { intent: 'recipient', value: 'riya' },
      ]);
      expect(h.exec.submissions).toHaveLength(0);
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expect(h.envelope.intents).toHaveLength(1);
      const intent = h.envelope.intents[0]!;
      expect(intent).toMatchObject({
        intent_id: 'k',
        recipient: RIYA,
        token: 'USDC',
        amount_per_payment: { value: '10' },
        schedule: {
          frequency: 'weekly',
          interval: 1,
          days_of_week: ['MON', 'THU'],
          start_date: '2026-11-05',
          time_of_day: '10:00',
          timezone: 'Asia/Kolkata',
          end: { type: 'on_date', date: '2026-11-29' },
        },
        limits: { total_cap: { value: '60' } },
      });
      if (intent.intent_id !== 'k') throw new Error('Expected an autopay');
      expect(Date.parse(intent.schedule.first_occurrence)).toBe(Date.parse('2026-11-09T04:30:00Z'));
      expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
    });
  });

  it('clarifies a cancellation refund reply and accepts the next full autopay request', async () => {
    await scenario('refund-and-new-request', async (h, trace) => {
      const first = await h.say('cancel an autopay');
      expect(first.body.question?.code).toBe('Q_NO_PAYEE');
      const clarified = await h.answer(first, { text: 'I have to be paid for it' });
      expect(clarified.body.question).toEqual(first.body.question);
      expect(clarified.body.messages.map((message) => message.text).join(' ')).toContain('your wallet');
      expect(h.repos.db2.findByNameKey('i have to be')).toEqual([]);
      const replaced = await h.answer(clarified, { text: 'Setup an autopay to yash for 3 weeks twice a week.' });
      expect(replaced.body.request_id).not.toBe(first.body.request_id);
      expect(replaced.body.question?.code).toBe('Q_AMOUNT_MISSING');
      expect(trace.filter((call) => call.name === 'conversation').map((call) => call.output)).toEqual([
        { intent: 'clarify', value: null },
        { intent: 'new_request', value: null },
      ]);
      expect(h.exec.submissions).toHaveLength(0);
    });
  });

  it('answers a clarification without spending a retry, then accepts an address in a sentence', async () => {
    await scenario('clarify-and-address', async (h) => {
      const first = await h.say('send 10 USDC to Yash');
      expect(first.body.question?.code).toBe('Q_WHO_IS');
      const clarified = await h.answer(first, { text: 'why do you need that?' });
      expect(clarified.body.question).toEqual(first.body.question);
      const summary = await h.answer(clarified, { text: `his address is ${RIYA}` });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(h.exec.submissions).toHaveLength(0);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents).toMatchObject([{ intent_id: 'i', recipient: RIYA, amount: { value: '10' } }]);
    });
  });

  it('treats thanks as conversation, then extracts a natural amount answer', async () => {
    await scenario('thanks-and-amount', async (h) => {
      const first = await h.say('pay mihir');
      expect(first.body.question?.code).toBe('Q_AMOUNT_MISSING');
      const thanked = await h.answer(first, { text: 'thanks' });
      expect(thanked.body.question).toEqual(first.body.question);
      const summary = await h.answer(thanked, { text: 'please send 10 usd' });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('10 USDC');
      expect(h.exec.submissions).toHaveLength(0);
    });
  });

  it('starts a complete new payment while an address question is pending on /messages', async () => {
    await scenario('new-request-messages', async (h) => {
      const first = await h.say('send 10 USDC to Yash');
      expect(first.body.question?.code).toBe('Q_WHO_IS');
      const summary = await h.say('send 5 USDC to Mihir on Base');
      expect(summary.body.request_id).not.toBe(first.body.request_id);
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(h.exec.submissions).toHaveLength(0);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents).toMatchObject([
        { intent_id: 'i', recipient: MIHIR, chain_id: BASE, amount: { value: '5' } },
      ]);
    });
  });

  it('does not cancel the draft for a negative cancellation reply', async () => {
    await scenario('negative-cancel', async (h) => {
      const first = await h.say('send 10 USDC to Yash');
      expect(first.body.question?.code).toBe('Q_WHO_IS');
      const retained = await h.answer(first, { text: 'please don’t cancel this' });
      expect(retained.body.request_id).toBe(first.body.request_id);
      expect(retained.body.question).toEqual(first.body.question);
      expect(h.exec.submissions).toHaveLength(0);
    });
  });

  it('accepts a token explicitly supplied in a natural reply', async () => {
    await scenario('natural-token', async (h, trace) => {
      const first = await h.say('send 10 to mihir');
      expect(first.body.question?.code).toBe('Q_TOKEN');
      const summary = await h.answer(first, { text: 'USDC please' });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('10 USDC');
      expect(trace.filter((call) => call.name === 'conversation').map((call) => call.output)).toEqual([
        { intent: 'answer', value: 'USDC' },
      ]);
      expect(h.exec.submissions).toHaveLength(0);
    });
  });
});
