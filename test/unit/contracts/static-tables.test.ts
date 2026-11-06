// Guard test: C-005 §6.2 static tables (src/contracts/static-tables.ts) hold the spec's words verbatim.
import { describe, expect, it } from 'vitest';
import {
  BACK_REFERENCE_WORDS,
  CANCEL_WORDS,
  DISTRIBUTIVE_WORDS,
  GROUP_MARKERS,
  MAINNET_WORDS,
  RECURRENCE_WORDS,
  SPLIT_WORDS,
  TOKENS,
  UNSUPPORTED_TOKEN_EXAMPLES,
} from '../../../src/contracts/static-tables.js';

describe('C-005 §6.2 static tables', () => {
  it('C-005 §6.2: USDC decimals 6 non-native with aliases usdc, usd coin, usdc.e, dollars', () => {
    expect(TOKENS.USDC).toEqual({
      decimals: 6,
      native: false,
      aliases: ['usdc', 'usd coin', 'usdc.e', 'dollars'],
    });
  });
  it('C-005 §6.2: ETH decimals 18 native with aliases eth, ether, ethereum', () => {
    expect(TOKENS.ETH).toEqual({ decimals: 18, native: true, aliases: ['eth', 'ether', 'ethereum'] });
    expect(Object.keys(TOKENS).sort()).toEqual(['ETH', 'USDC']);
  });
  it('C-005 §6.2: unsupported-token examples', () => {
    expect(UNSUPPORTED_TOKEN_EXAMPLES).toEqual(['dai', 'usdt', 'weth', 'matic', 'sol', 'btc']);
  });
  it('C-005 §6.2: mainnet words', () => {
    expect(MAINNET_WORDS).toEqual([
      'mainnet',
      'base mainnet',
      'arbitrum one',
      'ethereum mainnet',
      'polygon',
      'optimism',
      'bsc',
    ]);
  });
  it('C-005 §6.2: recurrence words', () => {
    expect(RECURRENCE_WORDS).toEqual([
      'every',
      'each (day|week|month|monday…)',
      'daily',
      'weekly',
      'monthly',
      'per (day|week|month)',
      '(\\d+|one|two|three…) times a (week|day|month)',
      'fortnightly',
    ]);
  });
  it('C-005 §6.2: cancel words', () => {
    expect(CANCEL_WORDS).toEqual(['stop', 'cancel', 'end', 'terminate', 'turn off']);
  });
  it('C-005 §6.2: back-reference words', () => {
    expect(BACK_REFERENCE_WORDS).toEqual([
      'more',
      'again',
      'same',
      'another',
      'her',
      'him',
      'them',
      'they',
      'same person',
    ]);
  });
  it('C-005 §6.2: distributive words', () => {
    expect(DISTRIBUTIVE_WORDS).toEqual(['each', 'apiece', 'every one', 'per person', 'both']);
  });
  it('C-005 §6.2: split words', () => {
    expect(SPLIT_WORDS).toEqual(['split', 'divide', 'share between', 'share among']);
  });
  it('C-005 §6.2: group markers', () => {
    expect(GROUP_MARKERS).toEqual([
      'everyone under',
      'everyone in',
      'all of',
      'all members of',
      'everyone with @',
      'everyone at @',
      '@<domain>',
    ]);
  });
});
