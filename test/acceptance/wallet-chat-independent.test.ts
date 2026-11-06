// Independent SQ-CHAT-02 HTTP review: fresh read-only wallet facts, no invented facts or payment-state changes.
// Real session manager, pipeline and SQLCipher; all model and network clients are deterministic fakes.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FixtureCall } from '../fakes/llm.js';
import { Harness, loadFixture, BASE, ARB, SEPOLIA, MIHIR, WALLET, addr, type Resp } from './harness.js';

const made: Harness[] = [];
const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
const route = (intent: 'wallet' | 'chat' | 'wallet_info') => call('chat_route', { intent });
const facts = (...ids: string[]) => call('chat', { facts: ids });
const IMMUTABLE = [
  'db1_amount_placeholders',
  'db2_address_book',
  'db3_address_placeholders',
  'db5_limits',
  'db6_spend_log',
  'db7_autopays',
  'db8_sessions',
  'db8_prompts',
  'db8_history',
  'handoff_journal',
];
const snapshot = (h: Harness) => h.snapshot(IMMUTABLE);
const responseText = (r: Resp) => r.body.messages.map((message) => message.text).join('\n');

function payment(name = 'mihir'): FixtureCall[] {
  const calls = structuredClone(loadFixture('A-55').calls);
  calls.forEach((item) => {
    item.match = '';
  });
  calls[2]!.output = { spans: [{ text: name, kind: 'name', role: 'payee' }] };
  return calls;
}

function make(id: string, calls: FixtureCall[]): Harness {
  const h = new Harness(`wallet-chat-independent-${id}`, { calls }, {});
  h.config.chat = { enabled: true, think: true };
  h.config.llm.think = false;
  made.push(h);
  return h;
}

