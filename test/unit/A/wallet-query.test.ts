import { describe, expect, it } from 'vitest';
import { parseWalletQuery } from '../../../src/session/wallet-query.js';

describe('Local wallet display routing', () => {
  it.each([
    'What is my address?',
    "What's my MetaMask wallet address?",
    'Can you please show me my wallet addresses?',
    'my address',
    '  What  is  my wallet address?  ',
    'What is the address of my wallet?',
    "What's my wallet's address?",
  ])('recognizes an address lookup: %s', (text) => {
    expect(parseWalletQuery(text)).toMatchObject({ address: true, balances: false });
  });

  it('keeps chain and token filters separate when address and balance are requested together', () => {
    expect(parseWalletQuery('What is my wallet address and Base Sepolia USDC balance?')).toMatchObject({
      address: true,
      balances: true,
      chains: [84532],
      tokens: ['USDC'],
      spendable: false,
    });
    expect(parseWalletQuery('How much ETH do I have on Arbitrum?')).toMatchObject({
      address: false,
      balances: true,
      chains: [421614],
      tokens: ['ETH'],
      spendable: false,
    });
    expect(parseWalletQuery('How much can I send?')).toMatchObject({ balances: true, spendable: true });
  });

  it.each([
    'What is my balance and send 10 USDC to Riya?',
    'Show my address, then cancel my autopay',
    'Send my balance to Riya',
    'Change my address to 0x1111111111111111111111111111111111111111',
    "What is Riya's address?",
    'What is my USDT balance?',
    'What is the USDC address?',
    'What is my mainnet balance?',
    'What is my Polygon balance?',
    'Do not show my balance',
    'What is a wallet address?',
    'What is my balance after sending 40 USDC?',
    'Show my address https://example.com',
  ])('leaves mixed, unsupported and contextual messages to normal handling: %s', (text) => {
    expect(parseWalletQuery(text)).toBeNull();
  });
});
