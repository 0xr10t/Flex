import { describe, expect, it } from 'vitest';
import { isTransactionStatusQuery } from '../../../src/session/transaction-status.js';

describe('read-only transaction status grammar', () => {
  it.each([
    'did the transaction go through?',
    'Did it go through?',
    'Has my payment gone through?',
    'Was the transfer successful?',
    'Is my last transaction confirmed?',
    'Has it been sent?',
    'Has it been confirmed yet?',
    'Did it fail?',
    'Did you broadcast it?',
    'What is the status of my transaction?',
    "What's my payment's status?",
    'Can you please check if the payment went through?',
    'Please show me the transaction status.',
    'Any updates on it?',
    'What happened to my payment?',
    'transaction status',
  ])('recognizes %s', (text) => expect(isTransactionStatusQuery(text)).toBe(true));

  it.each([
    'Did it go through? If not, send it again.',
    'Did it fail? Retry it',
    'Check my payment status and send 10 USDC to Riya',
    'Cancel the pending transaction',
    'Send the transaction',
    "Is Riya's payment confirmed?",
    'Is my payment to Riya confirmed?',
    'Is my transaction on Polygon confirmed?',
    'Show my transaction history',
    'Did the transaction go through https://example.com?',
    `Is transaction 0x${'ab'.repeat(32)} confirmed?`,
    'What does transaction confirmed mean?',
  ])('leaves actions and other targets to normal handling: %s', (text) =>
    expect(isTransactionStatusQuery(text)).toBe(false),
  );
});
