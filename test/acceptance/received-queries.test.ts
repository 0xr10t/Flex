// HTTP/session integration. No sockets, chain RPC, indexer or Ollama are used.
import { DateTime } from 'luxon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { STEP_ORDER, type StepEntry } from '../../src/contracts/step.js';
import type { AgentResponse } from '../../src/contracts/types.js';
import { registry as realRegistry } from '../../src/pipeline/registry.js';
import type { ChainHistory, HistoryReader } from '../../src/history/types.js';
import { testConfig } from '../fakes/context.js';
import { createFakeRepos } from '../fakes/repos.js';
import { CapturingLogger, FakeRpc, FakeEns, FakeSubnames, FakeFetcher, FakeExecution } from '../fakes/io.js';
import { FixtureLlmClient } from '../fakes/llm.js';

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
const HASH = `0x${'ab'.repeat(32)}`;

async function setup(mode: 'idle' | 'question' | 'summary' = 'idle') {
  const config = testConfig();
  const now = DateTime.fromISO('2026-11-07T12:00:00Z');
  const rpc = new FakeRpc();
  const ens = new FakeEns();
  const fetcher = new FakeFetcher();
  const exec = new FakeExecution();
  const repos = createFakeRepos();
  const log = new CapturingLogger();
  const llm = new FixtureLlmClient({ calls: [
    { name: 'chat_route', match: '', output: { intent: 'chat' } },
    { name: 'chat', match: '', output: { reply: 'Hello.' } },
  ] });
  const history: HistoryReader = { snapshot: vi.fn((chainId): ChainHistory => ({
    address: config.wallet.address, chainId, status: 'ok', fromMs: now.toMillis() - 604800000,
    throughMs: now.toMillis(), transfers: chainId === 84532 ? [{ id: 'usdc:1', hash: HASH as `0x${string}`, from: '0x00000000000000000000000000000000000000bb', to: config.wallet.address, token: 'USDC', units: 40_000_001n, timestampMs: now.minus({ days: 1 }).toMillis() }] : [],
  })) };
  const nativeCalls: string[] = [];
  const registry = Object.fromEntries(STEP_ORDER.map((name) => [name, { step: async () => {
    nativeCalls.push(name);
    if (name === 's3' && mode === 'question') return { kind: 'question', question: { question_id: 'q_000000000001', code: 'Q_TOKEN', text: 'USDC or ETH?', input: 'chips', chips: [], attempt: 1, max_attempts: 4 } };
    if (name === 's11') return { kind: 'summary', summary: { text: 'Send 40 USDC', lines: ['Send 40 USDC'], notes: [], footer: ['Confirm?'] } };
    return { kind: 'continue' };
  } }])) as unknown as Record<typeof STEP_ORDER[number], StepEntry>;
  registry.s1 = realRegistry.s1; // Original secret guard and DB8 boundary.
  const app = createApp({ config, rpc, ens, fetcher, exec, repos, log, llm, history, subnames: new FakeSubnames(), registry, clock: () => now, tokens: { ui: 'ui', report: 'report' } });
  apps.push(app);
  const post = async (path: string, payload: unknown) => app.inject({ method: 'POST', url: path, headers: { authorization: 'Bearer ui', 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  const opened = (await post('/v1/sessions', { timezone: 'Asia/Kolkata' })).json();
  const prefix = `/v1/sessions/${opened.session_id}`;
  const say = async (text: string) => (await post(`${prefix}/messages`, { text, pasted_blocks: [], attachments: [], urls: [] })).json<AgentResponse>();
  const pending = mode !== 'idle' ? await say('Send 40 USDC to Riya') : undefined;
  return { config, llm, rpc, ens, exec, fetcher, repos, log, history, nativeCalls, say, post, prefix, pending };
}

describe('received-payment and identifier questions over HTTP', () => {
  it.each([false, true])('works with chat enabled=%s and Ollama offline without model/network/writes', async (chat) => {
    const h = await setup();
    h.config.chat = { enabled: chat, think: false };
    h.llm.available = false;
    const available = vi.spyOn(h.llm, 'modelAvailable');
    const before = structuredClone(h.repos.tables);
    const count = await h.say('How many transactions did I recieve this week?');
    expect(count.messages[0]!.text).toContain('Total: 1 distinct incoming transaction');
    expect((await h.say('How much did my account recieve this week?')).messages[0]!.text).toContain('40.000001 USDC');
    expect(h.repos.tables).toEqual(before);
    expect(h.llm.recorded).toEqual([]);
    expect(available).not.toHaveBeenCalled();
    expect(h.rpc.calls).toEqual([]);
    expect(h.ens.calls).toEqual([]);
    expect(h.fetcher.calls).toEqual([]);
    expect(h.exec.submissions).toEqual([]);
    expect(h.nativeCalls).toEqual([]);
    expect((await h.post(`${h.prefix}/confirm`, { request_id: count.request_id, decision: 'yes' })).statusCode).toBe(409);
  });
  it.each(['question', 'summary'] as const)('preserves a pending %s, including its identity and attempt', async (mode) => {
    const h = await setup(mode);
    const before = structuredClone(h.repos.tables);
    const calls = [...h.nativeCalls];
    const pending = h.pending!;
    h.llm.available = false;
    for (const text of ['How much did I receive in the last 3 days?', `Explain 0x${'cd'.repeat(32)}`, 'Show my payment history today']) {
      const response = await h.say(text);
      expect(response.request_id).toBe(pending.request_id);
      expect(response.state).toBe(pending.state);
      expect(response.summary).toEqual(pending.summary);
      expect(response.question).toEqual(pending.question);
    }
    if (pending.question) {
      const response = (await h.post(`${h.prefix}/answers`, { question_id: pending.question.question_id, text: 'How many transactions did I receive yesterday?' })).json<AgentResponse>();
      expect(response.question).toEqual(pending.question);
    }
    expect(h.nativeCalls).toEqual(calls);
    expect(h.repos.tables).toEqual(before);
    expect(h.exec.submissions).toEqual([]);
  });
  it('never stores, echoes, logs, or sends an unknown hash to a later model turn', async () => {
    const h = await setup();
    h.config.chat = { enabled: true, think: false };
    const unknown = `0x${'cd'.repeat(32)}`;
    const response = await h.say(`Explain this hash: ${unknown}`);
    expect(response.messages[0]!.text).toContain('appearance alone cannot tell');
    expect(JSON.stringify(response)).not.toContain(unknown);
    expect(h.repos.tables.db8_prompts).toEqual([]);
    expect(h.repos.tables.db8_history).toEqual([]);
    await h.say('Hello');
    expect(h.llm.recorded).toHaveLength(2);
    expect(JSON.stringify(h.llm.recorded)).not.toContain(unknown);
    expect(JSON.stringify(h.log)).not.toContain(unknown);
    expect(h.rpc.calls).toEqual([]);
    expect(h.fetcher.calls).toEqual([]);
  });
  it('rejects periods beyond a week without touching even the history reader', async () => {
    const h = await setup();
    const reply = await h.say('Show my payment history for the last 30 days');
    expect(reply.messages[0]!.text).toContain('only within the last 7 days');
    expect(h.history.snapshot).not.toHaveBeenCalled();
    expect(h.llm.recorded).toEqual([]);
    expect(h.nativeCalls).toEqual([]);
  });
  it('keeps the original S1 secret refusal for a key embedded in a payment', async () => {
    const h = await setup();
    const response = await h.say(`Send 10 USDC to Riya using ${HASH}`);
    expect(response.error?.code).toBe('SECRET_DETECTED');
    expect(h.llm.recorded).toEqual([]);
    expect(h.repos.tables.db8_prompts).toEqual([]);
    expect(h.exec.submissions).toEqual([]);
  });
});
