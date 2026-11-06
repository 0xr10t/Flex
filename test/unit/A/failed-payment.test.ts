// SQ-S-01: code-only recognition of a fresh amount correction; unknown/ambiguous instructions cannot inherit
// a previous payment. The HTTP regressions exercise capture, pipeline validation, confirmation and session clearing.
import { describe, expect, it } from 'vitest';
import type { MessageInput } from '../../../src/contracts/types.js';
import { isAmountCorrection } from '../../../src/session/failed-payment.js';
import { testConfig } from '../../fakes/context.js';

const chains = testConfig().chains;
const input = (text: string, extra: Partial<MessageInput> = {}): MessageInput => ({
  text,
  pasted_blocks: [],
  attachments: [],
  urls: [],
  ...extra,
});

describe('SQ-S-01 amount correction grammar', () => {
  it.each([
    'ok no worries, send 70',
    'Okay, no problem. Send 70 instead.',
    'send 70',
    'please pay seventy',
    'actually transfer just 70.05 USDC instead',
    'then send 0.01 eth on base please',
    'send seventy USDC on Arbitrum Sepolia',
    'send 1,000.5 usdc via arb',
    'send one hundred and five instead on base testnet',
    'send 0.000000000000000001 ETH',
    'send $70',
    'send USDC 70',
  ])('accepts one new amount with optional explicit token/chain: %s', (text) => {
    expect(isAmountCorrection(input(text), chains)).toBe(true);
  });

  it.each([
    'send 70 to Mihir',
    'send 70 to someone else',
    'send 70 to aradhya.eth',
    'send 70 to everyone under team.eth',
    'send 70 to 0x1111111111111111111111111111111111111111',
    'send 70 and 10',
    'send 70 usdc and 0.01 eth',
    'send 70 USDC ETH',
    'send $70 ETH',
    'send 70 usdc usdc',
    'send one hundred usdc and five',
    'send 70 every Friday',
    'send 70 tomorrow',
    'send 70 each',
    'send 70 unless it costs more',
    'do not send 70',
    'cancel; send 70',
    'send 70 then cancel',
    'send all',
    'send half my usdc',
    'send -70',
    'send 0',
    'send 70 on mainnet',
    'send 70 on base or arbitrum',
    'send 70 https://example.com/invoice',
    'how much would it cost to send 70?',
    'send it',
    'yes',
  ])('leaves ambiguous or changed instructions to the ordinary pipeline: %s', (text) => {
    expect(isAmountCorrection(input(text), chains)).toBe(false);
  });

  it.each([
    { pasted_blocks: ['Pay someone else'] },
    { attachments: [{ filename: 'invoice.txt', mime: 'text/plain', base64: 'aW52b2ljZQ==' }] },
    { urls: ['https://example.com/invoice'] },
  ])('does not inherit details when content is attached: %j', (extra) => {
    expect(isAmountCorrection(input('send 70', extra), chains)).toBe(false);
  });
});
