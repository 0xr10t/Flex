// SQ-CHAT-01 real-Ollama scenarios. All wallet services use the existing acceptance fakes; no funds are sent.
// Run separately: LIVE_MODEL=qwen3:8b LIVE_THINK=false LIVE_CHAT=true LIVE_TAG=<tag> \
//   npm run test:live -- test/live/general-chat.test.ts
// Traces contain effective API think switches and final JSON outputs, never model reasoning traces.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { addr, ARB, BASE, Harness, MIHIR, usdc, type Resp } from '../acceptance/harness.js';
import { testConfig } from '../fakes/context.js';
import { liveChatConfig, liveModelConfig } from './model-config.js';

const RIYA = addr(44);
const directory = join(import.meta.dirname, 'results', 'general-chat');
const tag = process.env.LIVE_TAG ?? 'latest';
const MODEL_CONFIG = liveModelConfig({ ...testConfig().llm, think: false });
const CHAT_CONFIG = liveChatConfig({ enabled: true, think: true });
const results: unknown[] = [];
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

interface ChatPrompt {
  latest_message: string;
  wallet_context: {
    state: string;
    original_request: string | null;
    pending_summary: { text: string; notes: string[] } | null;
    question_code: string | null;
  };
  recent_chat: Array<{ user: string; assistant: string }>;
  older_chat_omitted: boolean;
}

interface LiveCall {
  name: LlmCallArgs['name'];
  think: boolean | undefined;
  ms: number;
  context?: ChatPrompt;
  output?: unknown;
  error?: string;
}

const responseText = (response: Resp): string => response.body.messages.map((message) => message.text).join('\n');

async function scenario(id: string, check: (h: Harness, trace: LiveCall[]) => Promise<void>): Promise<void> {
  const h = new Harness(
    `live-general-chat-${id}`,
    { calls: [] },
    { balances: { [BASE]: { USDC: '2000', ETH: '0.1' } } },
  );
  h.addContact('Riya', RIYA, [BASE, ARB]);
  h.config.llm = { ...MODEL_CONFIG };
  h.config.chat = liveChatConfig({ enabled: true, think: true });
  const real = createOllamaClient(h.config, { info() {}, warn() {}, error() {} });
  const trace: LiveCall[] = [];
  const turns: Array<{ channel: string; text: string; response: Resp }> = [];
  h.llm.modelAvailable = () => real.modelAvailable();
  h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
    const call: LiveCall = {
      name: args.name,
      think: args.think ?? h.config.llm.think,
      ms: 0,
      ...(args.name === 'chat_route' || args.name === 'chat' ? { context: JSON.parse(args.user) as ChatPrompt } : {}),
    };
    trace.push(call);
    const start = Date.now();
    try {
      const output = await real.call<T>(args);
      call.output = output;
      return output;
    } catch (error) {
      call.error = error instanceof Error ? error.name : 'UnknownError';
      throw error;
    } finally {
      call.ms = Date.now() - start;
    }
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
  const confirm = h.confirm.bind(h);
  h.confirm = async (...args) => {
    const response = await confirm(...args);
    turns.push({ channel: 'confirm', text: args[1], response });
    return response;
  };
  const start = Date.now();
  let passed = false;
  let failure: string | undefined;
  try {
    expect(h.config.chat).toEqual({ enabled: true, think: true });
    expect(h.config.llm.think, 'This suite requires wallet extraction thinking to remain off').toBe(false);
    await h.open();
    await check(h, trace);
    expect(trace.some((call) => call.name === 'chat')).toBe(true);
    for (const call of trace) {
      expect(call.error, `${call.name} failed`).toBeUndefined();
      expect(call.think, `${call.name} used the wrong effective think switch`).toBe(call.name === 'chat');
    }
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.message : 'UnknownError';
    throw error;
  } finally {
    results.push({
      id,
      passed,
      failure,
      llm_config: h.config.llm,
      chat_config: h.config.chat,
      ms: Date.now() - start,
      turns,
      trace,
      submissions: h.exec.submissions,
    });
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, `${tag}.json`), JSON.stringify(results, null, 2));
    } finally {
      await h.finish({ allowUnused: true });
    }
  }
}

