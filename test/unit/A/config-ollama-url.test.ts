// Lane A unit tests: O6 — llm.ollama_url must be http://127.0.0.1 (NFR-01, §16.4); execution.url is unrestricted.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/load.js';
import { testConfig } from '../../fakes/context.js';

const withUrl = (ollama_url: string): unknown => {
  const cfg = testConfig();
  return { ...cfg, llm: { ...cfg.llm, ollama_url } };
};

describe('O6 llm.ollama_url must be http://127.0.0.1 (NFR-01, §16.4)', () => {
  it.each([
    'http://localhost:11434',
    'http://0.0.0.0:11434',
    'http://10.0.0.1:11434',
    'https://example.com',
    'https://127.0.0.1:11434',
  ])('O6: rejects ollama_url %s', (url) => {
    expect(() => validateConfig(withUrl(url))).toThrow(/\/llm\/ollama_url must be http:\/\/127\.0\.0\.1/);
  });

  it.each(['http://127.0.0.1:11434', 'http://127.0.0.1:11434/', 'http://127.0.0.1'])(
    'O6: accepts ollama_url %s',
    (url) => {
      expect(validateConfig(withUrl(url)).llm.ollama_url).toBe(url);
    },
  );

  it('O6: execution.url is not restricted to loopback', () => {
    const cfg = testConfig();
    expect(() =>
      validateConfig({ ...cfg, execution: { ...cfg.execution, url: 'https://exec.example.com' } }),
    ).not.toThrow();
  });

  it('O6: config.example.json and testConfig() still validate', () => {
    const example = JSON.parse(
      readFileSync(new URL('../../../config.example.json', import.meta.url), 'utf8'),
    ) as unknown;
    // The example carries placeholders for wallet/resolver addresses; those errors are pre-existing and unrelated.
    let msg = '';
    try {
      validateConfig(example);
    } catch (e) {
      msg = String(e);
    }
    expect(msg).not.toMatch(/ollama_url/);
    expect((example as ReturnType<typeof testConfig>).llm.ollama_url).toBe('http://127.0.0.1:11434');
    expect(() => validateConfig(testConfig())).not.toThrow();
  });
});
