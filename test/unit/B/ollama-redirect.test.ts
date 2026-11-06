// Tests: O6 — the Ollama client passes redirect:'error' on /api/tags and /api/chat (NFR-01, §16.4); a redirect
// (fetch throws TypeError) takes the failure path. No network: global fetch is stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmFailed } from '../../../src/contracts/llm.js';
import { createOllamaClient } from '../../../src/llm/ollama.js';
import { SCHEMA } from '../../../src/schemas/index.js';
import { testConfig } from '../../fakes/context.js';
import { CapturingLogger } from '../../fakes/io.js';

const args = { name: 'amounts' as const, system: 'SYS', user: 'USR', schema: SCHEMA.amounts };

function setup(handler: (url: string) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url));
    }),
  );
  return { client: createOllamaClient(testConfig(), new CapturingLogger()), calls };
}

const redirect = (): never => {
  throw new TypeError('fetch failed: unexpected redirect');
};

afterEach(() => vi.unstubAllGlobals());

describe("O6 redirect:'error' (NFR-01, §16.4)", () => {
  it("O6: /api/chat passes redirect:'error'; a redirect is retried once then LlmFailed", async () => {
    const { client, calls } = setup(redirect);
    await expect(client.call(args)).rejects.toBeInstanceOf(LlmFailed);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe('http://127.0.0.1:11434/api/chat');
      expect(c.init.redirect).toBe('error');
    }
  });

  it("O6: /api/tags passes redirect:'error'; a redirect makes modelAvailable() false", async () => {
    const { client, calls } = setup(redirect);
    expect(await client.modelAvailable()).toBe(false);
    expect(calls[0]?.url).toBe('http://127.0.0.1:11434/api/tags');
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it("O6: a successful /api/tags and /api/chat both carry redirect:'error'", async () => {
    const cfg = testConfig();
    const { client, calls } = setup((url) =>
      url.endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [{ name: cfg.llm.model }] }), { status: 200 })
        : new Response(JSON.stringify({ message: { role: 'assistant', content: '{"amounts":[]}' } }), {
            status: 200,
          }),
    );
    expect(await client.modelAvailable()).toBe(true);
    await client.call(args);
    expect(calls.map((c) => c.init.redirect)).toEqual(['error', 'error']);
  });
});
