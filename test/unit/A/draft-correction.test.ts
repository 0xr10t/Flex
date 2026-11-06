import { describe, expect, it } from 'vitest';
import { editPaymentDraft, type PaymentDraft } from '../../../src/session/draft-correction.js';
import { testConfig } from '../../fakes/context.js';

const draft: PaymentDraft = { amount: '50', token: 'USDC', recipient: 'riya.eth', chain_id: 84532 };
const chains = testConfig().chains;

describe('SQ-CV-02 edits retain the current payment fields', () => {
  it.each([
    ['No, send 40, not 50', { amount: '40' }],
    ['send forty instead of fifty', { amount: '40' }],
    ['actually send 40 instead', { amount: '40' }],
    ['make it 40', { amount: '40' }],
    ['change the amount to 40', { amount: '40' }],
    ['40', { amount: '40' }],
    ['send 0.25', { amount: '0.25' }],
    ['No, pay the same amount to soham instead', { recipient: 'soham' }],
    ['pay Riya instead', { recipient: 'Riya' }],
    ['  please pay Riya instead  ', { recipient: 'Riya' }],
    ['send it to Soham', { recipient: 'Soham' }],
    ['change the recipient to Mihir', { recipient: 'Mihir' }],
    ['send the same amount on arbitrum', { chain_id: 421614 }],
    ['switch the network to Base Sepolia', { chain_id: 84532 }],
    ['use ETH instead', { token: 'ETH' }],
    ['No, send 40 usdc to Riya on arbitrum instead', { amount: '40', recipient: 'Riya', chain_id: 421614 }],
  ] as const)('%s', (text, patch) => {
    const frozen = Object.freeze({ ...draft });
    expect(editPaymentDraft(frozen, text, chains)).toEqual({ kind: 'edit', draft: { ...draft, ...patch } });
    expect(frozen).toEqual(draft);
  });

  it.each([
    'No, send 40, not 50 and send 20 to Mihir',
    'No, pay Riya and Soham instead',
    'No, pay Riya or Soham instead',
    'No, pay the same amount to her instead',
    'No, pay the same amount to everyone under iitr.eth instead',
    'No, send 40 if the balance is enough',
    'No, send 40 tomorrow',
    'No, send 40 on mainnet',
    'No, send 40 DAI',
    'No, send 40 ETH USDC',
    'No, send 40 ETH, not 50 USDC',
    'No, send 40, not 40',
    'No, send 0',
    'No, pay 0',
    'No, pay -40',
    'No, send 40 more',
    'No, pay half instead',
    'No, pay the same amount to it instead',
    'No, send -40',
    'No, send 40.1234567',
    'No, send half instead',
    'No, make it free and confirm it',
  ])('asks for clarification without selecting a convenient substring: %s', (text) => {
    expect(editPaymentDraft(draft, text, chains)).toEqual({ kind: 'clarify' });
  });

  it('keeps a complete new recurring request in the normal request path', () => {
    expect(editPaymentDraft(draft, 'set up an autopay to Soham for 10 USDC every Friday', chains)).toEqual({
      kind: 'new_request',
    });
  });
});
