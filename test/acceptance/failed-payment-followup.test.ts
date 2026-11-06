// Independent HTTP regressions: SQ-S-01 failed-payment amount corrections; §17.2 history, §17.3 cancellation,
// §16 untrusted inputs, §8.14/B19 submission identity, §10 exact funding and G03 fresh confirmation checks.
// Real pipeline and SQLCipher; model, RPC, ENS and execution are deterministic fakes. No network calls.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChainId, Token } from '../../src/contracts/types.js';
import type { FixtureCall } from '../fakes/llm.js';
import { expectEnvelope, usdcIntent } from './checks.js';
import {
  ARADHYA,
  ARB,
  BASE,
  Harness,
  MIHIR,
  SEPOLIA,
  USDC_ADDR,
  addr,
  coinType,
  eth,
  loadFixture,
  usdc,
  type Balances,
} from './harness.js';

const INITIAL = 'send 100 USDC to Aradhya on Arbitrum';
const CORRECTION = 'ok no worries, send 70';
const RIYA_REQUEST = 'Pay 200 dollars to Riya';
const RIYA = addr(0xe1);
const BALANCES: Balances = {
  [SEPOLIA]: { USDC: '0', ETH: '0.1' },
  [BASE]: { USDC: '30', ETH: '0.1' },
  [ARB]: { USDC: '60', ETH: '0.1' },
};
const live: Harness[] = [];

function amountCall(text: string, phrase: string, number: string, token: Token | null): FixtureCall {
  return {
    name: 'amounts',
    match: text,
    output: { amounts: [{ phrase, number, relative: null, token, fiat: null, role: 'pay' }] },
  };
}