function lastWallet(h: Harness) {
  const prompt = h.llm.recorded.filter((item) => item.name === 'chat').at(-1)!;
  return JSON.parse(prompt.user).wallet_context.wallet;
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

describe('SQ-CHAT-02 wallet knowledge over HTTP', () => {
  it('returns the configured address and exact refreshed balance without storing chat or leaking contacts/config/log values', async () => {
    const h = make('facts-and-privacy', [route('wallet_info'), facts('wallet_address', `balance_${BASE}_USDC`)]);
    h.addContact('HiddenPayee', addr(0x92), [BASE]);
    h.setBalances({ [BASE]: { USDC: '73.123457' } });
    await h.open();
    const before = snapshot(h);
    const response = await h.say('What is my wallet address and Base USDC balance?');
    expect(response.body.state).toBe('done');
    expect(responseText(response)).toContain(WALLET);
    expect(responseText(response)).toContain('73.123457');
    expect(snapshot(h)).toBe(before);
    expect(h.llm.names()).toEqual(['chat_route', 'chat']);
    expect(h.rpc.calls).toHaveLength(6);
    expect(h.ens.calls).toEqual([]);
    expect(h.fetcher.calls).toEqual([]);
    expect(h.exec.submissions).toEqual([]);
    const wallet = lastWallet(h);
    expect(wallet.address).toBe(WALLET);
    expect(wallet.chains.find((chain: { chain_id: number }) => chain.chain_id === BASE).tokens.USDC.balance).toBe(
      '73.123457',
    );
    const prompt = h.llm.recorded.at(-1)!.user;
    for (const value of ['HiddenPayee', addr(0x92), 'rpc.invalid', 'ui_token', 'execution_outbound_token'])
      expect(prompt).not.toContain(value);
    const logs = readFileSync(h.logFile, 'utf8');
    expect(logs).not.toContain(WALLET);
    expect(logs).not.toContain('73.123457');
    expect((await h.confirm(response, 'yes')).http).toBe(409);
  });

  it('uses a fresh snapshot for every wallet reply despite the previous assistant balance in chat history', async () => {
    const h = make('fresh-each-time', [
      route('wallet_info'),
      facts(`balance_${BASE}_USDC`),
      route('wallet_info'),
      facts(`balance_${BASE}_USDC`),
    ]);
    h.setBalances({ [BASE]: { USDC: '73.123457' } });
    const first = await h.say('What is my Base balance?');
    expect(responseText(first)).toContain('73.123457');
    h.advance(1);
    h.setBalances({ [BASE]: { USDC: '26.000001' } });
    const second = await h.say('And what is the balance now?');
    expect(responseText(second)).toContain('26.000001');
    expect(responseText(second)).not.toContain('73.123457');
    expect(
      lastWallet(h).chains.find((chain: { chain_id: number }) => chain.chain_id === BASE).tokens.USDC.balance,
    ).toBe('26.000001');
    expect(h.rpc.calls).toHaveLength(12);
    expect(h.count('db8_prompts')).toBe(0);
    expect(h.count('db8_history')).toBe(0);
  });

  it('marks unavailable cached balances null and renders an explicitly partial subtotal', async () => {
    const h = make('partial', [
      route('wallet_info'),
      facts(`balance_${ARB}_USDC`),
      route('wallet_info'),
      facts(`unavailable_${ARB}`, 'total_USDC'),
    ]);
    await h.say('What is my Arbitrum balance?');
    h.rpc.down.add(ARB);
    const response = await h.say('What are my balances now?');
    const wallet = lastWallet(h);
    expect(wallet.status).toBe('partial');
    expect(wallet.chains.find((chain: { chain_id: number }) => chain.chain_id === ARB).tokens).toBeNull();
    expect(wallet.facts).not.toHaveProperty(`balance_${ARB}_USDC`);
    expect(wallet.totals.USDC.balance).toBe('80');
    expect(responseText(response)).toMatch(/subtotal|readable/i);
    expect(responseText(response)).toMatch(/unavailable|couldn't|cannot/i);
    expect(h.count('db8_prompts')).toBe(0);
  });

  it.each(['answers', 'messages'] as const)(
    'preserves the exact pending question and attempt during wallet_info on /%s',
    async (channel) => {
      const native = payment('Yash');
      const h = make(`question-${channel}`, [
        route('wallet'),
        ...native.slice(0, 3),
        route('wallet_info'),
        facts('wallet_address'),
        native[3]!,
      ]);
      const pending = await h.say('send 10 usdc to Yash');
      expect(pending.body.question?.code).toBe('Q_WHO_IS');
      const before = snapshot(h);
      const response =
        channel === 'answers'
          ? await h.answer(pending, { text: 'What is my wallet address?' })
          : await h.say('What is my wallet address?');
      expect(response.body.request_id).toBe(pending.body.request_id);
      expect(response.body.question).toEqual(pending.body.question);
      expect(response.body.state).toBe('awaiting_answer');
      expect(responseText(response)).toContain(WALLET);
      expect(snapshot(h)).toBe(before);
      expect(h.rpc.calls).toHaveLength(12);
      expect(h.exec.submissions).toEqual([]);
      const summary = await h.answer(response, { text: MIHIR });
      expect(summary.body.state).toBe('awaiting_confirmation');
      expect(h.llm.names().filter((name) => name === 'amounts')).toHaveLength(1);
      expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
      expect(h.envelope.intents.at(-1)).toMatchObject({ recipient: MIHIR, amount: { value: '10' } });
    },
  );

  it('keeps a displayed summary intact while refreshing balances and still requires native confirmation', async () => {
    const h = make('summary', [route('wallet'), ...payment(), route('wallet_info'), facts('total_USDC')]);
    const summary = await h.say('send 10 usdc to mihir');
    const before = snapshot(h);
    h.setBalances({ [BASE]: { USDC: '79' }, [ARB]: { USDC: '61' } });
    const response = await h.say('How much do I currently have?');
    expect(response.body.summary).toEqual(summary.body.summary);
    expect(response.body.request_id).toBe(summary.body.request_id);
    expect(response.body.state).toBe('awaiting_confirmation');
    expect(snapshot(h)).toBe(before);
    expect(h.exec.submissions).toEqual([]);
    expect((await h.confirm(response, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toHaveLength(1);
    expect(h.envelope.request_id).toBe(summary.body.request_id);
  });

  it('can return the known wallet address when every balance refresh fails, without failing a pending draft', async () => {
    const native = payment('Yash');
    const h = make('all-unavailable', [
      route('wallet'),
      ...native.slice(0, 3),
      route('wallet_info'),
      facts('wallet_address', 'balances_unavailable'),
    ]);
    const pending = await h.say('send 10 usdc to Yash');
    const before = snapshot(h);
    for (const chain of [BASE, ARB, SEPOLIA]) h.rpc.down.add(chain);
    const response = await h.say('What is my wallet address and balance?');
    expect(response.body.question).toEqual(pending.body.question);
    expect(response.body.request_id).toBe(pending.body.request_id);
    expect(responseText(response)).toContain(WALLET);
    expect(lastWallet(h)).toMatchObject({ status: 'unavailable', totals: null });
    expect(snapshot(h)).toBe(before);
    expect(h.exec.submissions).toEqual([]);
  });

  it('rejects a fabricated wallet amount without consuming the pending question or treating it as a payment', async () => {
    const native = payment('Yash');
    const h = make('fabricated-reply', [
      route('wallet'),
      ...native.slice(0, 3),
      route('wallet_info'),
      call('chat', { intro: 'Your balance is 999 USDC.', facts: ['wallet_address'], closing: '' }),
      {
        ...call('chat', { intro: 'Your balance is 999 USDC.', facts: ['wallet_address'], closing: '' }),
        attempt: 2,
      },
    ]);
    const pending = await h.say('send 10 usdc to Yash');
    const before = snapshot(h);
    const response = await h.say('How much do I have?');
    expect(response.body.question).toEqual(pending.body.question);
    expect(responseText(response)).not.toContain('999');
    expect(snapshot(h)).toBe(before);
    expect(h.exec.submissions).toEqual([]);
    expect(h.llm.names().filter((name) => name === 'amounts')).toHaveLength(1);
  });

  it('preserves an ambiguously submitted envelope and its retry identity while showing fresh spendable facts', async () => {
    const h = make('handoff-retry', [
      route('wallet'),
      ...payment(),
      route('wallet_info'),
      facts(`pending_${BASE}_USDC`, 'total_spendable_USDC'),
    ]);
    h.exec.responses.push({ status: 'unavailable', cause: 'timeout' });
    const summary = await h.say('send 10 usdc to mihir');
    const failed = await h.confirm(summary, 'yes');
    const original = structuredClone(h.exec.submissions[0]);
    const before = snapshot(h);
    const response = await h.say('What is still spendable?');
    expect(response.body.request_id).toBe(summary.body.request_id);
    expect(response.body.error).toEqual(failed.body.error);
    expect(
      lastWallet(h).chains.find((chain: { chain_id: number }) => chain.chain_id === BASE).tokens.USDC.pending,
    ).toBe('10');
    expect(snapshot(h)).toBe(before);
    expect(h.exec.submissions).toEqual([original]);
    expect((await h.confirm(summary, 'yes')).body.state).toBe('done');
    expect(h.exec.submissions).toEqual([original, original]);
  });

  it('keeps mixed explanatory/payment instructions on the native pipeline with one balance refresh', async () => {
    const h = make('mixed-native', [route('wallet'), ...payment()]);
    const response = await h.say('Explain my balance and send 10 usdc to mihir');
    expect(response.body.state).toBe('awaiting_confirmation');
    expect(h.llm.names()).toEqual(['chat_route', 'amounts', 'request_type', 'spans', 'payments']);
    expect(h.rpc.calls).toHaveLength(6);
    expect(h.exec.submissions).toEqual([]);
  });

  it('rejects the observed overbroad amount phrase identically with chat enabled or disabled, preserving the full mixed message', async () => {
    const text = 'What is my balance, and send 10 USDC to Mihir on Base.';
    const amount = call('amounts', {
      amounts: [{ phrase: 'send 10 USDC', number: '10', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
    });
    const prompts: string[] = [];
    const errors: unknown[] = [];
    for (const enabled of [false, true]) {
      const h = make(`mixed-overbroad-phrase-${String(enabled)}`, [...(enabled ? [route('wallet')] : []), amount]);
      h.config.chat!.enabled = enabled;
      const response = await h.say(text);
      expect(response.body.state).toBe('error');
      expect(response.body.error?.code).toBe('UNSUPPORTED_REQUEST');
      expect(response.body.summary).toBeUndefined();
      expect(h.llm.names()).toEqual([...(enabled ? ['chat_route'] : []), 'amounts']);
      const extraction = h.llm.recorded.find((item) => item.name === 'amounts')!;
      expect(extraction.user).toBe(`Message: <<<${text}>>>`);
      expect(extraction.output).toEqual(amount.output);
      expect(extraction.valid).toBe(true);
      prompts.push(extraction.user);
      errors.push(response.body.error);
      expect(h.rpc.calls).toHaveLength(6);
      expect(h.exec.submissions).toEqual([]);
      for (const table of [
        'db1_amount_placeholders',
        'db3_address_placeholders',
        'db6_spend_log',
        'db7_autopays',
        'db8_history',
        'handoff_journal',
      ])
        expect(h.count(table)).toBe(0);
      const events = readFileSync(h.logFile, 'utf8')
        .trim()
        .split('\n')
        .map((line: string) => JSON.parse(line));
      expect(events).toContainEqual(
        expect.objectContaining({ event: 'unsupported_state', step: 's3', rule_id: 'S3_AMOUNT_SPAN_UNVERIFIED' }),
      );
      expect((await h.confirm(response, 'yes')).http).toBe(409);
    }
    expect(prompts[0]).toBe(prompts[1]);
    expect(errors[0]).toEqual(errors[1]);
  });

  it('retains an unsubmitted failed payment across wallet reads and validates a fresh amount correction', async () => {
    const initial = payment();
    initial[0]!.output = {
      amounts: [{ phrase: '200 usdc', number: '200', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
    };
    const correction = payment();
    correction[0]!.output = {
      amounts: [{ phrase: '50', number: '50', relative: null, token: null, fiat: null, role: 'pay' }],
    };
    correction[2]!.output = { spans: [] };
    correction[3]!.output = {
      payments: [
        {
          kind: 'i',
          amount: '$amount:0',
          recipient: '$session:0',
          chain: 'unstated',
          frequency: null,
          interval: null,
          times_per_week: null,
          days_of_week: null,
          day_of_month: null,
        },
      ],
    };
    const h = make('failed-context', [
      route('wallet'),
      ...initial,
      route('wallet_info'),
      facts('total_USDC'),
      route('wallet'),
      ...correction,
    ]);
    const failed = await h.say('send 200 usdc to mihir');
    expect(failed.body.error?.code).toBe('INSUFFICIENT_FUNDS');
    const before = snapshot(h);
    const balance = await h.say('What can I currently spend?');
    expect(balance.body.state).toBe('done');
    expect(snapshot(h)).toBe(before);
    const summary = await h.say('okay, send 50 instead');
    expect(summary.body.state).toBe('awaiting_confirmation');
    expect(summary.body.request_id).not.toBe(failed.body.request_id);
    expect(summary.body.summary?.text).toContain('50 USDC');
    expect(summary.body.summary?.text).toContain('to Mihir');
    expect(h.rows('SELECT address FROM db3_address_placeholders')).toEqual([{ address: MIHIR }]);
    expect(h.asked).toEqual([]);
    expect(h.rpc.calls).toHaveLength(18);
    for (const table of ['db6_spend_log', 'db8_history', 'handoff_journal']) expect(h.count(table)).toBe(0);
    expect(h.exec.submissions).toEqual([]);
  });

  it('serializes a wallet RPC refresh and waits for it before clearing a closed session', async () => {
    const native = payment('Yash');
    const h = make('rpc-close', [
      route('wallet'),
      ...native.slice(0, 3),
      route('wallet_info'),
      facts('wallet_address'),
    ]);
    const pending = await h.say('send 10 usdc to Yash');
    const entered = deferred();
    const release = deferred();
    const real = h.rpc.getEthBalance.bind(h.rpc);
    h.rpc.getEthBalance = async (chain) => {
      entered.resolve();
      await release.promise;
      return real(chain);
    };
    const running = h.answer(pending, { text: 'What is my wallet address?' });
    await entered.promise;
    expect((await h.say('What is my current balance?')).http).toBe(409);
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
    expect((await running).body.question).toEqual(pending.body.question);
    expect(await closing).toBe(204);
    for (const table of ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'])
      expect(h.count(table)).toBe(0);
    expect(h.exec.submissions).toEqual([]);
  });
});
