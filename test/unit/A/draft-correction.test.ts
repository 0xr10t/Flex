import { describe, expect, it } from 'vitest';
import { LlmFailed, type LlmCallArgs } from '../../../src/contracts/llm.js';
import type { StepContext } from '../../../src/contracts/step.js';
import {
  interpretDraftEdit,
  prepareDraftCorrection,
  type PaymentDraft,
} from '../../../src/session/draft-correction.js';
import { makeTestContext } from '../../fakes/context.js';

const draft: PaymentDraft = {
  amount: '0.01',
  token: 'ETH',
  recipient: '0x000000000000000000000000000000000000000c',
  chain_id: 11155111,
};
interface Context {
  session_id: string;
  draft_revision: string;
  turn_id: string;
  current_draft: { amount_ref: string; recipient_ref: string };
  amounts: { placeholder: string; valid: boolean; explicit_token?: string }[];
  recipients: { placeholder: string }[];
}
function setup(decide: (c: Context) => object, names: string[] = []) {
  const fake = makeTestContext({
    req: {
      payments: [
        {
          kind: 'i',
          amount: 'amount_12345678',
          recipient: 'address_12345678',
          token: 'ETH',
          chain: 11155111,
          frequency: null,
          interval: null,
          times_per_week: null,
          days_of_week: null,
          day_of_month: null,
        },
      ],
    },
  });
  const calls: LlmCallArgs[] = [];
  const ctx: StepContext = {
    ...fake,
    llm: {
      modelAvailable: async () => true,
      call: async <T>(args: LlmCallArgs): Promise<T> => {
        calls.push(args);
        if (args.name === 'draft_values') return { recipients: names } as T;
        const context = JSON.parse(args.user.slice('CONTEXT: '.length)) as Context;
        return decide(context) as T;
      },
    },
  };
  return { ctx, calls };
}
function decision(c: Context, changes: object = {}, action = 'edit_draft') {
  return {
    session_id: c.session_id,
    draft_revision: c.draft_revision,
    turn_id: c.turn_id,
    action,
    changes: { amount_ref: null, recipient_ref: null, token: null, chain_id: null, ...changes },
    reason: action === 'clarify' ? 'ambiguous' : null,
  };
}
const selectAmount = (c: Context) => decision(c, { amount_ref: (c.amounts[1] ?? c.amounts[0])!.placeholder });

