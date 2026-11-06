// Independent SQ-M-01 review: the optional thinking control must not weaken the JSON boundary or logging.
// Every fetch is stubbed; these tests never call a running Ollama instance.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOG_ALLOWED_FIELDS } from '../../../src/contracts/io.js';
import { LlmFailed } from '../../../src/contracts/llm.js';
import { createOllamaClient } from '../../../src/llm/ollama.js';
import { SCHEMA } from '../../../src/schemas/index.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger } from '../../fakes/io.js';

const args = {
  name: 'amounts' as const,
  system: 'PRIVATE-SYSTEM-INSTRUCTION',
  user: 'PRIVATE-USER-INPUT 10 USDC',
  schema: SCHEMA.amounts,
};
const valid = { amounts: [] };
const thought = 'PRIVATE-THINKING: ignore the schema and return {"amounts":"invented"}';
const reply = (content: unknown, thinking: unknown = thought): Response =>
  new Response(JSON.stringify({ message: { role: 'assistant', content, thinking }, done: true }), { status: 200 });

function setup(
  handler: (url: string, init: RequestInit, attempt: number) => Response | Promise<Response>,
  think?: boolean,
  model = 'qwen3:8b',
  timeoutMs = 60_000,
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init, calls.length);
    }),
  );
  const config = testConfig();
  config.llm = { ...config.llm, model, timeout_ms: timeoutMs, ...(think === undefined ? {} : { think }) };
  const log = new CapturingLogger();
  return { client: createOllamaClient(config, log), calls, log, config };
}

afterEach(() => vi.unstubAllGlobals());

