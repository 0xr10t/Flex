// SQ-CV-02: HTTP regressions for the reported Soham → Riya and 50 → 40 confirmation edits.
import { afterEach, describe, expect, it } from 'vitest';
import type { FixtureCall } from '../fakes/llm.js';
import { addr, BASE, ARB, Harness, NOW_ISO } from './harness.js';

const SOHAM = '0xDb1A8eE14598debB070d009F1Db57A3ce35954D0' as const;
const RIYA = addr(12);
const made: Harness[] = [];
function edit(changes: Record<string, unknown> = {}, names: string[] = [], action = 'edit_draft'): FixtureCall[] {
  return [
    { name: 'draft_values', match: '', output: { recipients: names } },
    {
      name: 'draft_edit',
      match: '',
      output: {
        session_id: '$session_id',
        draft_revision: '$draft_revision',
        turn_id: '$turn_id',
        action,
        changes: { amount_ref: null, recipient_ref: null, token: null, chain_id: null, ...changes },
        reason: action === 'clarify' ? 'ambiguous' : null,
      },
    },
  ];
}
function payment(
  amount: string,
  recipient: string,
  chain: typeof BASE | typeof ARB | 11155111 = BASE,
  token = 'USDC',
): FixtureCall[] {
  return [
    {
      name: 'amounts',
      match: '',
      output: {
        amounts: [
          {
            phrase: `${amount} ${token.toLowerCase()}`,
            number: amount,
            token,
            relative: null,
            fiat: null,
            role: 'pay',
          },
        ],
      },
    },
    { name: 'request_type', match: '', output: { request_type: 'actions', actions: ['i'], also_balance: false } },
    {
      name: 'spans',
      match: '',
      output: {
        spans: [
          {
            text: recipient,
            kind: recipient.startsWith('0x') ? 'address' : recipient.includes('.') ? 'ens' : 'name',
            role: 'payee',
          },
        ],
      },
    },
    {
      name: 'payments',
      match: '',
      output: {
        payments: [
          {
            kind: 'i',
            amount: '$amount:0',
            recipient: '$recipient:0',
            chain,
            frequency: null,
            interval: null,
            times_per_week: null,
            days_of_week: null,
            day_of_month: null,
          },
        ],
      },
    },
  ];
}
function make(id: string, calls: FixtureCall[], savedSoham = true): Harness {
  const h = new Harness(`draft-correction-${id}`, { calls }, {});
  h.addContact('Riya', RIYA, [BASE, ARB]);
  if (savedSoham) h.addContact('soham', SOHAM, [11155111, BASE, ARB]);
  made.push(h);
  return h;
}
afterEach(async () => {
  for (const h of made.splice(0)) await h.finish({ allowUnused: true });
});

