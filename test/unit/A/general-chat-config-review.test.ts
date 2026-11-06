import { describe, expect, it } from 'vitest';
import { ConfigError, validateConfig } from '../../../src/config/load.js';
import { testConfig } from '../../fakes/context.js';
import { liveChatConfig } from '../../live/model-config.js';

describe('SQ-CHAT-01 independent opt-in config review', () => {
  it('leaves absent chat config absent for legacy installations', () => {
    const config = testConfig();
    expect(Object.hasOwn(validateConfig(config), 'chat')).toBe(false);
  });

  it.each([
    { enabled: true, think: true },
    { enabled: true, think: false },
    { enabled: false, think: true },
    { enabled: false, think: false },
  ])('validates explicit chat settings without changing wallet thinking: %j', (chat) => {
    const config = { ...testConfig(), chat };
    expect(validateConfig(config)).toEqual(config);
    expect(Object.hasOwn(config.llm, 'think')).toBe(false);
  });

  it.each([
    null,
    true,
    [],
    {},
    { enabled: true },
    { think: true },
    { enabled: 'true', think: true },
    { enabled: true, think: 'false' },
    { enabled: 1, think: false },
    { enabled: true, think: null },
    { enabled: true, think: true, tool: 'send' },
  ])('rejects invalid chat config %j', (chat) => {
    expect(() => validateConfig({ ...testConfig(), chat })).toThrow(ConfigError);
  });

  it('copies supplied live config on omission and preserves the absence of the legacy config', () => {
    expect(liveChatConfig(undefined, {})).toBeUndefined();
    const base = Object.freeze({ enabled: true, think: false });
    const result = liveChatConfig(base, {});
    expect(result).toEqual(base);
    expect(result).not.toBe(base);
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('LIVE_CHAT=%s selects an isolated explicit profile', (LIVE_CHAT, enabled) => {
    const base = Object.freeze({ enabled: !enabled, think: false });
    expect(liveChatConfig(base, { LIVE_CHAT })).toEqual({ enabled, think: true });
    expect(liveChatConfig(undefined, { LIVE_CHAT })).toEqual({ enabled, think: true });
    expect(base).toEqual({ enabled: !enabled, think: false });
    expect(testConfig().chat).toBeUndefined();
  });

  it.each(['', ' ', '1', '0', 'TRUE', 'False', 'yes', 'null', 'true ', ' false'])(
    'rejects ambiguous LIVE_CHAT=%j',
    (LIVE_CHAT) => {
      expect(() => liveChatConfig(undefined, { LIVE_CHAT })).toThrow('LIVE_CHAT must be true or false');
    },
  );
});