/** A chat turn must use the general model, leave all stores intact, and perform no wallet/content I/O. */
async function chatTurn(h: Harness, trace: LiveCall[], send: () => Promise<Resp>): Promise<Resp> {
  const before = h.snapshot(TABLES);
  const rpcCalls = h.rpc.calls.length;
  const ensCalls = h.ens.calls.length;
  const fetchCalls = h.fetcher.calls.length;
  const submissions = structuredClone(h.exec.submissions);
  const firstCall = trace.length;
  const response = await send();
  expect(response.http).toBe(200);
  expect(response.body.error).toBeUndefined();
  expect(h.snapshot(TABLES), 'A general chat turn changed a wallet or session store').toBe(before);
  expect(h.rpc.calls).toHaveLength(rpcCalls);
  expect(h.ens.calls).toHaveLength(ensCalls);
  expect(h.fetcher.calls).toHaveLength(fetchCalls);
  expect(h.exec.submissions).toEqual(submissions);
  const calls = trace.slice(firstCall);
  expect(calls.map((call) => call.name)).toEqual(['chat_route', 'chat']);
  expect(calls[0]?.output).toEqual({ intent: 'chat' });
  const output = calls[1]?.output as { reply?: unknown } | undefined;
  expect(typeof output?.reply).toBe('string');
  // Display cleanup preserves line breaks/tabs and removes other ASCII controls before trimming.
  const expected =
    typeof output?.reply === 'string'
      ? [...output.reply]
          .filter((character) => {
            const code = character.charCodeAt(0);
            return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
          })
          .join('')
          .trim()
      : undefined;
  expect(responseText(response)).toBe(expected);
  expect(responseText(response).length).toBeGreaterThan(0);
  return response;
}

function expectPayment(h: Harness, request: Resp, recipient: string, value: string): void {
  expect(h.exec.submissions).toHaveLength(1);
  expect(h.envelope.request_id).toBe(request.body.request_id);
  expect(h.envelope.intents).toHaveLength(1);
  expect(h.envelope.intents[0]).toMatchObject({
intent_id: 'i',
chain_id: BASE,
token: 'USDC',
recipients: [{ recipient, amount: usdc(value) }]
});
}