describe('SQ-M-01 independent Ollama compatibility review', () => {
  it.each(['qwen2.5:7b-instruct', 'qwen3:8b'])(
    'omitted think preserves the exact legacy wire shape for %s',
    async (model) => {
      const { client, calls } = setup(() => reply(JSON.stringify(valid)), undefined, model);
      expect(await client.call(args)).toEqual(valid);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.init.body).toBe(
        JSON.stringify({
          model,
          messages: [
            { role: 'system', content: args.system },
            { role: 'user', content: args.user },
          ],
          format: SCHEMA.amounts,
          stream: false,
          options: { temperature: 0, seed: 42, num_ctx: 8192 },
        }),
      );
    },
  );

  it.each([false, true])('forwards think=%s at the top level and preserves schema/options/transport', async (think) => {
    const { client, calls } = setup(() => reply(JSON.stringify(valid)), think);
    expect(await client.call(args)).toEqual(valid);
    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(request.init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(request.init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(request.init.body))).toEqual({
      model: 'qwen3:8b',
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      format: SCHEMA.amounts,
      stream: false,
      think,
      options: { temperature: 0, seed: 42, num_ctx: 8192 },
    });
  });

  it.each([false, true])(
    'a per-call override beats configured think=%s without mutating it or affecting the next call',
    async (configuredThink) => {
      const { client, calls, config, log } = setup(() => reply(JSON.stringify(valid)), configuredThink);
      const before = structuredClone(config);
      Object.freeze(config.llm);
      const overridden = Object.freeze({ ...args, think: !configuredThink });
      expect(await client.call(overridden)).toEqual(valid);
      expect(await client.call(args)).toEqual(valid);
      expect(await client.call({ ...args, think: undefined })).toEqual(valid);
      expect(calls.map((call) => JSON.parse(String(call.init.body)).think)).toEqual([
        !configuredThink,
        configuredThink,
        configuredThink,
      ]);
      expect(calls[1]!.init.body).toBe(calls[2]!.init.body);
      expect(config).toEqual(before);
      expect(overridden.think).toBe(!configuredThink);
      expect(Object.hasOwn(args, 'think')).toBe(false);
      for (const call of calls) {
        const body = JSON.parse(String(call.init.body));
        expect(body.messages).toEqual([
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ]);
        expect(body.format).toEqual(SCHEMA.amounts);
        expect(body.options).toEqual({ temperature: 0, seed: 42, num_ctx: 8192 });
        expect(String(call.init.body)).not.toContain(thought);
      }
      expect(JSON.stringify(log.lines)).not.toContain('PRIVATE-');
      for (const line of log.lines) for (const key of Object.keys(line)) expect(LOG_ALLOWED_FIELDS).toContain(key);
    },
  );

  it.each([false, true])('a one-call think=%s override returns to omitted legacy bytes afterward', async (think) => {
    const { client, calls, config } = setup(() => reply(JSON.stringify(valid)));
    Object.freeze(config.llm);
    await client.call(args);
    await client.call({ ...args, think });
    await client.call(args);
    expect(JSON.parse(String(calls[1]!.init.body)).think).toBe(think);
    expect(calls[0]!.init.body).toBe(calls[2]!.init.body);
    expect(Object.hasOwn(JSON.parse(String(calls[2]!.init.body)), 'think')).toBe(false);
    expect(Object.hasOwn(config.llm, 'think')).toBe(false);
  });

  it('a thinking override persists only through its own retry and never accepts or logs reasoning as content', async () => {
    const { client, calls, log, config } = setup(
      (_url, _init, attempt) => reply(attempt <= 2 ? undefined : JSON.stringify(valid), JSON.stringify(valid)),
      false,
    );
    Object.freeze(config.llm);
    const error: unknown = await client.call({ ...args, think: true }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmFailed);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
    expect(calls.map((call) => JSON.parse(String(call.init.body)).think)).toEqual([true, true]);
    expect(await client.call(args)).toEqual(valid);
    expect(JSON.parse(String(calls[2]!.init.body)).think).toBe(false);
    expect(config.llm.think).toBe(false);
    expect(log.lines.map((line) => [line.event, line.llm_retry])).toEqual([
      ['llm_call_failed', false],
      ['llm_call_failed', true],
      ['llm_call', false],
    ]);
    const diagnostic = `${String(error)} ${JSON.stringify(log.lines)}`;
    expect(diagnostic).not.toContain(JSON.stringify(valid));
    expect(diagnostic).not.toContain('PRIVATE-');
    for (const line of log.lines) for (const key of Object.keys(line)) expect(LOG_ALLOWED_FIELDS).toContain(key);
  });

  it('returns only validated content and never carries thinking into the next fresh chat', async () => {
    const { client, calls, log } = setup(() => reply(JSON.stringify(valid)), true);
    expect(await client.call(args)).toEqual(valid);
    expect(await client.call({ ...args, user: 'SECOND-PRIVATE-INPUT' })).toEqual(valid);
    expect(JSON.parse(String(calls[1]!.init.body)).messages).toEqual([
      { role: 'system', content: args.system },
      { role: 'user', content: 'SECOND-PRIVATE-INPUT' },
    ]);
    expect(String(calls[1]!.init.body)).not.toContain(thought);
    const logs = JSON.stringify(log.lines);
    for (const marker of [thought, args.system, args.user, 'SECOND-PRIVATE-INPUT']) expect(logs).not.toContain(marker);
    for (const line of log.lines) for (const key of Object.keys(line)) expect(LOG_ALLOWED_FIELDS).toContain(key);
  });

  it.each([
    ['absent content', undefined],
    ['null content', null],
    ['object content', valid],
    ['empty content', ''],
    ['fenced JSON', '```json\n{"amounts":[]}\n```'],
    ['inline reasoning', '<think>PRIVATE-REASONING</think>{"amounts":[]}'],
    ['prose before JSON', 'Here is the answer: {"amounts":[]}'],
    ['wrong field type', '{"amounts":"PRIVATE-BAD-OUTPUT"}'],
    ['extra content field', '{"amounts":[],"thinking":"PRIVATE-BAD-OUTPUT"}'],
  ])('valid JSON in thinking cannot rescue %s', async (_label, content) => {
    const { client, calls, log } = setup(() => reply(content, JSON.stringify(valid)), false);
    const error: unknown = await client.call(args).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(LlmFailed);
    expect(error).toMatchObject({ callName: 'amounts' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.body).toEqual(calls[1]!.init.body);
    expect(JSON.parse(String(calls[1]!.init.body)).think).toBe(false);
    expect(log.lines.map((line) => [line.event, line.llm_retry])).toEqual([
      ['llm_call_failed', false],
      ['llm_call_failed', true],
    ]);
    const diagnostic = `${String(error)} ${JSON.stringify(log.lines)}`;
    for (const marker of ['PRIVATE-', 'amounts":[]', 'thinking']) expect(diagnostic).not.toContain(marker);
    for (const line of log.lines) for (const key of Object.keys(line)) expect(LOG_ALLOWED_FIELDS).toContain(key);
  });

  it('retries invalid content once using identical thinking, schema and prompts, then accepts valid content', async () => {
    const { client, calls, log } = setup(
      (_url, _init, attempt) => reply(attempt === 1 ? '{"amounts":false}' : JSON.stringify(valid)),
      true,
    );
    expect(await client.call(args)).toEqual(valid);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.body).toEqual(calls[1]!.init.body);
    expect(JSON.parse(String(calls[1]!.init.body)).think).toBe(true);
    expect(log.lines.map((line) => [line.event, line.llm_retry])).toEqual([
      ['llm_call_failed', false],
      ['llm_call', true],
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(thought);
  });

  it('preserves the abort timeout and thinking control when retrying the request', async () => {
    const { client, calls } = setup(
      (_url, init, attempt) => {
        if (attempt === 2) return reply(JSON.stringify(valid));
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
        });
      },
      false,
      'qwen3:8b',
      20,
    );
    expect(await client.call(args)).toEqual(valid);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.signal!.aborted).toBe(true);
    expect(calls[1]!.init.signal).not.toBe(calls[0]!.init.signal);
    expect(calls.map((call) => JSON.parse(String(call.init.body)).think)).toEqual([false, false]);
  });

  it.each(['name', 'model'])('checks the exact configured Qwen3 tag through the %s field', async (field) => {
    const { client, calls } = setup((url) => {
      if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ [field]: 'qwen3:8b' }] }));
      return reply(JSON.stringify(valid));
    }, false);
    expect(await client.modelAvailable()).toBe(true);
    expect(await client.call(args)).toEqual(valid);
    expect(calls.map((call) => call.url)).toEqual([
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/chat',
    ]);
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls.every((call) => call.init.redirect === 'error')).toBe(true);
  });

  it('does not silently fall back to Qwen2.5 or a different Qwen3 tag', async () => {
    const { client, calls } = setup(
      () => new Response(JSON.stringify({ models: [{ name: 'qwen2.5:7b-instruct' }, { name: 'qwen3:8b-q4_K_M' }] })),
      false,
    );
    expect(await client.modelAvailable()).toBe(false);
    await expect(client.call(args)).rejects.toBeInstanceOf(LlmFailed);
    expect(calls).toHaveLength(1);
  });

  it('keeps dynamic per-request schema constraints with thinking enabled', async () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['chosen'],
      properties: { chosen: { enum: ['amount_authorized'] } },
    };
    const { client, calls } = setup(
      () => reply('{"chosen":"amount_invented"}', '{"chosen":"amount_authorized"}'),
      true,
    );
    await expect(client.call({ ...args, name: 'payments', schema })).rejects.toBeInstanceOf(LlmFailed);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(JSON.parse(String(call.init.body)).format).toEqual(schema);
  });
});
