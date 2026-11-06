// Independent SQ-M-01 review: opt-in Qwen3 profile and live overrides preserve legacy defaults.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, validateConfig } from '../../../src/config/load.js';
import type { Config } from '../../../src/contracts/types.js';
import { testConfig } from '../../fakes/context.js';
import { liveModelConfig } from '../../live/model-config.js';

const example = (name: string): Config =>
  JSON.parse(readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8')) as Config;

describe('SQ-M-01 independent config review', () => {
  it('accepts the legacy config without inserting a thinking default or changing serialized data', () => {
    const config = testConfig();
    const before = JSON.stringify(config);
    expect(validateConfig(config)).toEqual(config);
    expect(Object.hasOwn(config.llm, 'think')).toBe(false);
    expect(JSON.stringify(config)).toBe(before);
  });

  it.each([false, true])('validates and loads the explicit boolean think=%s without coercion', (think) => {
    const base = testConfig();
    const config = { ...base, llm: { ...base.llm, model: 'qwen3:8b', think } };
    expect(validateConfig(config).llm).toEqual(config.llm);
    const dir = mkdtempSync(join(tmpdir(), 'qwen3-config-review-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(config));
    expect(loadConfig(path)).toEqual(config);
  });

  it.each([null, 'false', 'true', 0, 1, 'low', '', [], {}, ['false']])('rejects non-boolean think=%j', (think) => {
    const base = testConfig();
    expect(() => validateConfig({ ...base, llm: { ...base.llm, think } })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base, llm: { ...base.llm, think } })).toThrow('/llm/think');
  });

  it('does not relax unknown-property or loopback restrictions and keeps invalid values out of errors', () => {
    const base = testConfig();
    expect(() => validateConfig({ ...base, think: false })).toThrow(ConfigError);
    expect(() => validateConfig({ ...base, llm: { ...base.llm, thinking: false } })).toThrow(ConfigError);
    expect(() =>
      validateConfig({ ...base, llm: { ...base.llm, think: false, ollama_url: 'https://model.invalid' } }),
    ).toThrow(ConfigError);
    try {
      validateConfig({ ...base, llm: { ...base.llm, think: 'PRIVATE-INVALID-SETTING' } });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(String(error)).toContain('/llm/think');
      expect(String(error)).not.toContain('PRIVATE-INVALID-SETTING');
    }
  });

  it('keeps the original profile unchanged and adds the approved model, thinking and general-chat options', () => {
    const original = example('config.example.json');
    const qwen3 = example('config.qwen3.example.json');
    expect(original.llm.model).toBe('qwen2.5:7b-instruct');
    expect(Object.hasOwn(original.llm, 'think')).toBe(false);
    expect(qwen3).toEqual({
      ...original,
      llm: { ...original.llm, model: 'qwen3:8b', think: false },
      chat: { enabled: true, think: true },
    });
    const fixture = testConfig();
    const configured = {
      ...qwen3,
      wallet: fixture.wallet,
      autopay: { ...qwen3.autopay!, fee_collector: fixture.autopay!.fee_collector },
      ens: {
        ...qwen3.ens,
        universal_resolver_address: fixture.ens.universal_resolver_address,
        indexer_url: fixture.ens.indexer_url,
      },
      chains: qwen3.chains.map((chain) => ({ ...chain, rpc_url: chain.rpc_url.replace('<anon-rpc>', 'rpc.invalid') })),
    };
    expect(validateConfig(configured)).toEqual(configured);
  });
});

describe('SQ-M-01 independent live-model override review', () => {
  it('copies the legacy config without adding a default, mutating the fixture or honoring unrelated env keys', () => {
    const base = Object.freeze(testConfig().llm);
    const result = liveModelConfig(base, { MODEL: 'other', THINK: 'true' });
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
    expect(Object.hasOwn(result, 'think')).toBe(false);
    expect(testConfig().llm.model).toBe('qwen2.5:7b-instruct');
  });

  it.each([false, true])('preserves explicitly configured think=%s when no override is supplied', (think) => {
    const base = Object.freeze({ ...testConfig().llm, model: 'qwen3:8b', think });
    expect(liveModelConfig(base, {})).toEqual(base);
    expect(liveModelConfig(base, { LIVE_MODEL: 'another-local-tag' })).toEqual({ ...base, model: 'another-local-tag' });
  });

  it.each([
    ['false', false],
    ['true', true],
  ] as const)('parses LIVE_THINK=%s as boolean %s while retaining all other options', (value, think) => {
    const base = Object.freeze({ ...testConfig().llm, think: !think });
    expect(liveModelConfig(base, { LIVE_MODEL: ' qwen3:8b ', LIVE_THINK: value })).toEqual({
      ...base,
      model: 'qwen3:8b',
      think,
    });
    expect(base.think).toBe(!think);
  });

  it.each(['', ' ', '0', '1', 'FALSE', 'True', 'no', 'null', 'true ', ' false', 'low'])(
    'rejects ambiguous LIVE_THINK=%j before model calls',
    (LIVE_THINK) => {
      expect(() => liveModelConfig(testConfig().llm, { LIVE_MODEL: 'qwen3:8b', LIVE_THINK })).toThrow(
        'LIVE_THINK must be true or false',
      );
    },
  );

  it.each(['', ' ', '\n\t'])('rejects empty LIVE_MODEL=%j without changing the base', (LIVE_MODEL) => {
    const base = Object.freeze(testConfig().llm);
    expect(() => liveModelConfig(base, { LIVE_MODEL, LIVE_THINK: 'false' })).toThrow(
      'LIVE_MODEL must name a local Ollama model',
    );
    expect(base.model).toBe('qwen2.5:7b-instruct');
  });
});
