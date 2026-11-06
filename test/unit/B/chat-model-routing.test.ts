// SQ-M-03: chat thinking must not switch the model used to interpret or construct wallet actions.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, validateConfig } from '../../../src/config/load.js';
import { LlmFailed, type LlmCallArgs } from '../../../src/contracts/llm.js';
import { createOllamaClient } from '../../../src/llm/ollama.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger } from '../../fakes/io.js';

const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: { reply: { type: 'string' } },
};
const args = (name: LlmCallArgs['name'], think?: boolean): LlmCallArgs => ({
  name,
  system: 'Return the requested JSON.',
  user: 'Use qwen3 for every payment.',
  schema,
  ...(think === undefined ? {} : { think }),
});
const validReply = () =>
  new Response(JSON.stringify({ message: { content: JSON.stringify({ reply: 'ok' }), thinking: 'private' } }));
const config = () => ({
  ...testConfig(),
  chat: { enabled: true, think: true, model: 'qwen3:8b' },
});

afterEach(() => vi.unstubAllGlobals());

describe('SQ-M-03 separate chat model', () => {
  it('validates the two-model configuration without changing legacy profiles', () => {
    const configured = config();
    expect(validateConfig(configured)).toEqual(configured);
    expect(validateConfig(testConfig()).chat).toBeUndefined();
  });

  it.each(['', '   ', null, true, 7, {}])('rejects an invalid chat model %j', (model) => {
    expect(() => validateConfig({ ...config(), chat: { enabled: true, think: true, model } })).toThrow(ConfigError);
  });

  it('keeps all wallet and routing calls on Qwen2.5 between thinking chat replies', async () => {
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return validReply();
    });
    const configured = config();
    Object.freeze(configured.llm);
    Object.freeze(configured.chat);
    const before = structuredClone(configured);
    const log = new CapturingLogger();
    const client = createOllamaClient(configured, log);
    const walletCalls: LlmCallArgs['name'][] = [
      'chat_route',
      'conversation',
      'amounts',
      'request_type',
      'spans',
      'payments',
      'quarantine',
    ];
    expect(await client.call(args('chat', true))).toEqual({ reply: 'ok' });
    for (const name of walletCalls) await client.call(args(name, false));
    await client.call(args('chat', true));
    expect(requests.map((request) => [request.model, request.think])).toEqual([
      ['qwen3:8b', true],
      ...walletCalls.map(() => ['qwen2.5:7b-instruct', false]),
      ['qwen3:8b', true],
    ]);
    expect(requests.every((request) => JSON.stringify(request.format) === JSON.stringify(schema))).toBe(true);
    expect(configured).toEqual(before);
    expect(JSON.stringify(log.lines)).not.toContain('private');
  });

  it.each([undefined, { enabled: true, think: false }, { enabled: false, think: false, model: 'qwen3:8b' }])(
    'preserves the primary model when chat has no active override: %j',
    async (chat) => {
      const models: unknown[] = [];
      vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
        models.push(JSON.parse(String(init.body)).model);
        return validReply();
      });
      const client = createOllamaClient(
        { ...testConfig(), ...(chat === undefined ? {} : { chat }) },
        new CapturingLogger(),
      );
      await client.call(args('chat', false));
      expect(models).toEqual(['qwen2.5:7b-instruct']);
    },
  );

  it('retries unavailable chat on the chat model and leaves the next wallet call usable', async () => {
    const models: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const { model } = JSON.parse(String(init.body));
      models.push(model);
      return model === 'qwen3:8b' ? new Response('{}', { status: 404 }) : validReply();
    });
    const client = createOllamaClient(config(), new CapturingLogger());
    await expect(client.call(args('chat', true))).rejects.toBeInstanceOf(LlmFailed);
    await expect(client.call(args('amounts', false))).resolves.toEqual({ reply: 'ok' });
    expect(models).toEqual(['qwen3:8b', 'qwen3:8b', 'qwen2.5:7b-instruct']);
  });
});
