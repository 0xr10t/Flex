import { describe, expect, it } from 'vitest';
import { buildQuestion } from '../../../src/contracts/catalog.js';
import type { QuestionCode, QuestionId } from '../../../src/contracts/types.js';
import {
  answerOnlyReply,
  interpretReply,
  needsConversation,
  recipientOnlyReply,
} from '../../../src/session/conversation.js';
import { makeTestContext } from '../../fakes/context.js';

const ADDRESS = '0x2222222222222222222222222222222222222222';
const question = (code: QuestionCode) =>
  buildQuestion({ question_id: 'q_000000000099' as QuestionId, code, text: 'Pending question' });

describe('SQ-CV-01 independent interpretation boundaries', () => {
  it.each([
    ['Q_WHO_IS', 'Riya', true],
    ['Q_ADDRESS_REENTER', 'Riya', true],
    ['Q_WHO_IS', 'help', true],
    ['Q_WHO_IS', 'why', true],
    ['Q_NO_PAYEE', 'myself', true],
    ['Q_WHO_IS', ADDRESS, false],
    ['Q_WHO_IS', 'riya.eth', false],
    ['Q_NO_PAYEE', 'Riya', false],
    ['Q_NO_PAYEE', 'pay Riya', true],
    ['Q_AMOUNT_MISSING', '10 usdc', false],
    ['Q_AMOUNT_MISSING', '10 usdc to Riya', true],
    ['Q_AUTOPAY_START', '2027-02-03', false],
    ['Q_AUTOPAY_START', 'next friday but change to Riya', true],
  ] as const)('routes %s reply %s without confusing ordinary words with ENS', (code, text, expected) => {
    expect(needsConversation(makeTestContext(), question(code), text)).toBe(expected);
  });

  it('keeps an exact displayed contact chip on the native answer path', () => {
    const q = question('Q_WHO_IS');
    q.chips = [{ id: 'contact:riya', label: 'Riya', disabled: false, detail: '' }];
    expect(needsConversation(makeTestContext(), q, 'Riya')).toBe(false);
  });

  it.each([
    { intent: 'recipient', value: 'Yash' },
    { intent: 'answer', value: '20 ETH' },
    { intent: 'new_request', value: 'send 10 USDC to Riya' },
    { intent: 'recipient', value: 'Riya', plan: { recipient: ADDRESS } },
  ])('rejects invented, contextual or extra model-authored values: %j', async (output) => {
    const ctx = makeTestContext({ req: { typed_text: 'send 20 ETH to Yash' } });
    ctx.llm.call = async <T>() => structuredClone(output) as T;
    expect(await interpretReply(ctx, question('Q_WHO_IS'), 'please use Riya instead', [])).toEqual({
      intent: 'clarify',
      value: null,
    });
  });

  it('accepts a verbatim current-turn value without rewriting its spelling', async () => {
    const ctx = makeTestContext({
      fixture: { calls: [{ name: 'conversation', match: '', output: { intent: 'recipient', value: 'RiYa' } }] },
    });
    expect(await interpretReply(ctx, question('Q_WHO_IS'), 'please use RiYa instead', [])).toEqual({
      intent: 'recipient',
      value: 'RiYa',
    });
  });

  it('excludes document values, raw question/chip text and contact inventory from the context', async () => {
    const ctx = makeTestContext({
      req: {
        typed_text: 'pay Yash 10 usdc',
        untrusted: [{ item_index: 0, address: ADDRESS, ens_name: 'untrusted.eth', amount: '619', token: 'USDC' }],
        input: { text: '', pasted_blocks: ['DOCUMENT_ONLY_MARKER'], attachments: [], urls: [] },
      },
      fixture: { calls: [{ name: 'conversation', match: '', output: { intent: 'clarify', value: null } }] },
    });
    const q = question('Q_WHO_IS');
    q.text = `QUESTION_ONLY_MARKER ${ADDRESS}`;
    q.chips = [{ id: 'private-id', label: 'CONTACT_ONLY_MARKER', detail: 'PRIVATE_DETAIL', disabled: false }];
    await interpretReply(ctx, q, 'why do you need that?', [{ question: 'Q_TOKEN', reply: 'USDC' }]);
    const prompt = ctx.llm.recorded[0]!.user;
    expect(prompt).toContain('pay Yash 10 usdc');
    expect(prompt).toContain('why do you need that?');
    expect(prompt).toContain('Q_TOKEN');
    for (const value of [
      ADDRESS,
      'untrusted.eth',
      '619',
      'DOCUMENT_ONLY_MARKER',
      'QUESTION_ONLY_MARKER',
      'CONTACT_ONLY_MARKER',
      'PRIVATE_DETAIL',
      'Aradhya',
      'Mihir',
    ]) {
      expect(prompt).not.toContain(value);
    }
  });

  it('clarifies an overlong incoming turn without sending a truncated instruction to the model', async () => {
    const ctx = makeTestContext();
    expect(await interpretReply(ctx, question('Q_WHO_IS'), 'x'.repeat(4001), [])).toEqual({
      intent: 'clarify',
      value: null,
    });
    expect(ctx.llm.recorded).toEqual([]);
  });

  it.each([
    'pay Riya 20 usdc instead',
    'pay Riya every Friday instead',
    'do not pay Riya',
    'pay Riya and Mihir',
    'pay Riya only if the invoice is valid',
  ])('does not reduce a compound or negated change to one recipient: %s', (text) => {
    expect(recipientOnlyReply(text, 'Riya')).toBe(false);
  });

  it('allows a recipient-only change while rejecting a second instruction in an extracted answer', () => {
    expect(recipientOnlyReply('please pay Riya instead', 'Riya')).toBe(true);
    expect(answerOnlyReply(`her address is ${ADDRESS}`, ADDRESS)).toBe(true);
    expect(answerOnlyReply(`her address is ${ADDRESS} and send 20 ETH`, ADDRESS)).toBe(false);
    expect(answerOnlyReply(`do not use ${ADDRESS}`, ADDRESS)).toBe(false);
  });
});
