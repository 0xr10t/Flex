// Guard test: C-395 all 35 §15 user messages, exact text, with sample slot values filled.
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import { ERROR_CODES, type ErrorCode } from '../../../src/contracts/types.js';

const CASES: Array<[ErrorCode, Record<string, string>, string]> = [
  [
    'SECRET_DETECTED',
    {},
    "This looks like a private key or recovery phrase. I didn't send or save it anywhere. Never share it; if you pasted it elsewhere, move your funds to a new wallet.",
  ],
  [
    'ATTACHMENT_UNSUPPORTED',
    { filename: 'photo.png' },
    "I can only read text and PDF files. photo.png wasn't read, so nothing was done.",
  ],
  ['URL_FETCH_FAILED', { n: '2' }, "I couldn't open link 2, so nothing was done."],
  ['DOCUMENT_TOO_LARGE', { item: 'pasted text 1' }, 'pasted text 1 is too long for me to read safely.'],
  [
    'BALANCES_UNAVAILABLE',
    { chains: 'Sepolia and Base Sepolia' },
    "I can't read your balances on Sepolia and Base Sepolia right now. Try again in a moment.",
  ],
  ['MAINNET_NOT_SUPPORTED', {}, 'I only work on test networks for now: Sepolia, Base Sepolia and Arbitrum Sepolia.'],
  [
    'UNSUPPORTED_CHAIN',
    { word: 'solana' },
    "I can't use solana. I support Sepolia, Base Sepolia and Arbitrum Sepolia.",
  ],
  ['UNSUPPORTED_TOKEN', {}, 'I can only send USDC and ETH.'],
  [
    'UNSUPPORTED_REQUEST',
    {},
    "I can send USDC or ETH, bridge funds between chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part.",
  ],
  ['SPLIT_UNSUPPORTED', {}, 'Tell me how much each person should get, e.g. "15 to A and 15 to B".'],
  ['RELATIVE_AMOUNT_NOT_ALLOWED', {}, "I can use 'all' or 'half' only for a one-time payment to one person."],
  ['GROUP_AUTOPAY_UNSUPPORTED', {}, "Repeating payments to a whole group aren't supported yet."],
  ['UNTRUSTED_IN_AUTOPAY', {}, 'Repeating payments can only use amounts and addresses you typed or saved yourself.'],
  [
    'CHAIN_CONFLICT',
    { name: 'Aradhya', chain: 'Base Sepolia', other: 'Sepolia' },
    'Aradhya can only be paid on Base Sepolia, but you asked for Sepolia.',
  ],
  ['PAIRING_FAILED', {}, "I couldn't tell which amount goes to whom. Could you rephrase, one payment per line?"],
  ['SELF_PAYMENT', {}, "That's your own address. Moving funds between your own chains isn't a payment I can make."],
  ['ENS_INDEXER_UNAVAILABLE', { parent: 'acme.eth' }, "I can't list the members of acme.eth right now."],
  ['GROUP_EMPTY', { parent: 'acme.eth', chain: 'Base Sepolia' }, 'acme.eth has no members I can pay on Base Sepolia.'],
  ['NO_ACTIVE_AUTOPAY', { name: 'Mihir' }, "There's no active repeating payment to Mihir."],
  ['AUTOPAY_NOT_READY', {}, 'That repeating payment is still being set up. Try again shortly.'],
  ['AUTOPAY_NO_OCCURRENCES', {}, 'That schedule has no payment dates. Check the start and end.'],
  [
    'INSUFFICIENT_FUNDS',
    { token: 'USDC', need: '120', have: '90', chains: 'Sepolia and Base Sepolia' },
    "You don't have enough USDC: you need 120, and can use 90 across Sepolia and Base Sepolia.",
  ],
  [
    'NO_GAS',
    { reserve: '0.001', chain: 'Base Sepolia' },
    'You need at least 0.001 ETH on Base Sepolia for network fees.',
  ],
  ['CHAIN_NOT_ALLOWED', { chain: 'Arbitrum Sepolia' }, "Arbitrum Sepolia isn't in your allowed chains (Settings)."],
  ['LIMIT_PER_TX', { amount: '150', token: 'USDC', max: '100' }, '150 USDC is over your per-payment limit of 100.'],
  [
    'LIMIT_DAILY',
    { token: 'USDC', remaining: '40' },
    "This would go over today's USDC limit. You can still send 40 today.",
  ],
  [
    'LIMIT_AUTOPAY_PERIOD',
    { cap: '150', token: 'USDC', max: '100' },
    'This pays 150 USDC a week, over your autopay limit of 100 a week.',
  ],
  ['LIMIT_AUTOPAY_DURATION', { weeks: '52' }, 'Repeating payments can run for at most 52 weeks.'],
  ['LIMIT_BRIDGES', { n: '3', max: '2' }, 'This needs 3 transfers between chains; your limit is 2.'],
  ['TOO_MANY_RETRIES', {}, "Let's start over. Nothing was sent."],
  ['MODEL_FAILED', {}, "I couldn't understand that right now. Please try again."],
  ['EXECUTION_REJECTED', { message: 'nonce too low' }, "Your wallet couldn't accept this: nonce too low"],
  ['EXECUTION_UNAVAILABLE', {}, "I couldn't reach your wallet. Confirm again to retry."],
  [
    'EXECUTION_UNAVAILABLE',
    { final: 'timeout' },
    "I couldn't confirm your wallet received this after 3 tries. Check your wallet before trying again.",
  ],
  [
    'EXECUTION_UNAVAILABLE',
    { final: 'server_error' },
    "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again later.",
  ],
  ['INTERNAL_ERROR', {}, 'Something went wrong preparing this. Nothing was sent.'],
  ['CANCELLED', {}, 'Cancelled. Nothing was sent.'],
];

describe('C-395 §15 error messages', () => {
  it('C-395 §15: the catalogue has exactly 35 codes, each with a message', () => {
    // SQ-A-06 F-9: two extra EXECUTION_UNAVAILABLE `final` variants, so 37 cases over 35 codes.
    const codes = [...new Set(CASES.map(([c]) => c))].sort();
    expect(codes).toHaveLength(35);
    expect([...ERROR_CODES].sort()).toEqual(codes);
    expect(Object.keys(ERROR_MESSAGE).sort()).toEqual(codes);
  });

  it.each(CASES)('C-395 §15 SQ-A-06 F-7 F-9: %s renders the spec text', (code, params, text) => {
    expect(ERROR_MESSAGE[code](params)).toBe(text);
  });
});
