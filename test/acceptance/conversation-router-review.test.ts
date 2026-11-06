// Independent HTTP regressions for conversational replies. No live model or external services.
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import type { ChainId } from '../../src/contracts/types.js';
import type { FixtureCall } from '../fakes/llm.js';
import { addr, ARB, BASE, Harness, MIHIR, type Resp } from './harness.js';

const RIYA = addr(44);
const made: Harness[] = [];
const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
const route = (intent: string, value: string | null = null) => call('conversation', { intent, value });
const amount = (n = '10') => ({
  phrase: `${n} usdc`,
  number: n,
  token: 'USDC',
  relative: null,
  fiat: null,
  role: 'pay',
});
function opening(name = 'Yash', n: string | null = '10', recurring = false): FixtureCall[] {
  return [
    call('amounts', { amounts: n === null ? [] : [amount(n)] }),
    call('request_type', { request_type: 'actions', actions: [recurring ? 'k' : 'i'], also_balance: false }),
    call('spans', { spans: name ? [{ text: name, kind: 'name', role: 'payee' }] : [] }),
  ];
}
function paired(recurring = false, chain: ChainId | 'unstated' = 'unstated'): FixtureCall {
  return call('payments', {
    payments: [
      {
        kind: recurring ? 'k' : 'i',
        amount: '$amount:0',
        recipient: '$recipient:0',
        chain,
        frequency: recurring ? 'weekly' : null,
        interval: recurring ? 1 : null,
        times_per_week: null,
        days_of_week: recurring ? ['FRI'] : null,
        day_of_month: null,
      },
    ],
  });
}
function make(id: string, calls: FixtureCall[], savedRiya = true): Harness {
  const h = new Harness(`conversation-review-${id}`, { calls }, {});
  if (savedRiya) h.addContact('Riya', RIYA, [BASE, ARB]);
  made.push(h);
  return h;
}
async function respond(h: Harness, previous: Resp, text: string, channel: 'answers' | 'messages'): Promise<Resp> {
  return channel === 'answers' ? h.answer(previous, { text }) : h.say(text);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const h of made.splice(0)) await h.finish({ allowUnused: true });
});