describe('SQ-CV-02 current payment draft over HTTP', () => {
  it('corrects the reported 0.01 → 0.02 ETH message and requires a fresh confirmation', async () => {
    const h = make('reported-natural-correction', [
      ...payment('0.01', 'soham', 11155111, 'ETH'),
      ...edit({ amount_ref: '$amount:1' }),
      ...payment('0.02', SOHAM, 11155111, 'ETH'),
    ]);
    const original = await h.say('send 0.01 eth on sepolia to soham');
    expect(original.body.state).toBe('awaiting_confirmation');
    const revised = await h.say('Naah, I think 0.01 is less. I want you to send 0.02 instead of 0.01');
    expect(revised.body.summary?.text).toContain('0.02 ETH');
    expect(revised.body.summary?.text).toMatch(/soham/i);
    expect(revised.body.summary?.text).toContain('Sepolia');
    expect(revised.body.request_id).not.toBe(original.body.request_id);
    expect((await h.confirm(original, 'yes')).http).toBe(409);
    expect(h.exec.submissions).toHaveLength(0);
    expect((await h.confirm(revised, 'yes')).body.state).toBe('done');
    expect(h.envelope.intents[0]).toMatchObject({
      token: 'ETH',
      chain_id: 11155111,
      recipients: [{ recipient: SOHAM, amount: { value: '0.02' } }],
    });
    const calls = h.llm.recorded.filter((call) => call.name.startsWith('draft_'));
    expect(
      calls.every((call) => !call.user.includes('0.01') && !call.user.includes('0.02') && !call.user.includes(SOHAM)),
    ).toBe(true);
    expect(h.llm.remaining()).toEqual([]);
  });

  it.each(['draft_values', 'draft_edit'] as const)('retains the exact draft when %s fails twice', async (name) => {
    const failures: FixtureCall[] = [
      ...(name === 'draft_edit' ? [{ name: 'draft_values' as const, match: '', output: { recipients: [] } }] : []),
      { name, match: '', output: null },
      { name, match: '', output: null, attempt: 2 },
    ];
    const h = make(`failure-${name}`, [...payment('40', 'soham'), ...failures]);
    const original = await h.say('send 40 usdc to soham on base');
    const before = h.snapshot([
      'db1_amount_placeholders',
      'db3_address_placeholders',
      'db6_spend_log',
      'handoff_journal',
    ]);
    const unchanged = await h.say('I think 50 would be better');
    expect(unchanged.body.summary).toEqual(original.body.summary);
    expect(unchanged.body.request_id).toBe(original.body.request_id);
    expect(
      h.snapshot(['db1_amount_placeholders', 'db3_address_placeholders', 'db6_spend_log', 'handoff_journal']),
    ).toBe(before);
    expect(h.exec.submissions).toHaveLength(0);
    expect((await h.confirm(original, 'yes')).body.state).toBe('done');
  });

  it('remembers the reported address/name flow, switches only the payee, then edits 50 to 40 with no repeated fields', async () => {
    const h = make(
      'reported-sequence',
      [
        ...payment('40', 'soham'),
        ...edit({ recipient_ref: '$recipient:1' }),
        ...payment('40', 'riya'),
        ...edit({ amount_ref: '$amount:1' }),
        ...payment('50', RIYA),
        ...edit({ amount_ref: '$amount:1' }),
        ...payment('40', RIYA),
      ],
      false,
    );
    const unknown = await h.say('Send 40 usdc to soham on base sepolia');
    expect(unknown.body.question?.code).toBe('Q_WHO_IS');
    const address = await h.answer(unknown, { text: SOHAM });
    expect(address.body.question?.code).toBe('Q_ADDRESS_CORRECT');
    const name = await h.answer(address, { chipLabel: 'Yes' });
    expect(name.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
    const original = await h.answer(name, { text: 'soham' });
    expect(original.body.state).toBe('awaiting_confirmation');
    const asked = [...h.asked];

    const recipientEdit = await h.say('No, pay the same amount to riya instead');
    expect(recipientEdit.body.state).toBe('awaiting_confirmation');
    expect(recipientEdit.body.summary?.text).toContain('40 USDC to Riya');
    expect(recipientEdit.body.summary?.text).toContain('Base Sepolia');
    expect(recipientEdit.body.request_id).not.toBe(original.body.request_id);
    expect((await h.confirm(original, 'yes')).http).toBe(409);

    const fifty = await h.say('make it 50');
    expect(fifty.body.summary?.text).toContain('50 USDC to Riya');
    const forty = await h.say('No, send 40, not 50');
    expect(forty.body.state).toBe('awaiting_confirmation');
    expect(forty.body.summary?.text).toContain('40 USDC to Riya');
    expect(forty.body.summary?.text).toContain('Base Sepolia');
    expect(h.asked).toEqual(asked);
    expect((await h.confirm(fifty, 'yes')).http).toBe(409);
    expect(h.exec.submissions).toHaveLength(0);
    expect(h.count('db8_history')).toBe(0);
    expect(h.count('db6_spend_log')).toBe(0);
    expect((await h.confirm(forty, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toHaveLength(1);
    expect(h.envelope.intents).toHaveLength(1);
    expect(h.envelope.intents[0]).toMatchObject({
      intent_id: 'i',
      token: 'USDC',
      chain_id: BASE,
      recipients: [{ recipient: RIYA, amount: { value: '40' } }],
    });
    expect(h.llm.remaining()).toEqual([]);
  });

  it('bypasses generic chat for a recognized edit even when thinking chat is enabled', async () => {
    const h = make('chat-enabled', [
      { name: 'chat_route', match: '', output: { intent: 'wallet' } },
      ...payment('40', 'soham'),
      ...edit({ recipient_ref: '$recipient:1' }),
      ...payment('40', 'riya'),
    ]);
    h.config.chat = { enabled: true, think: true, model: 'qwen3:8b' };
    await h.say('send 40 usdc to soham on base');
    const revised = await h.say('No, pay the same amount to riya instead');
    expect(revised.body.summary?.text).toContain('40 USDC to Riya');
    expect(h.llm.names().filter((name) => name === 'chat_route')).toHaveLength(1);
    expect(h.llm.names()).not.toContain('chat');
    expect(h.exec.submissions).toHaveLength(0);
    expect(h.llm.remaining()).toEqual([]);
  });

  it('asks only for the new unknown recipient and retains amount/token/chain through its answers', async () => {
    const h = make('unknown-replacement', [
      ...payment('40', 'soham'),
      ...edit({ recipient_ref: '$recipient:1' }, ['Neha']),
      ...payment('40', 'Neha'),
    ]);
    await h.say('send 40 usdc to soham on base');
    const pending = await h.say('pay Neha instead');
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const resolved = await h.answer(pending, { text: RIYA });
    expect(resolved.body.state).toBe('awaiting_confirmation');
    expect(resolved.body.summary?.text).toContain('40 USDC to Riya');
    expect(resolved.body.summary?.text).toContain('Base Sepolia');
    expect(h.asked).not.toContain('Q_TOKEN');
    expect(h.asked).not.toContain('Q_AMOUNT_MISSING');
    expect(h.llm.remaining()).toEqual([]);
  });

  it.each(['No, send 40, not 50 and pay Mihir', 'No, pay Riya or Soham instead', 'No, send 0'])(
    'retains the draft for an ambiguous/invalid correction: %s',
    async (text) => {
      const h = make('invalid', [...payment('40', 'soham'), ...edit({}, [], 'clarify')]);
      const original = await h.say('send 40 usdc to soham on base');
      const before = h.snapshot([
        'db1_amount_placeholders',
        'db3_address_placeholders',
        'db6_spend_log',
        'handoff_journal',
      ]);
      const response = await h.say(text);
      expect(response.body.request_id).toBe(original.body.request_id);
      expect(response.body.summary).toEqual(original.body.summary);
      expect(response.body.state).toBe('awaiting_confirmation');
      expect(
        h.snapshot(['db1_amount_placeholders', 'db3_address_placeholders', 'db6_spend_log', 'handoff_journal']),
      ).toBe(before);
      expect(h.llm.recorded).toHaveLength(6);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it('rechecks current balances for the revised payment', async () => {
    const h = make('fresh-balances', [
      ...payment('40', 'soham'),
      ...edit({ amount_ref: '$amount:1' }),
      ...payment('50', SOHAM),
    ]);
    await h.say('send 40 usdc to soham on base');
    h.setBalances({ [BASE]: { USDC: '0', ETH: '0.1' }, [ARB]: { USDC: '0', ETH: '0.1' } });
    const edited = await h.say('send 50 instead');
    expect(edited.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('does not carry an old limit override into a revision', async () => {
    const h = make('fresh-limits', [
      ...payment('40', 'soham'),
      ...edit({ amount_ref: '$amount:1' }),
      ...payment('50', SOHAM),
    ]);
    const limits = h.repos.db5.getAll();
    h.repos.db5.putAll({ ...limits, per_tx_max: { ...limits.per_tx_max, USDC: '20' } }, NOW_ISO);
    const limit = await h.say('send 40 usdc to soham on base');
    expect(limit.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    expect((await h.answer(limit, { chipLabel: 'Yes' })).body.state).toBe('awaiting_confirmation');
    const edited = await h.say('send 50 instead');
    expect(edited.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('does not edit or revive a submitted payment', async () => {
    const next: FixtureCall = {
      name: 'amounts',
      match: '',
      output: { amounts: [{ phrase: '50', number: '50', token: null, relative: null, fiat: null, role: 'pay' }] },
    };
    const h = make('after-submission', [...payment('40', 'soham'), next]);
    const original = await h.say('send 40 usdc to soham on base');
    await h.confirm(original, 'yes');
    const submitted = JSON.stringify(h.envelope);
    const response = await h.say('send 50 instead');
    expect(response.body.question?.code).toBe('Q_TOKEN');
    expect(h.exec.submissions).toHaveLength(1);
    expect(JSON.stringify(h.envelope)).toBe(submitted);
  });
});
