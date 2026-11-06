// SQ-CHAT-02 live evaluation: real local Qwen3, fake wallet IO, synthetic data and local execution capture only.
// Run: LIVE_MODEL=qwen3:8b npm run test:live -- test/live/wallet-chat.test.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { ARB, BASE, Harness, MIHIR, SEPOLIA, WALLET, type Resp } from '../acceptance/harness.js';
import { liveModelConfig } from './model-config.js';

const results: unknown[] = [];
const text = (response: Resp): string => response.body.messages.map((message) => message.text).join('\n');
const STORES = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_prompts',
  'db8_history',
  'handoff_journal',
];
interface Call {
  name: LlmCallArgs['name'];
  output?: unknown;
  ms: number;
}

async function scenario(id: string, check: (h: Harness, calls: Call[]) => Promise<void>): Promise<void> {
  const h = new Harness(
    `live-wallet-chat-${id}`,
    { calls: [] },
    {
      balances: {
        [SEPOLIA]: { USDC: '0', ETH: '0.1' },
        [BASE]: { USDC: '30', ETH: '0.1' },
        [ARB]: { USDC: '60', ETH: '0.1' },
      },
    },
  );
  h.config.llm = liveModelConfig({ ...h.config.llm, model: 'qwen3:8b', think: false });
  h.config.chat = { enabled: true, think: true };
  const model = createOllamaClient(h.config, { info() {}, warn() {}, error() {} });
  h.llm.modelAvailable = () => model.modelAvailable();
  const calls: Call[] = [];
  h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
    const item: Call = { name: args.name, ms: 0 };
    calls.push(item);
    const start = Date.now();
    try {
      const output = await model.call<T>(args);
      item.output = output;
      return output;
    } finally {
      item.ms = Date.now() - start;
    }
  };
  let passed = false;
  try {
    await h.open();
    await check(h, calls);
    passed = true;
  } finally {
    results.push({ id, passed, model: h.config.llm.model, calls, submissions: h.exec.submissions.length });
    const directory = join(process.cwd(), 'test_frontend', 'runtime');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'wallet-chat-live.json'), JSON.stringify(results, null, 2));
    await h.finish({ allowUnused: true });
  }
}

it('SQ-CHAT-02 live: normal conversation, own wallet address and exact multi-chain balances', async () => {
  await scenario('idle-wallet', async (h, calls) => {
    const before = h.snapshot(STORES);
    const greeting = await h.say('Hey Flex, how are you doing?');
    expect(greeting.body.error).toBeUndefined();
    expect(text(greeting).length).toBeGreaterThan(0);
    expect(calls[0]?.output).toEqual({ intent: 'chat' });
    expect(calls[1]?.output).toHaveProperty('reply');
    expect(text(greeting)).toBe((calls[1]!.output as { reply: string }).reply.trim());
    const address = await h.say('What is my wallet address?');
    expect(text(address)).toContain(WALLET);
    expect(calls.at(-2)?.output).toEqual({ intent: 'wallet_info' });
    const balances = await h.say('How much USDC do I have on Base and Arbitrum, and what is the total?');
    expect(text(balances)).toContain('Base Sepolia: 30 USDC');
    expect(text(balances)).toContain('Arbitrum Sepolia: 60 USDC');
    expect(text(balances)).toContain('90 USDC');
    expect(h.snapshot(STORES)).toBe(before);
    expect(h.exec.submissions).toHaveLength(0);
  });
});

it('SQ-CHAT-02 live: fresh follow-up balances and unavailable reads never reuse an old amount', async () => {
  await scenario('refresh-unavailable', async (h, calls) => {
    expect(text(await h.say('What is my USDC balance on Base?'))).toContain('Base Sepolia: 30 USDC');
    h.rpc.usdc.set(BASE, 35125006n);
    const fresh = await h.say('And how much USDC is available on Base now?');
    expect(text(fresh)).toContain('35.125006 USDC');
    expect(text(fresh)).not.toContain('30 USDC');
    expect(calls.at(-2)?.output).toEqual({ intent: 'wallet_info' });
    for (const chain of [SEPOLIA, BASE, ARB]) h.rpc.down.add(chain);
    const unavailable = await h.say('Show my wallet address and tell me my current USDC balance.');
    expect(text(unavailable)).toContain(WALLET);
    expect(text(unavailable)).toMatch(/could not be read|unavailable/);
    expect(text(unavailable)).not.toContain('35.125006');
    expect(text(unavailable)).not.toContain('0 USDC');
    expect(h.exec.submissions).toHaveLength(0);
  });
});

it('SQ-CHAT-02 live: wallet questions and normal explanations preserve a draft through final confirmation', async () => {
  await scenario('pending-payment', async (h, calls) => {
    const pending = await h.say('Send 10 USDC to Devika on Base');
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const before = h.snapshot(STORES);
    const address = await h.answer(pending, { text: 'Before I answer, what is MY own wallet address?' });
    expect(text(address)).toContain(WALLET);
    expect(address.body.question).toEqual(pending.body.question);
    expect(h.snapshot(STORES)).toBe(before);
    const explanation = await h.answer(address, { text: 'Why do you need their wallet address?' });
    expect(explanation.body.question).toEqual(pending.body.question);
    expect(text(explanation).length).toBeGreaterThan(0);
    expect(calls.at(-1)?.output).toHaveProperty('reply');
    expect(text(explanation)).toBe((calls.at(-1)!.output as { reply: string }).reply.trim());
    const summary = await h.answer(explanation, { text: MIHIR });
    expect(summary.body.state).toBe('awaiting_confirmation');
    const balance = await h.say('What is my USDC balance on Base right now?');
    expect(text(balance)).toContain('Base Sepolia: 30 USDC');
    expect(balance.body.summary).toEqual(summary.body.summary);
    expect(balance.body.request_id).toBe(summary.body.request_id);
    expect(h.exec.submissions).toHaveLength(0);
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toHaveLength(1);
    expect(h.envelope.intents[0]).toMatchObject({
chain_id: BASE,
recipients: [{ recipient: MIHIR, amount: { value: '10' } }]
});
  });
});

it('SQ-CHAT-02 live: a mixed balance question and payment retains the full wallet workflow', async () => {
  await scenario('mixed-request', async (h, calls) => {
    const summary = await h.say('send 10 usdc to mihir on base and show my balance');
    expect(calls[0]?.output).toEqual({ intent: 'wallet' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(h.exec.submissions).toHaveLength(0);
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents[0]).toMatchObject({
chain_id: BASE,
recipients: [{ recipient: MIHIR, amount: { value: '10' } }]
});
  });
});