describe.skipIf(!CHAT_CONFIG?.enabled)('real-model general chat with thinking enabled', () => {
  it('answers a general question and a contextual follow-up without creating a wallet request', async () => {
    await scenario('general-follow-up', async (h, trace) => {
      const question = 'What is photosynthesis? Keep it brief.';
      const first = await chatTurn(h, trace, () => h.say(question));
      expect(first.body.state).toBe('done');
      expect(first.body.question).toBeUndefined();
      expect(first.body.summary).toBeUndefined();
      expect(responseText(first)).toMatch(/plant|alga/i);
      expect(responseText(first)).toMatch(/sunlight|light/i);
      const followUp = 'Which gas does that process release?';
      const second = await chatTurn(h, trace, () => h.say(followUp));
      expect(second.body.state).toBe('done');
      expect(second.body.request_id).not.toBe(first.body.request_id);
      expect(responseText(second)).toMatch(/oxygen/i);
      expect(trace.at(-1)?.context).toMatchObject({
        latest_message: followUp,
        wallet_context: { state: 'IDLE', pending_summary: null },
        recent_chat: [{ user: question, assistant: responseText(first) }],
        older_chat_omitted: false,
      });
      expect(h.exec.submissions).toHaveLength(0);
    });
  });

  it('explains Q_WHO_IS on /answers without consuming the question, then accepts its literal address', async () => {
    await scenario('pending-address-explanation', async (h, trace) => {
      const original = 'Send 10 USDC to Yash on Base';
      const pending = await h.say(original);
      expect(pending.body.question?.code).toBe('Q_WHO_IS');
      const explained = await chatTurn(h, trace, () =>
        h.answer(pending, { text: 'Why do you need his wallet address?' }),
      );
      expect(explained.body.state).toBe('awaiting_answer');
      expect(explained.body.request_id).toBe(pending.body.request_id);
      expect(explained.body.question).toEqual(pending.body.question);
      expect(responseText(explained)).toMatch(/address|ENS/i);
      expect(trace.at(-1)?.context?.wallet_context).toMatchObject({
        state: 'AWAITING_ANSWER',
        original_request: original,
        question_code: 'Q_WHO_IS',
        pending_summary: null,
      });
      const firstAnswerCall = trace.length;
      const summary = await h.answer(explained, { text: RIYA });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.request_id).toBe(pending.body.request_id);
      expect(summary.body.summary?.text).toContain('10 USDC');
      expect(
        trace.slice(firstAnswerCall).some((call) => ['chat_route', 'chat', 'conversation'].includes(call.name)),
      ).toBe(false);
      expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
      expect(h.exec.submissions).toHaveLength(0);
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expectPayment(h, summary, RIYA, '10');
    });
  });

  it('explains a pending confirmation on /messages and waits for an explicit native yes', async () => {
    await scenario('pending-confirmation-explanation', async (h, trace) => {
      const pending = await h.say('Send 5 USDC to Mihir on Base');
      expect(pending.body.state).toBe('awaiting_confirmation');
      const explained = await chatTurn(h, trace, () =>
        h.say('Will this send the payment before I confirm? Explain how confirmation works.'),
      );
      expect(explained.body.state).toBe('awaiting_confirmation');
      expect(explained.body.request_id).toBe(pending.body.request_id);
      expect(explained.body.summary).toEqual(pending.body.summary);
      expect(responseText(explained)).toMatch(/confirm/i);
      expect(trace.at(-1)?.context?.wallet_context).toMatchObject({
        state: 'AWAITING_CONFIRMATION',
        pending_summary: { text: pending.body.summary?.text, notes: pending.body.summary?.notes },
      });
      expect(h.exec.submissions).toHaveLength(0);
      const beforeYes = trace.length;
      const confirmed = await h.say('yes');
      expect(confirmed.body.state).toBe('done');
      expect(confirmed.body.request_id).toBe(pending.body.request_id);
      expect(trace.slice(beforeYes).some((call) => call.name === 'chat_route' || call.name === 'chat')).toBe(false);
      expectPayment(h, pending, MIHIR, '5');
    });
  });

  it('keeps a hypothetical payment read-only and routes a subsequent real command to native confirmation', async () => {
    await scenario('hypothetical-versus-command', async (h, trace) => {
      const hypothetical = await chatTurn(h, trace, () =>
        h.say('If I asked Flex to send 7 USDC to Mihir on Base, would it ask me to confirm first? Explain only.'),
      );
      expect(hypothetical.body.state).toBe('done');
      expect(hypothetical.body.question).toBeUndefined();
      expect(hypothetical.body.summary).toBeUndefined();
      expect(responseText(hypothetical)).toMatch(/confirm/i);
      expect(h.exec.submissions).toHaveLength(0);
      const firstCommandCall = trace.length;
      const pending = await h.say('Send 7 USDC to Mihir on Base');
      expect(pending.body.state).toBe('awaiting_confirmation');
      expect(pending.body.request_id).not.toBe(hypothetical.body.request_id);
      expect(pending.body.summary?.text).toContain('7 USDC');
      const commandCalls = trace.slice(firstCommandCall);
      expect(commandCalls.filter((call) => call.name === 'chat_route').map((call) => call.output)).toEqual([
        { intent: 'wallet' },
      ]);
      expect(commandCalls.some((call) => call.name === 'chat')).toBe(false);
      expect(h.exec.submissions).toHaveLength(0);
      expect((await h.confirm(pending, 'yes')).body.state).toBe('done');
      expectPayment(h, pending, MIHIR, '7');
    });
  });
});