function paymentCalls(o: {
  text: string;
  phrase: string;
  number: string;
  token: Token | null;
  payee?: string;
  chain?: ChainId;
  correction?: boolean;
}): FixtureCall[] {
  return [
    amountCall(o.text, o.phrase, o.number, o.token),
    {
      name: 'request_type',
      match: '',
      output: { request_type: 'actions', actions: ['i'], also_balance: false },
    },
    {
      name: 'spans',
      match: '',
      output: { spans: o.payee ? [{ text: o.payee, kind: 'name', role: 'payee' }] : [] },
    },
    {
      name: 'payments',
      match: 'ACTION KINDS:',
      output: {
        payments: [
          {
            kind: 'i',
            amount: '$amount:0',
            recipient: o.correction ? '$session:0' : '$recipient:0',
            chain: o.chain ?? 'unstated',
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

function initialCalls(): FixtureCall[] {
  return paymentCalls({
    text: INITIAL,
    phrase: '100 USDC',
    number: '100',
    token: 'USDC',
    payee: 'Aradhya',
    chain: ARB,
  });
}

function correctionCalls(text = CORRECTION, amount = '70'): FixtureCall[] {
  return paymentCalls({ text, phrase: amount, number: amount, token: null, correction: true });
}

function riyaCalls(): FixtureCall[] {
  const calls = paymentCalls({ text: RIYA_REQUEST, phrase: '200 dollars', number: '200', token: null, payee: 'Riya' });
  calls[0] = {
    name: 'amounts',
    match: RIYA_REQUEST,
    output: {
      amounts: [{ phrase: '200 dollars', number: '200', relative: null, token: null, fiat: 'USD', role: 'pay' }],
    },
  };
  return calls;
}

function referenceCalls(text: string, pronoun: string): FixtureCall[] {
  const calls = correctionCalls(text, '50');
  calls[2] = { name: 'spans', match: pronoun, output: { spans: [{ text: pronoun, kind: 'name', role: 'payee' }] } };
  return calls;
}

function make(id: string, calls: FixtureCall[], balances = BALANCES): Harness {
  const h = new Harness(`failed-payment-followup-${id}`, { calls }, { balances });
  live.push(h);
  return h;
}

function noCommitment(h: Harness): void {
  expect(h.exec.submissions).toHaveLength(0);
  for (const table of ['db6_spend_log', 'db7_autopays', 'handoff_journal', 'db8_history']) {
    expect(h.count(table), table).toBe(0);
  }
}

async function failInitial(h: Harness) {
  const failed = await h.say(INITIAL);
  expect(failed.http).toBe(200);
  expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
  return failed;
}

afterEach(async () => {
  for (const h of live.splice(0)) await h.finish({ allowUnused: true });
});

describe('SQ-S-01: fresh amount corrections of an unsubmitted failed payment', () => {
  it('retains the resolved payee/token/Arbitrum chain, rebuilds exact bridge ordering, and waits for a new yes', async () => {
    const h = make('bridge', [...initialCalls(), ...correctionCalls()]);
    const failed = await failInitial(h);
    const before = h.rows('SELECT placeholder, amount, token FROM db1_amount_placeholders WHERE source = ?', 'user');
    noCommitment(h);

    const summary = await h.say(CORRECTION);
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.request_id).not.toBe(failed.body.request_id);
    expect(h.asked).toEqual([]);
    expect(summary.body.summary?.notes).toContain('Continuing your previous request with a new amount.');
    expect(summary.body.summary?.notes).not.toContain('Recipient and chain from your last payment.');
    expect(
      h.rows(
        'SELECT amount, token, source, confirmed FROM db1_amount_placeholders WHERE request_id = ? AND source = ?',
        summary.body.request_id,
        'user',
      ),
    ).toEqual([{ amount: '70', token: 'USDC', source: 'user', confirmed: 1 }]);
    expect(
      h.rows(
        'SELECT placeholder, amount, token FROM db1_amount_placeholders WHERE request_id = ? AND source = ?',
        failed.body.request_id,
        'user',
      ),
    ).toEqual(before);
    expect(h.count('db3_address_placeholders')).toBe(1);
    noCommitment(h);
    expect((await h.confirm(failed, 'yes')).http).toBe(409);
    noCommitment(h);

    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expectEnvelope(h, summary.body.request_id, [
      {
        intent_id: 'j',
        step: 0,
        token: 'USDC',
        source_token_address: USDC_ADDR[BASE],
        dest_token_address: USDC_ADDR[ARB],
        source_chain_id: BASE,
        dest_chain_id: ARB,
        amount: usdc('10.2'),
        receiver: 'self',
        funds_steps: [1],
      },
      usdcIntent({
        step: 1,
        chain: ARB,
        token_address: USDC_ADDR[ARB],
        amount: usdc('70'),
        recipient: ARADHYA,
        depends_on: [0],
      }),
    ]);
    expect(h.rows('SELECT request_id FROM db8_history')).toEqual([{ request_id: summary.body.request_id }]);
    expect(h.llm.names()).toEqual([
      'amounts',
      'request_type',
      'spans',
      'payments',
      'amounts',
      'request_type',
      'spans',
      'payments',
    ]);
    expect(h.llm.remaining()).toEqual([]);
  });

  it('allows another fresh correction after an amount correction is still insufficient', async () => {
    const h = make('repeated', [...initialCalls(), ...correctionCalls('then send 95', '95'), ...correctionCalls()]);
    const first = await failInitial(h);
    const second = await h.say('then send 95');
    expect(second.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    const third = await h.say(CORRECTION);
    expect(third.body.state).toBe('awaiting_confirmation');
    expect(new Set([first.body.request_id, second.body.request_id, third.body.request_id]).size).toBe(3);
    expect(h.asked).toEqual([]);
    noCommitment(h);
  });

  it('supports a code-verified word amount while preserving the local confirmation boundary', async () => {
    const text = 'okay, send seventy instead';
    const h = make('words', [
      ...initialCalls(),
      ...paymentCalls({ text, phrase: 'seventy', number: '70', token: null, correction: true }),
    ]);
    await failInitial(h);
    const summary = await h.say(text);
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(
      h.rows(
        'SELECT amount FROM db1_amount_placeholders WHERE request_id = ? AND source = ?',
        summary.body.request_id,
        'user',
      ),
    ).toEqual([{ amount: '70' }]);
    noCommitment(h);
  });

  it.each([
    { text: 'then send 70 USDC on Base', phrase: '70 USDC', number: '70', token: 'USDC' as const },
    { text: 'actually send 0.01 ETH on Base', phrase: '0.01 ETH', number: '0.01', token: 'ETH' as const },
  ])('uses the newly stated token/chain in "$text"', async ({ text, phrase, number, token }) => {
    const h = make(`override-${token}`, [
      ...initialCalls(),
      ...paymentCalls({ text, phrase, number, token, chain: BASE, correction: true }),
    ]);
    await failInitial(h);
    const summary = await h.say(text);
    expect(summary.body.state).toBe('awaiting_confirmation');
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents.at(-1)).toMatchObject({
      intent_id: 'i',
      token,
      chain_id: BASE,
      recipient: ARADHYA,
      amount: token === 'ETH' ? eth(number) : usdc(number),
    });
  });

  it('refreshes balances and recomputes bridge requirements for the new request', async () => {
    const h = make('fresh-balances', [...initialCalls(), ...correctionCalls()]);
    await failInitial(h);
    h.setBalances({ [BASE]: { USDC: '0' }, [ARB]: { USDC: '70' } });
    const summary = await h.say(CORRECTION);
    expect(summary.body.state).toBe('awaiting_confirmation');
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expectEnvelope(h, summary.body.request_id, [
      usdcIntent({ step: 0, chain: ARB, token_address: USDC_ADDR[ARB], amount: usdc('70'), recipient: ARADHYA }),
    ]);
  });

  it('does not carry a previously approved limit override into the fresh request', async () => {
    const h = make('fresh-limits', [...initialCalls(), ...correctionCalls()], {
      ...BALANCES,
      [BASE]: { USDC: '130', ETH: '0.1' },
      [ARB]: { USDC: '0', ETH: '0.1' },
    });
    const limits = h.repos.db5.getAll();
    limits.per_tx_max.USDC = '50';
    h.repos.db5.putAll(limits, h.nowIso);
    const question = await h.say(INITIAL);
    expect(question.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    const summary = await h.answer(question, { chipLabel: 'Yes, this once' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    h.setBalances(BALANCES);
    const failure = await h.confirm(summary, 'yes');
    expect(failure.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    noCommitment(h);
    const corrected = await h.say(CORRECTION);
    expect(corrected.body.request_id).not.toBe(summary.body.request_id);
    expect(corrected.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    noCommitment(h);
  });

  it('uses the immediately prior failed payee instead of a different earlier handed-off payee', async () => {
    const prior = 'send 1 USDC to Mihir on Base';
    const h = make('history', [
      ...paymentCalls({ text: prior, phrase: '1 USDC', number: '1', token: 'USDC', payee: 'Mihir', chain: BASE }),
      ...initialCalls(),
      ...correctionCalls(),
    ]);
    const old = await h.sayAndConfirm(prior);
    const failed = await failInitial(h);
    const corrected = await h.say(CORRECTION);
    expect(corrected.body.state).toBe('awaiting_confirmation');
    expect(h.exec.submissions).toHaveLength(1);
    expect(h.rows('SELECT request_id FROM db8_history')).toEqual([{ request_id: old.body.request_id }]);
    await h.confirm(corrected, 'yes');
    expect(h.envelope.intents.at(-1)).toMatchObject({ recipient: ARADHYA, chain_id: ARB, amount: usdc('70') });
    expect(h.rows('SELECT request_id FROM db8_history').map((row) => row.request_id)).not.toContain(
      failed.body.request_id,
    );
  });
});

describe('SQ-S-01 safety boundaries', () => {
  it('a new explicit payee gets normal token clarification and resolves to that new payee', async () => {
    const text = 'send 70 to Mihir on Arbitrum';
    const h = make('new-payee', [
      ...initialCalls(),
      ...paymentCalls({ text, phrase: '70', number: '70', token: null, payee: 'Mihir', chain: ARB }),
    ]);
    await failInitial(h);
    const token = await h.say(text);
    expect(token.body.question?.code).toBe('Q_TOKEN');
    const summary = await h.answer(token, { chipLabel: 'USDC' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents.at(-1)).toMatchObject({ recipient: MIHIR, chain_id: ARB, amount: usdc('70') });
  });

  it('does not reuse a payee when a new name is present but omitted by the spans model', async () => {
    const text = 'send 70 USDC to Kabir';
    const ordinary = paymentCalls({ text, phrase: '70 USDC', number: '70', token: 'USDC' }).slice(0, 3);
    const h = make('omitted-new-payee', [...initialCalls(), ...ordinary]);
    await failInitial(h);
    expect((await h.say(text)).body.question?.code).toBe('Q_NO_PAYEE');
    noCommitment(h);
  });

  it.each(['cancel-endpoint', 'cancel-text', 'balance', 'secret', 'model-unavailable', 'new-session'] as const)(
    'clears the failed-payment context after %s',
    async (operation) => {
      const next = 'send 70';
      const middle = operation === 'balance' ? loadFixture('A-17').calls : [];
      const h = make(`clear-${operation}`, [...initialCalls(), ...middle, amountCall(next, '70', '70', null)]);
      const failed = await failInitial(h);
      if (operation === 'cancel-endpoint') await h.cancel(failed);
      else if (operation === 'cancel-text') await h.say('cancel');
      else if (operation === 'balance') expect((await h.say("what's my balance")).body.state).toBe('done');
      else if (operation === 'secret')
        expect((await h.say(`0x${'ab'.repeat(32)}`)).body.error?.code).toBe('SECRET_DETECTED');
      else if (operation === 'model-unavailable') {
        h.llm.available = false;
        expect((await h.say(CORRECTION)).body.error?.code).toBe('MODEL_FAILED');
        h.llm.available = true;
      } else await h.open('UTC');
      expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
      noCommitment(h);
    },
  );

  it('does not turn a failed autopay into an implicit one-time payment', async () => {
    const next = 'send 70';
    const h = make('autopay', [...loadFixture('A-08').calls, amountCall(next, '70', '70', null)], {
      ...BALANCES,
      [BASE]: { USDC: '0', ETH: '0.1' },
      [ARB]: { USDC: '0', ETH: '0.1' },
    });
    expect((await h.say('pay mihir 10 usdc every friday for 8 weeks')).body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
    noCommitment(h);
  });

  it('does not inherit a recipient for a correction naming two different tokens', async () => {
    const text = 'send 70 USDC ETH';
    // Even if LLM #1 chooses just one of the conflicting tokens, this is not an amount-only correction.
    const ordinary = paymentCalls({ text, phrase: '70 USDC ETH', number: '70', token: 'USDC' }).slice(0, 3);
    const h = make('ambiguous-tokens', [...initialCalls(), ...ordinary]);
    await failInitial(h);
    expect((await h.say(text)).body.question?.code).toBe('Q_NO_PAYEE');
    noCommitment(h);
  });

  it('does not inherit a failed group even when just one group member was selected', async () => {
    const next = 'send 70';
    const h = make('group', [...loadFixture('A-29').calls, amountCall(next, '70', '70', null)]);
    h.subnames.children.set('iitr.eth', ['alice.iitr.eth']);
    h.ens.set('alice.iitr.eth', coinType(BASE), addr(0xb1));
    const members = await h.say('send 100 usdc to everyone under iitr.eth on base');
    expect(members.body.question?.code).toBe('Q_GROUP_MEMBERS');
    const failed = await h.answer(members, { selectedLabels: ['alice.iitr.eth'] });
    expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
    noCommitment(h);
  });

  it('does not choose one recipient from a failed payment to several recipients', async () => {
    const text = 'send 100 USDC each to Aradhya and Mihir on Arbitrum';
    const calls = paymentCalls({
      text,
      phrase: '100 USDC',
      number: '100',
      token: 'USDC',
      payee: 'Aradhya',
      chain: ARB,
    });
    calls[2] = {
      name: 'spans',
      match: '',
      output: {
        spans: [
          { text: 'Aradhya', kind: 'name', role: 'payee' },
          { text: 'Mihir', kind: 'name', role: 'payee' },
        ],
      },
    };
    const payments = (calls[3]!.output as { payments: Array<Record<string, unknown>> }).payments;
    payments.push({ ...payments[0], recipient: '$recipient:1' });
    const next = 'send 70';
    const h = make('multiple', [...calls, amountCall(next, '70', '70', null)]);
    expect((await h.say(text)).body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
    noCommitment(h);
  });

  it('does not reuse an untrusted invoice amount after its explicit confirmation and funding failure', async () => {
    const text = 'pay this invoice';
    const calls = paymentCalls({ text, phrase: '', number: '100', token: 'USDC' });
    calls[0] = { name: 'amounts', match: text, output: { amounts: [] } };
    const next = 'send 70';
    const h = make('untrusted', [
      {
        name: 'quarantine',
        match: 'Invoice',
        output: { items: [{ address: ARADHYA, ens_name: null, amount: '100', token: 'USDC' }] },
      },
      ...calls,
      amountCall(next, '70', '70', null),
    ]);
    const amount = await h.say(text, { pasted_blocks: [`Invoice: 100 USDC to ${ARADHYA}.`] });
    expect(amount.body.question?.code).toBe('Q_UNTRUSTED_AMOUNT');
    const failed = await h.answer(amount, { chipLabel: 'Use this amount' });
    expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(h.rows('SELECT source, confirmed FROM db1_amount_placeholders')).toEqual([
      { source: 'untrusted', confirmed: 1 },
    ]);
    expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
    noCommitment(h);
  });

  it('does not carry context into a message with newly pasted content', async () => {
    const h = make('new-paste', [
      ...initialCalls(),
      { name: 'quarantine', match: 'Invoice', output: { items: [] } },
      amountCall(CORRECTION, '70', '70', null),
    ]);
    await failInitial(h);
    const response = await h.say(CORRECTION, { pasted_blocks: ['Invoice for review'] });
    expect(response.body.question?.code).toBe('Q_TOKEN');
    noCommitment(h);
  });

  it('preserves ENS chain restrictions when a correction explicitly changes the chain', async () => {
    const text = 'send 100 USDC to retry.eth on Base';
    const calls = paymentCalls({
      text,
      phrase: '100 USDC',
      number: '100',
      token: 'USDC',
      payee: 'retry.eth',
      chain: BASE,
    });
    calls[2] = {
      name: 'spans',
      match: 'retry.eth',
      output: { spans: [{ text: 'retry.eth', kind: 'ens', role: 'payee' }] },
    };
    const next = 'send 70 on Arbitrum';
    const h = make('ens-restriction', [
      ...calls,
      ...paymentCalls({ text: next, phrase: '70', number: '70', token: null, chain: ARB, correction: true }),
    ]);
    h.ens.set('retry.eth', coinType(BASE), addr(0xd1));
    const address = await h.say(text);
    expect(address.body.question?.code).toBe('Q_ADDRESS_CORRECT');
    const name = await h.answer(address, { chipLabel: 'Yes' });
    expect(name.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
    const failed = await h.answer(name, { text: 'RetryContact' });
    expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    expect(h.rows('SELECT source FROM db3_address_placeholders')).toEqual([{ source: 'ens' }]);
    const corrected = await h.say(next);
    expect(corrected.body.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(corrected.body.summary).toBeUndefined();
    noCommitment(h);
  });

  it('revalidates an inherited chain against the current allowed-chain settings', async () => {
    const h = make('disabled-chain', [...initialCalls(), ...correctionCalls()]);
    await failInitial(h);
    const limits = h.repos.db5.getAll();
    limits.allowed_chain_ids = [BASE];
    h.repos.db5.putAll(limits, h.nowIso);
    expect((await h.say(CORRECTION)).body.error?.code).toBe('CHAIN_NOT_ALLOWED');
    noCommitment(h);
  });

  it('keeps HANDOFF_FAILED retries bound to the submitted envelope even after a smaller-amount message', async () => {
    const text = 'send 10 USDC to Aradhya on Arbitrum';
    const h = make(
      'submitted',
      paymentCalls({ text, phrase: '10 USDC', number: '10', token: 'USDC', payee: 'Aradhya', chain: ARB }),
    );
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const failed = await h.sayAndConfirm(text);
    expect(failed.body.error?.code).toBe('EXECUTION_UNAVAILABLE');
    const original = structuredClone(h.exec.submissions[0]);
    expect((await h.say('send 7')).body.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(h.exec.submissions).toHaveLength(1);
    expect((await h.confirm(failed, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions[1]).toEqual(original);
  });

  it('does not reuse context from a terminal failed hand-off after its third attempt', async () => {
    const text = 'send 10 USDC to Aradhya on Arbitrum';
    const next = 'send 7';
    const h = make('failed-submission', [
      ...paymentCalls({ text, phrase: '10 USDC', number: '10', token: 'USDC', payee: 'Aradhya', chain: ARB }),
      amountCall(next, '7', '7', null),
    ]);
    h.exec.responses.push(
      ...Array.from({ length: 3 }, () => ({ status: 'unavailable' as const, cause: 'timeout' as const })),
    );
    const first = await h.sayAndConfirm(text);
    await h.confirm(first, 'yes');
    await h.confirm(first, 'yes');
    expect(h.exec.submissions).toHaveLength(3);
    expect((await h.say(next)).body.question?.code).toBe('Q_TOKEN');
    expect(h.exec.submissions).toHaveLength(3);
    expect(h.count('db8_history')).toBe(0);
  });
});

describe('SQ-S-01: explanatory follow-ups use ordinary back-reference semantics', () => {
  it('handles the exact Riya/dollars/medicine correction without asking token or recipient again', async () => {
    const text = 'okay, send 50 instead. I want to send her some funds for the medicine she bought me';
    const h = make('riya-medicine', [...riyaCalls(), ...referenceCalls(text, 'her')]);
    h.addContact('Riya', RIYA, [BASE, ARB]);
    const failed = await h.say(RIYA_REQUEST);
    expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    noCommitment(h);
    const summary = await h.say(text);
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.request_id).not.toBe(failed.body.request_id);
    expect(h.asked).toEqual([]);
    expect(summary.body.summary?.notes).toContain('Continuing your previous request with a new amount.');
    expect(
      h.rows(
        'SELECT amount, token FROM db1_amount_placeholders WHERE request_id = ? AND source = ?',
        summary.body.request_id,
        'user',
      ),
    ).toEqual([{ amount: '50', token: 'USDC' }]);
    expect(h.rows('SELECT amount FROM db1_amount_placeholders WHERE request_id = ?', failed.body.request_id)).toEqual([
      { amount: '200' },
    ]);
    expect(h.count('db3_address_placeholders')).toBe(1);
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expectEnvelope(h, summary.body.request_id, [
      usdcIntent({ step: 0, chain: ARB, token_address: USDC_ADDR[ARB], amount: usdc('50'), recipient: RIYA }),
    ]);
    expect(h.rows('SELECT request_id FROM db8_history')).toEqual([{ request_id: summary.body.request_id }]);
    expect(h.llm.remaining()).toEqual([]);
  });

  it.each([
    { text: 'Send her 50 instead; this reimburses the train tickets.', pronoun: 'her' },
    { text: 'Could you pay them 50 for the repair work they finished?', pronoun: 'them' },
    { text: 'Please send 50 more to cover the taxi fare.', pronoun: 'more' },
    { text: 'Send the same person 50; this reimburses the supplies.', pronoun: 'same person' },
  ])('supports a topic-independent explanation: $text', async ({ text, pronoun }) => {
    const h = make(`explanation-${pronoun}`, [...riyaCalls(), ...referenceCalls(text, pronoun)]);
    h.addContact('Riya', RIYA, [BASE, ARB]);
    expect((await h.say(RIYA_REQUEST)).body.error?.code).toBe('INSUFFICIENT_FUNDS');
    const summary = await h.say(text);
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(h.asked).toEqual([]);
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents.at(-1)).toMatchObject({
      intent_id: 'i',
      token: 'USDC',
      recipient: RIYA,
      amount: usdc('50'),
    });
  });

  it('uses an explicit new recipient and ordinary chain choice despite a pronoun in the explanation', async () => {
    const text = 'Send 50 USDC to Mihir instead. He bought the parts for her.';
    const calls = paymentCalls({ text, phrase: '50 USDC', number: '50', token: 'USDC', payee: 'Mihir' });
    const h = make('reference-new-payee', [...initialCalls(), ...calls]);
    await failInitial(h);
    h.setBalances({ [BASE]: { USDC: '80' }, [ARB]: { USDC: '10' } });
    const summary = await h.say(text);
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.summary?.notes).not.toContain('Continuing your previous request with a new amount.');
    const pairing = h.llm.recorded.filter((call) => call.name === 'payments').at(-1);
    expect(pairing?.user).toContain('SESSION: none');
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expectEnvelope(h, summary.body.request_id, [
      usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('50'), recipient: MIHIR }),
    ]);
  });

  it('asks who a pronoun refers to when a different mentioned person is present, then resumes with the answer', async () => {
    const text = 'I talked to Mihir. Please send him 50 for the repair.';
    const calls = paymentCalls({ text, phrase: '50', number: '50', token: null });
    calls[2] = {
      name: 'spans',
      match: 'Mihir',
      output: {
        spans: [
          { text: 'Mihir', kind: 'name', role: 'mentioned' },
          { text: 'him', kind: 'name', role: 'payee' },
        ],
      },
    };
    const h = make('reference-ambiguous-person', [...initialCalls(), ...calls]);
    await failInitial(h);
    h.setBalances({ [BASE]: { USDC: '80' }, [ARB]: { USDC: '10' } });
    const question = await h.say(text);
    expect(question.body.question?.code).toBe('Q_NO_PAYEE');
    noCommitment(h);
    const summary = await h.answer(question, { text: 'Mihir' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.summary?.notes).not.toContain('Continuing your previous request with a new amount.');
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expectEnvelope(h, summary.body.request_id, [
      usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('50'), recipient: MIHIR }),
    ]);
  });

  it('requires a newly supplied amount even when the user asks to send her the same amount', async () => {
    const text = 'Send her the same amount for the groceries.';
    const calls = referenceCalls(text, 'her');
    calls[0] = { name: 'amounts', match: text, output: { amounts: [] } };
    const h = make('reference-no-amount', [...riyaCalls(), ...calls]);
    h.addContact('Riya', RIYA, [BASE, ARB]);
    expect((await h.say(RIYA_REQUEST)).body.error?.code).toBe('INSUFFICIENT_FUNDS');
    const question = await h.say(text);
    expect(question.body.question?.code).toBe('Q_AMOUNT_MISSING');
    expect(h.rows('SELECT amount FROM db1_amount_placeholders WHERE request_id = ?', question.body.request_id)).toEqual(
      [],
    );
    noCommitment(h);
    const summary = await h.answer(question, { text: '50' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(h.asked).toEqual(['Q_AMOUNT_MISSING']);
    expect(
      h.rows(
        'SELECT amount, token FROM db1_amount_placeholders WHERE request_id = ? AND source = ?',
        question.body.request_id,
        'user',
      ),
    ).toEqual([{ amount: '50', token: 'USDC' }]);
    noCommitment(h);
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents.at(-1)).toMatchObject({ recipient: RIYA, amount: usdc('50') });
  });

  it('does not let a back-reference bypass the conflicting-token safeguard', async () => {
    const text = 'Send her 50 USDC ETH for the tickets.';
    const calls = paymentCalls({ text, phrase: '50 USDC ETH', number: '50', token: 'USDC', payee: 'her' }).slice(0, 3);
    const h = make('reference-conflicting-tokens', [...initialCalls(), ...calls]);
    await failInitial(h);
    expect((await h.say(text)).body.question?.code).toBe('Q_NO_PAYEE');
    noCommitment(h);
  });
});