describe('scoped placeholder draft interpretation', () => {
  it.each([
    'Naah, I think 0.01 is less. I want you to send 0.02 instead of 0.01',
    'Could you make that 0.02? Leave everything else as it is.',
    '0.02 please',
    'No, 0.02, not 0.01',
  ])('lets the model interpret phrasing while code preserves all other fields: %s', async (text) => {
    const { ctx, calls } = setup(selectAmount);
    expect(await interpretDraftEdit(ctx, draft, text)).toEqual({
      kind: 'replace',
      input: { text: `send 0.02 eth to ${draft.recipient} on Sepolia`, attachments: [], pasted_blocks: [], urls: [] },
    });
    expect(calls.map((c) => c.name)).toEqual(['draft_values', 'draft_edit']);
    for (const call of calls) {
      expect(call.think).toBe(false);
      expect(call.user).not.toContain('0.01');
      expect(call.user).not.toContain('0.02');
      expect(call.user).not.toContain(draft.recipient);
    }
    expect(ctx.exec).toMatchObject({ submissions: [] });
  });

  it('preserves exact large decimals without float or model round trips', async () => {
    const amount = '123456789012345678.123456789012345678';
    const { ctx, calls } = setup(selectAmount);
    const result = await interpretDraftEdit(ctx, draft, `I reconsidered; use ${amount} instead.`);
    expect(result.kind === 'replace' && result.input.text).toContain(amount);
    expect(calls.every((c) => !c.user.includes(amount))).toBe(true);
  });

  it('masks exact addresses and changes multiple explicitly supplied fields', async () => {
    const address = '0x0000000000000000000000000000000000000012';
    const { ctx, calls } = setup((c) =>
      decision(c, {
        amount_ref: c.amounts[1]!.placeholder,
        recipient_ref: c.recipients[1]!.placeholder,
        token: 'USDC',
        chain_id: 84532,
      }),
    );
    const result = await interpretDraftEdit(ctx, draft, `Actually, make it 40 USDC to ${address} on Base.`);
    expect(result.kind === 'replace' && result.input.text).toBe(`send 40 usdc to ${address} on Base Sepolia`);
    expect(calls.every((c) => !c.user.includes(address))).toBe(true);
  });

  it('copies an exact newly mentioned name and masks it before interpretation', async () => {
    const { ctx, calls } = setup((c) => decision(c, { recipient_ref: c.recipients[1]!.placeholder }), ['Neha']);
    const result = await interpretDraftEdit(ctx, draft, 'I meant Neha as the recipient.');
    expect(result.kind === 'replace' && result.input.text).toBe('send 0.01 eth to Neha on Sepolia');
    expect(calls[1]!.user).not.toContain('Neha');
    expect(ctx.repos.db2.listAll().some((c) => c.name === 'Neha')).toBe(false);
  });

  it('reuses a current amount reference while retaining repeated mentions and negation', async () => {
    const { ctx, calls } = setup(selectAmount);
    await interpretDraftEdit(ctx, draft, '0.01 is too little; use 0.02 instead of 0.01.');
    const context = JSON.parse(calls[1]!.user.slice('CONTEXT: '.length));
    expect(context.amounts).toHaveLength(2);
    expect(context.latest_message.match(/amount_12345678/g)).toHaveLength(2);
    expect(context.latest_message).toContain('instead of');
  });

  it.each([
    ['unknown reference', (c: Context) => decision(c, { amount_ref: 'amount_deadbeef' })],
    ['wrong type of reference', (c: Context) => decision(c, { amount_ref: c.recipients[0]!.placeholder })],
    ['another session', (c: Context) => ({ ...decision(c), session_id: 'ses_foreign' })],
    ['old draft revision', (c: Context) => ({ ...decision(c), draft_revision: 'req_old' })],
    ['old turn', (c: Context) => ({ ...decision(c), turn_id: 'q_old' })],
    ['invented token', (c: Context) => decision(c, { token: 'USDC' })],
    ['unmentioned chain', (c: Context) => decision(c, { chain_id: 84532 })],
    ['raw authored value', (c: Context) => decision(c, { amount: '999' })],
    ['approval action', (c: Context) => decision(c, {}, 'confirm')],
    ['submission action', (c: Context) => decision(c, {}, 'submit')],
    ['chat with a mutation', (c: Context) => decision(c, { amount_ref: c.amounts[1]!.placeholder }, 'chat')],
  ] as const)('rejects %s even from an injected model client', async (_name, decide) => {
    const { ctx } = setup(decide);
    expect(await interpretDraftEdit(ctx, draft, 'make it 0.02')).toMatchObject({ kind: 'clarify' });
  });

  it.each(['0', '-40', '−40', '- 40', '1e-3', '1.2.3', '2–4', '0.1234567890123456789'])(
    'rejects invalid or overprecise amounts: %s',
    async (amount) => {
      const { ctx } = setup(selectAmount);
      expect(await interpretDraftEdit(ctx, draft, `make it ${amount}`)).toMatchObject({ kind: 'clarify' });
    },
  );

  it('does not turn a scheduled correction into an immediate transfer even if the model selects edit', async () => {
    const { ctx } = setup(selectAmount);
    expect(await interpretDraftEdit(ctx, draft, 'make it 0.02 every Friday')).toMatchObject({ kind: 'clarify' });
  });

  it('rejects a currency conflict instead of silently changing the amount currency', async () => {
    const { ctx } = setup((c) => decision(c, { amount_ref: c.amounts[1]!.placeholder, token: 'ETH' }));
    expect(await interpretDraftEdit(ctx, draft, 'make it 40 USDC')).toMatchObject({ kind: 'clarify' });
  });

  it('never resolves user-injected placeholders or hallucinated recipient substrings', async () => {
    const injected = setup(selectAmount);
    expect(await interpretDraftEdit(injected.ctx, draft, 'use amount_12345678')).toMatchObject({ kind: 'clarify' });
    expect(injected.calls).toEqual([]);
    const name = setup((c) => decision(c), ['Neha']);
    expect(await interpretDraftEdit(name.ctx, draft, 'pay Snehal instead')).toMatchObject({ kind: 'clarify' });
    expect(name.calls).toHaveLength(1);
  });

  it('keeps chat, new requests and ambiguous replies separate from edits', async () => {
    for (const action of ['chat', 'new_request', 'clarify']) {
      const { ctx } = setup((c) => decision(c, {}, action));
      expect(await interpretDraftEdit(ctx, draft, 'what does this mean?')).toMatchObject({ kind: action });
    }
  });

  it('refuses secret inputs before either model sees them', async () => {
    const { ctx, calls } = setup(() => {
      throw new LlmFailed('draft_edit');
    });
    const result = await prepareDraftCorrection(ctx, {
      text: `my private key is 0x${'ab'.repeat(32)}`,
      attachments: [],
      urls: [],
      pasted_blocks: [],
    });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });
});