describe('SQ-CV-01 conversational reply HTTP review', () => {
  it.each(['answers', 'messages'] as const)(
    'changes Yash to Riya via /%s and preserves amount, chain and schedule',
    async (channel) => {
      const h = make(channel, [...opening('Yash', '10', true), route('recipient', 'Riya'), paired(true, ARB)]);
      const pending = await h.say('pay Yash 10 usdc on arbitrum every friday for 3 weeks');
      expect(pending.body.question?.code).toBe('Q_WHO_IS');
      const corrected = await respond(h, pending, 'please pay Riya instead', channel);
      expect(corrected.body.state).toBe('awaiting_confirmation');
      expect(corrected.body.summary?.text).toContain('Riya');
      expect(corrected.body.summary?.text).not.toContain('Yash');
      expect(h.exec.submissions).toHaveLength(0);
      expect((await h.answer(pending, { text: MIHIR })).http).toBe(409);
      const pairing = h.llm.recorded.find((c) => c.name === 'payments')!;
      expect(pairing.user).not.toMatch(/Yash|Riya/);
      expect((await h.confirm(corrected, 'yes')).body.state).toBe('done');
      expect(h.envelope.intents).toHaveLength(1);
      expect(h.envelope.intents[0]).toMatchObject({
        intent_id: 'k',
        recipient: RIYA,
        chain_id: ARB,
        amount_per_payment: { value: '10' },
        schedule: { frequency: 'weekly', interval: 1, days_of_week: ['FRI'] },
      });
      expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
      expect(h.llm.remaining()).toEqual([]);
    },
  );

  it('retains a currency-bearing amount supplied in a previous answer when the recipient changes', async () => {
    const h = make('prior-amount', [...opening('Yash', null, true), route('recipient', 'Riya'), paired(true)]);
    const missing = await h.say('pay Yash every friday for 3 weeks');
    expect(missing.body.question?.code).toBe('Q_AMOUNT_MISSING');
    const pending = await h.answer(missing, { text: '10 usd' });
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const corrected = await h.answer(pending, { text: 'pay Riya instead' });
    expect(corrected.body.state).toBe('awaiting_confirmation');
    expect(corrected.body.summary?.text).toContain('10 USDC');
    expect(corrected.body.summary?.text).toContain('every Fri');
    expect(h.llm.recorded.filter((c) => c.name === 'amounts')).toHaveLength(1);
    expect(h.llm.recorded.find((c) => c.name === 'conversation')?.user).toContain('10 usd');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it.each(['answers', 'messages'] as const)(
    'accepts an offered token copied from a polite reply via /%s',
    async (channel) => {
      const initial = opening('Riya');
      initial[0] = call('amounts', { amounts: [{ ...amount(), phrase: '10', token: null }] });
      const h = make(`polite-token-${channel}`, [initial[0], route('answer', 'USDC'), ...initial.slice(1), paired()]);
      const pending = await h.say('pay Riya 10');
      expect(pending.body.question?.code).toBe('Q_TOKEN');
      const summary = await respond(h, pending, 'USDC please', channel);
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.summary?.text).toContain('10 USDC');
      expect(h.exec.submissions).toHaveLength(0);
      expect(h.rows('SELECT amount, token, source FROM db1_amount_placeholders')).toEqual([
        { amount: '10', token: 'USDC', source: 'user' },
      ]);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents[0]).toMatchObject({ recipient: RIYA, token: 'USDC', amount: { value: '10' } });
      expect(h.llm.remaining()).toEqual([]);
    },
  );

  it.each([
    { text: 'USDC please and pay Mihir', value: 'USDC' },
    { text: "please don't use USDC", value: 'USDC' },
    { text: 'USDC please', value: 'ETH' },
    { text: 'DAI please', value: 'DAI' },
  ])('keeps Q_TOKEN open when a copied choice is unsafe or unavailable: $text / $value', async ({ text, value }) => {
    const h = make('invalid-token-answer', [
      call('amounts', { amounts: [{ ...amount(), phrase: '10', token: null }] }),
      route('answer', value),
    ]);
    const pending = await h.say('pay Riya 10');
    expect(pending.body.question?.code).toBe('Q_TOKEN');
    const response = await h.answer(pending, { text });
    expect(response.body.question).toEqual(pending.body.question);
    expect(response.body.request_id).toBe(pending.body.request_id);
    expect(h.count('db1_amount_placeholders')).toBe(0);
    expect(h.count('db3_address_placeholders')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
    expect(h.llm.remaining()).toEqual([]);
  });

  it('extracts a recipient from a sentence at Q_NO_PAYEE instead of saving the sentence as a name', async () => {
    const h = make('no-payee', [...opening(''), route('answer', 'Riya'), paired()]);
    const pending = await h.say('send 10 usdc');
    expect(pending.body.question?.code).toBe('Q_NO_PAYEE');
    const summary = await h.answer(pending, { text: 'please send it to Riya' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.summary?.text).toContain('Riya');
    expect(h.rows<{ name: string }>('SELECT name FROM db3_address_placeholders')).toEqual([{ name: 'Riya' }]);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('parses a natural address answer through normal resolution', async () => {
    const h = make('address-answer', [...opening(), route('answer', RIYA), paired()]);
    const pending = await h.say('pay Yash 10 usdc');
    const summary = await h.answer(pending, { text: `her address is ${RIYA}` });
    expect(summary.body.state).toBe('awaiting_confirmation');
    await h.confirm(summary, 'yes');
    expect(h.envelope.intents[0]).toMatchObject({ recipient: RIYA, amount: { value: '10' } });
    expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
  });

  it.each(['Q_WHO_IS', 'Q_ADDRESS_REENTER'] as const)(
    'validates an explicit address mislabeled as a recipient correction at %s',
    async (code) => {
      const address = addr(55);
      const name = code === 'Q_WHO_IS' ? 'Yash' : 'missing.eth';
      const initial = opening(name);
      if (code === 'Q_ADDRESS_REENTER')
        initial[2] = call('spans', { spans: [{ text: name, kind: 'ens', role: 'payee' }] });
      const h = make(`address-classification-${code}`, [...initial, route('recipient', address), paired()]);
      const pending = await h.say(`pay ${name} 10 usdc`);
      expect(pending.body.question?.code).toBe(code);
      const corrected = await h.answer(pending, { text: `his address is ${address}` });
      expect(corrected.body.request_id).toBe(pending.body.request_id);
      expect(corrected.body.question?.code).toBe('Q_ADDRESS_CORRECT');
      expect(h.repos.db2.findByAddress(address)).toEqual([]);
      expect(h.exec.submissions).toHaveLength(0);
      const naming = await h.answer(corrected, { chipLabel: 'Yes' });
      expect(naming.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
      if (code === 'Q_WHO_IS') expect(naming.body.question?.prefill).toBe('Yash');
      const summary = await h.answer(naming, { text: 'Yash' });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(h.exec.submissions).toHaveLength(0);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents[0]).toMatchObject({ recipient: address, amount: { value: '10' } });
    },
  );

  it('does not discard additional instructions when a compound address reply is mislabeled as a correction', async () => {
    const h = make('compound-address', [...opening(), route('recipient', RIYA)]);
    const pending = await h.say('pay Yash 10 usdc');
    const response = await h.answer(pending, { text: `his address is ${RIYA} but only send 5 usdc` });
    expect(response.body.question).toEqual(pending.body.question);
    expect(h.count('db3_address_placeholders')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('carries a corrected unknown name through address confirmation without saving an old-name alias', async () => {
    const h = make('new-name', [...opening(), route('recipient', 'Riya'), paired()], false);
    const pending = await h.say('pay Yash 10 usdc');
    const renamed = await h.answer(pending, { text: 'pay Riya instead' });
    expect(renamed.body.question?.code).toBe('Q_WHO_IS');
    expect(renamed.body.question?.text).toContain('Riya');
    expect(renamed.body.question?.question_id).not.toBe(pending.body.question?.question_id);
    const address = await h.answer(renamed, { text: RIYA });
    expect(address.body.question?.code).toBe('Q_ADDRESS_CORRECT');
    const naming = await h.answer(address, { chipLabel: 'Yes' });
    expect(naming.body.question?.code).toBe('Q_NAME_FOR_ADDRESS');
    expect(naming.body.question?.prefill).toBe('Riya');
    const summary = await h.answer(naming, { text: 'Riya' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(h.repos.db2.findByNameKey('riya').length).toBeGreaterThan(0);
    expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('supports a bare replacement name at Q_ADDRESS_REENTER', async () => {
    const initial = opening();
    initial[2] = call('spans', { spans: [{ text: 'missing.eth', kind: 'ens', role: 'payee' }] });
    const h = make('reenter', [...initial, route('recipient', 'Riya'), paired()]);
    const pending = await h.say('pay missing.eth 10 usdc');
    expect(pending.body.question?.code).toBe('Q_ADDRESS_REENTER');
    const summary = await h.answer(pending, { text: 'Riya' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.summary?.text).toContain('Riya');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it.each(['answers', 'messages'] as const)(
    'starts a new request unchanged via /%s and rejects the old question',
    async (channel) => {
      const text = 'send 20 usdc to Mihir on arbitrum';
      const h = make(`new-${channel}`, [
        ...opening(),
        route('new_request'),
        ...opening('Mihir', '20'),
        paired(false, ARB),
      ]);
      const pending = await h.say('pay Yash 10 usdc');
      const summary = await respond(h, pending, text, channel);
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(summary.body.request_id).not.toBe(pending.body.request_id);
      expect(h.llm.recorded.filter((c) => c.name === 'amounts').at(-1)?.user).toContain(`<<<${text}>>>`);
      expect((await h.answer(pending, { text: RIYA })).http).toBe(409);
      expect((await h.confirm(pending, 'yes')).http).toBe(409);
      expect(h.exec.submissions).toHaveLength(0);
      await h.confirm(summary, 'yes');
      expect(h.envelope.intents[0]).toMatchObject({ recipient: MIHIR, chain_id: ARB, amount: { value: '20' } });
    },
  );

  it('routes a message with new attached content through S1 without exposing the document to conversation', async () => {
    const h = make('new-document', [
      ...opening(),
      call('quarantine', { items: [{ address: RIYA, ens_name: null, amount: '12', token: 'USDC' }] }),
      ...opening('', null),
      paired(),
    ]);
    const pending = await h.say('pay Yash 10 usdc');
    const invoice = await h.say('pay this invoice', { pasted_blocks: [`DOCUMENT_ONLY 12 USDC to ${RIYA}`] });
    expect(invoice.body.request_id).not.toBe(pending.body.request_id);
    expect(invoice.body.question?.code).toBe('Q_UNTRUSTED_AMOUNT');
    expect(h.llm.recorded.filter((c) => c.name === 'conversation')).toHaveLength(0);
    const summary = await h.answer(invoice, { chipLabel: 'Use this amount' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('keeps the pending question and attempt through repeated requests for help', async () => {
    const h = make('help', [...opening(), ...Array.from({ length: 5 }, () => route('clarify'))]);
    const pending = await h.say('pay Yash 10 usdc');
    for (let n = 0; n < 5; n++) {
      const response = await h.answer(pending, { text: 'why do you need that?' });
      expect(response.body.state).toBe('awaiting_answer');
      expect(response.body.request_id).toBe(pending.body.request_id);
      expect(response.body.question).toEqual(pending.body.question);
      expect(response.body.messages.length).toBeGreaterThan(0);
    }
    expect(h.count('db3_address_placeholders')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it.each(['thanks', 'hmm'])(
    'does not spend an amount-validation attempt on the conversational reply %s',
    async (text) => {
      const h = make('one-word', [...opening('Yash', null).slice(0, 2), route('clarify')]);
      const pending = await h.say('send to Yash');
      expect(pending.body.question?.code).toBe('Q_AMOUNT_MISSING');
      const response = await h.answer(pending, { text });
      expect(response.body.state).toBe('awaiting_answer');
      expect(response.body.question).toEqual(pending.body.question);
      expect(h.llm.recorded.filter((c) => c.name === 'conversation')).toHaveLength(1);
      expect(h.count('db1_amount_placeholders')).toBe(0);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it.each(['please don’t cancel this', 'never cancel this request'])(
    'does not discard a request when a mistaken cancel classification contradicts %s',
    async (text) => {
      const h = make('negative-cancel', [...opening(), route('cancel')]);
      const pending = await h.say('pay Yash 10 usdc');
      const response = await h.answer(pending, { text });
      expect(response.body.state).toBe('awaiting_answer');
      expect(response.body.question).toEqual(pending.body.question);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it.each([
    { text: 'please cancel this request', interpretation: true },
    { text: 'never mind', interpretation: false },
  ])('honors an unambiguous draft cancellation: $text', async ({ text, interpretation }) => {
    const h = make('positive-cancel', [...opening(), ...(interpretation ? [route('cancel')] : [])]);
    const pending = await h.say('pay Yash 10 usdc');
    const response = await h.answer(pending, { text });
    expect(response.body.state).toBe('done');
    expect(response.body.messages).toContainEqual({ type: 'text', text: 'Cancelled. Nothing was sent.' });
    expect((await h.answer(pending, { text: RIYA })).http).toBe(409);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('preserves the pending request after both interpretation attempts fail', async () => {
    const h = make('model-failed', [
      ...opening(),
      call('conversation', null),
      { ...call('conversation', null), attempt: 2 },
    ]);
    const pending = await h.say('pay Yash 10 usdc');
    const response = await h.answer(pending, { text: 'pay Riya instead' });
    expect(response.body.state).toBe('awaiting_answer');
    expect(response.body.question).toEqual(pending.body.question);
    expect(response.body.error).toBeUndefined();
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('explains a cancellation question without treating a self-reference sentence as a recipient', async () => {
    const h = make('cancel-help', [
      call('amounts', { amounts: [] }),
      call('request_type', { request_type: 'actions', actions: ['l'], also_balance: false }),
      call('spans', { spans: [] }),
      route('clarify'),
    ]);
    const pending = await h.say('stop the recurring payment');
    expect(pending.body.question?.code).toBe('Q_NO_PAYEE');
    const response = await h.answer(pending, { text: 'I have to be paid for it' });
    expect(response.body.question).toEqual(pending.body.question);
    expect(response.body.messages.map((m) => m.text).join(' ')).toContain('remaining funds to your wallet');
    expect(h.count('db3_address_placeholders')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('corrects an unknown recipient previously supplied as a Q_NO_PAYEE answer', async () => {
    const h = make('prior-recipient', [...opening(''), route('recipient', 'Riya'), paired()]);
    const noPayee = await h.say('send 10 usdc');
    const pending = await h.answer(noPayee, { text: 'Yash' });
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const summary = await h.answer(pending, { text: 'pay Riya instead' });
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.summary?.text).toContain('10 USDC to Riya');
    expect(h.repos.db2.findByNameKey('yash')).toEqual([]);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('does not reinterpret several occurrences of the same unresolved payee as one correction target', async () => {
    const h = make('repeated-target', [
      call('amounts', { amounts: [amount('10'), amount('20')] }),
      call('request_type', { request_type: 'actions', actions: ['i'], also_balance: false }),
      call('spans', { spans: ['Yash', 'Yash'].map((text) => ({ text, kind: 'name', role: 'payee' })) }),
      route('recipient', 'Riya'),
    ]);
    const pending = await h.say('send 10 usdc to Yash and 20 usdc to Yash');
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    const response = await h.answer(pending, { text: 'pay Riya instead' });
    expect(response.body.question).toEqual(pending.body.question);
    expect(h.count('db3_address_placeholders')).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('keeps invoice amounts untrusted when the user corrects only the document recipient', async () => {
    const h = make('invoice-provenance', [
      call('quarantine', { items: [{ address: null, ens_name: 'unknown.eth', amount: '120', token: 'USDC' }] }),
      ...opening('', null),
      route('recipient', 'Riya'),
      paired(),
    ]);
    h.setBalances({ [BASE]: { USDC: '200' } });
    const invoice = await h.say('pay this invoice', { pasted_blocks: ['Pay 120 USDC to unknown.eth.'] });
    expect(invoice.body.question?.code).toBe('Q_UNTRUSTED_AMOUNT');
    const pending = await h.answer(invoice, { chipLabel: 'Use this amount' });
    expect(pending.body.question?.code).toBe('Q_WHO_IS');
    expect(pending.body.question?.chips.some((chip) => chip.label === 'Look it up')).toBe(true);
    expect(h.ens.calls).toEqual([]);
    const response = await h.answer(pending, { text: 'pay Riya instead' });
    expect(response.body.error?.code).toBe('LIMIT_PER_TX');
    expect(response.body.question).toBeUndefined();
    expect(h.rows('SELECT amount, source FROM db1_amount_placeholders')).toEqual([
      { amount: '120', source: 'untrusted' },
    ]);
    expect(h.ens.calls).toEqual([]);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it('clarifies a recipient correction after planning without reusing the old summary as approval', async () => {
    const h = make('late-correction', [...opening('Mihir', '10', true), paired(true), route('recipient', 'Riya')]);
    const summary = await h.say('pay Mihir 10 usdc every friday for 3 weeks');
    expect(summary.body.state).toBe('awaiting_confirmation');
    h.advance(2 * 24 * 60);
    const pending = await h.confirm(summary, 'yes');
    expect(pending.body.question?.code).toBe('Q_AUTOPAY_START');
    const response = await h.answer(pending, { text: 'pay Riya instead' });
    expect(response.body.question).toEqual(pending.body.question);
    expect(h.exec.submissions).toHaveLength(0);
    expect(h.repos.handoffs.get(summary.body.request_id)).toBeUndefined();
  });

  it.each(['pay Riya 20 usdc instead', 'do not pay Riya', 'pay Riya and Mihir'])(
    'refuses to silently drop additional meaning in %s',
    async (text) => {
      const h = make('compound', [...opening(), route('recipient', 'Riya')]);
      const pending = await h.say('pay Yash 10 usdc');
      const response = await h.answer(pending, { text });
      expect(response.body.question).toEqual(pending.body.question);
      expect(h.count('db3_address_placeholders')).toBe(0);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it('does not accept a model-derived approval or trim a qualified yes to consent', async () => {
    const h = make('consent', [...opening('Mihir', '110'), paired(), route('answer', 'yes')]);
    h.setBalances({ [BASE]: { USDC: '200' } });
    const pending = await h.say('pay Mihir 110 usdc');
    expect(pending.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
    const response = await h.answer(pending, { text: 'yes, but use Riya instead' });
    expect(response.body.question).toEqual(pending.body.question);
    expect(h.exec.submissions).toHaveLength(0);
  });

  it.each(['answers', 'messages'] as const)(
    'screens encoded secrets before routing or storing /%s replies',
    async (channel) => {
      const h = make(`secret-${channel}`, opening());
      const pending = await h.say('pay Yash 10 usdc');
      const before = h.count('db8_prompts');
      const secret = 'ab'.repeat(32);
      const encoded = [...secret].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('');
      const response = await respond(h, pending, `use this https://example.org/?key=${encoded}`, channel);
      expect(response.body.error?.code).toBe('SECRET_DETECTED');
      expect(h.count('db8_prompts')).toBe(before);
      expect(h.llm.recorded.filter((c) => c.name === 'conversation')).toHaveLength(0);
      expect(h.fetcher.calls).toHaveLength(0);
      expect(h.exec.submissions).toHaveLength(0);
    },
  );

  it('preserves the submitted envelope and key when a correction is sent after timeout', async () => {
    const h = make('submitted', [...opening(), route('recipient', 'Riya'), paired()]);
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const pending = await h.say('pay Yash 10 usdc');
    const summary = await h.answer(pending, { text: 'pay Riya instead' });
    expect((await h.confirm(summary, 'yes')).body.error?.code).toBe('EXECUTION_UNAVAILABLE');
    const first = structuredClone(h.exec.submissions[0]);
    const calls = h.llm.recorded.length;
    expect((await h.answer(pending, { text: 'pay Mihir instead' })).http).toBe(409);
    expect((await h.say('pay Mihir instead')).body.error?.code).toBe('UNSUPPORTED_REQUEST');
    expect(h.llm.recorded).toHaveLength(calls);
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toEqual([first, first]);
  });

  it('serializes interpretation and lets session close wait without leaking session stores', async () => {
    const h = make('closing', [...opening(), route('clarify')]);
    const pending = await h.say('pay Yash 10 usdc');
    const entered = deferred();
    const release = deferred();
    const original = h.llm.call.bind(h.llm);
    h.llm.call = async <T>(args: LlmCallArgs): Promise<T> => {
      if (args.name === 'conversation') {
        entered.resolve();
        await release.promise;
      }
      return original<T>(args);
    };
    const interpreting = h.answer(pending, { text: 'why do you need that?' });
    await entered.promise;
    expect((await h.answer(pending, { text: 'pay Riya instead' })).http).toBe(409);
    let closed = false;
    const closing = h.close().then((status) => {
      closed = true;
      return status;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      expect((await h.say('cancel')).http).toBe(404);
    } finally {
      release.resolve();
    }
    expect((await interpreting).body.state).toBe('awaiting_answer');
    expect(await closing).toBe(204);
    for (const table of ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'])
      expect(h.count(table)).toBe(0);
    expect(h.exec.submissions).toHaveLength(0);
  });
});
