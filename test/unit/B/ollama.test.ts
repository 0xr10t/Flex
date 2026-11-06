// Tests: §14.4 Ollama client — C-355 (POST /api/chat request shape, message.content parsed, Ajv-validated),
// C-356 (startup GET /api/tags: model missing → modelAvailable() false and every call fails), C-146 (temperature,
// seed, format=schema, stream false), C-147 (one retry on HTTP error / timeout / schema-invalid output, second
// failure → LlmFailed), §18 (llm_call logs carry allowlisted fields only, never prompt text). No network: global
// fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_ALLOWED_FIELDS } from '../../../src/contracts/io.js';
import { LlmFailed } from '../../../src/contracts/llm.js';
import { createOllamaClient } from '../../../src/llm/ollama.js';
import { SCHEMA } from '../../../src/schemas/index.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger } from '../../fakes/io.js';
import { expectLabelsOk } from './helpers.js';

const VALID = { amounts: [] };
const chatOk = (content: unknown): Response =>
  new Response(
    JSON.stringify({
      message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content) },
    }),
    { status: 200 },
  );
const args = {
  name: 'amounts' as const,
  system: 'SYS-SECRET-PROMPT',
  user: 'USER-SECRET-PROMPT 5 usdc',
  schema: SCHEMA.amounts,
};

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>, timeout_ms = 60000) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }),
  );
  const cfg = testConfig();
  cfg.llm.timeout_ms = timeout_ms;
  const log = new CapturingLogger();
  return { client: createOllamaClient(cfg, log), calls, log, cfg };
}

afterEach(() => vi.unstubAllGlobals());

describe('Ollama client call (§14.4, §8.10)', () => {
  it('C-355/C-146: POST {ollama_url}/api/chat with model, [system,user], format=schema, stream false, options', async () => {
    const { client, calls, cfg } = setup(() => chatOk(VALID));
    const out = await client.call<typeof VALID>(args);
    expect(out).toEqual(VALID);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: cfg.llm.model,
      messages: [
        { role: 'system', content: 'SYS-SECRET-PROMPT' },
        { role: 'user', content: 'USER-SECRET-PROMPT 5 usdc' },
      ],
      format: SCHEMA.amounts,
      stream: false,
      options: { temperature: 0, seed: 42, num_ctx: 8192 },
    });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('C-147: HTTP error → one retry → success; logs llm_call with llm_call and llm_retry', async () => {
    let n = 0;
    const { client, calls, log } = setup(() => (++n === 1 ? new Response('boom', { status: 500 }) : chatOk(VALID)));
    expect(await client.call(args)).toEqual(VALID);
    expect(calls).toHaveLength(2);
    const ok = log.lines.filter((l) => l.event === 'llm_call');
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ llm_call: 'amounts', llm_retry: true });
    expect(typeof ok[0]?.duration_ms).toBe('number');
    expectLabelsOk({ log } as never);
  });

  it('C-147: first-attempt success logs llm_retry false', async () => {
    const { client, log } = setup(() => chatOk(VALID));
    await client.call(args);
    expect(log.lines.find((l) => l.event === 'llm_call')).toMatchObject({ llm_call: 'amounts', llm_retry: false });
  });

  it('C-147: timeout (llm.timeout_ms, signal aborts the request) → one retry', async () => {
    let n = 0;
    const { client, calls } = setup((_u, init) => {
      if (++n === 1) {
        return new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(init.signal?.reason ?? new Error('aborted')));
        });
      }
      return chatOk(VALID);
    }, 40);
    expect(await client.call(args)).toEqual(VALID);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ['schema-invalid JSON', '{"amounts":"nope"}'],
    ['extra property', '{"amounts":[],"x":1}'],
    ['not JSON', 'sure! here you go'],
  ])('C-147: %s output → one retry', async (_n, bad) => {
    let n = 0;
    const { client, calls } = setup(() => (++n === 1 ? chatOk(bad) : chatOk(VALID)));
    expect(await client.call(args)).toEqual(VALID);
    expect(calls).toHaveLength(2);
  });

  it('C-147: second failure → LlmFailed carrying the call name; exactly two requests', async () => {
    const { client, calls, log } = setup(() => new Response('x', { status: 503 }));
    const err = await client.call(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmFailed);
    expect((err as LlmFailed).callName).toBe('amounts');
    expect(calls).toHaveLength(2);
    expect(log.lines.filter((l) => l.event === 'llm_call')).toHaveLength(0);
  });

  it('C-147: error then invalid output → LlmFailed', async () => {
    let n = 0;
    const { client } = setup(() => (++n === 1 ? new Response('x', { status: 500 }) : chatOk({ amounts: 5 })));
    await expect(client.call(args)).rejects.toBeInstanceOf(LlmFailed);
  });

  it('§18: log lines use allowlisted fields only and never contain prompt text or model output', async () => {
    let n = 0;
    const { client, log } = setup(() => (++n === 1 ? chatOk('{"amounts":"SECRET-OUT"}') : chatOk(VALID)));
    await client.call(args);
    await client.call({ ...args, system: 'S2', user: 'U2-SECRET' }).catch(() => undefined);
    for (const l of log.lines) for (const k of Object.keys(l)) expect(LOG_ALLOWED_FIELDS, k).toContain(k);
    const all = JSON.stringify(log.lines);
    for (const s of ['SYS-SECRET-PROMPT', 'USER-SECRET-PROMPT', 'SECRET-OUT', 'U2-SECRET'])
      expect(all).not.toContain(s);
  });

  it('every call is a fresh chat: a second call sends only its own two messages', async () => {
    const { client, calls } = setup(() => chatOk(VALID));
    await client.call(args);
    await client.call({ ...args, user: 'second' });
    const second = JSON.parse(String(calls[1]?.init.body)) as { messages: unknown[] };
    expect(second.messages).toHaveLength(2);
  });
});

describe('Ollama startup check (§14.4, C-356)', () => {
  const tags = (...names: string[]): Response =>
    new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });

  it('model listed in GET /api/tags → true', async () => {
    const { client, calls } = setup(() => tags('llama3:8b', 'qwen2.5:7b-instruct'));
    expect(await client.modelAvailable()).toBe(true);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/tags');
    expect(calls[0]?.init.method ?? 'GET').toBe('GET');
  });

  it('model missing → false, and every later call throws LlmFailed without contacting /api/chat', async () => {
    const { client, calls } = setup((url) => (url.endsWith('/api/tags') ? tags('llama3:8b') : chatOk(VALID)));
    expect(await client.modelAvailable()).toBe(false);
    await expect(client.call(args)).rejects.toBeInstanceOf(LlmFailed);
    await expect(client.call(args)).rejects.toBeInstanceOf(LlmFailed);
    expect(calls.filter((c) => c.url.endsWith('/api/chat'))).toHaveLength(0);
  });

  it('tags HTTP error or unreachable Ollama → false (and calls fail)', async () => {
    const a = setup(() => new Response('x', { status: 500 }));
    expect(await a.client.modelAvailable()).toBe(false);
    await expect(a.client.call(args)).rejects.toBeInstanceOf(LlmFailed);
    vi.unstubAllGlobals();
    const b = setup(() => {
      throw new Error('ECONNREFUSED');
    });
    expect(await b.client.modelAvailable()).toBe(false);
  });

  it('a name that merely contains the model name does not count', async () => {
    const { client } = setup(() => tags('qwen2.5:7b-instruct-q4'));
    expect(await client.modelAvailable()).toBe(false);
  });
});
