// Independent wallet-aware chat review: §8.1 refreshed balances, §10.1 exact spendable/pending/gas accounting,
// §16 local-only factual context. All dependencies are faked; wallet facts and their renderer are tested separately.
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { LlmFailed, type LlmCallArgs, type LlmClient } from '../../../src/contracts/llm.js';
import type { Db6Insert } from '../../../src/contracts/repos.js';
import { buildWalletContext } from '../../../src/session/wallet-context.js';
import { generateChatReply, generateWalletReply, type ChatContext } from '../../../src/session/general-chat.js';
import { makeTestContext, type TestContext } from '../../fakes/context.js';
import { seedBalances } from '../../fakes/repos.js';

const BASE = 84532;
const ARB = 421614;
const SEPOLIA = 11155111;

function seedExact(ctx: TestContext): void {
  seedBalances(
    ctx.repos,
    {
      [SEPOLIA]: { USDC: '9007199254.740993', ETH: '0.010000000000000001' },
      [BASE]: { USDC: '0.000007', ETH: '0.002000000000000002' },
      [ARB]: { USDC: '7.123456', ETH: '0.000000000000000003' },
    },
    ctx.now().toUTC().toISO()!,
  );
}

function pending(ctx: TestContext, amount: string, override: Partial<Db6Insert> = {}): void {
  ctx.repos.db6.insertMany([
    {
      request_id: 'req_000000000099',
      step: null,
      kind: 'payment',
      counts_toward_limit: true,
      chain_id: BASE,
      token: 'USDC',
      amount,
      recipient_address: null,
      intent_id: 'i',
      autopay_id: null,
      status: 'pending',
      tx_hash: null,
      created_at: ctx.now().toUTC().toISO()!,
      executed_at: null,
      ...override,
    },
  ]);
}

function model(output: unknown) {
  const calls: LlmCallArgs[] = [];
  const llm: LlmClient = {
    modelAvailable: async () => true,
    call: async <T>(args: LlmCallArgs): Promise<T> => {
      calls.push(args);
      return structuredClone(output) as T;
    },
  };
  return { llm, calls };
}

function groundedContext(): ChatContext {
  const ctx = makeTestContext();
  seedExact(ctx);
  return { state: 'IDLE', wallet: buildWalletContext(ctx) };
}

describe('Wallet context: exact facts with no side effects', () => {
  it('keeps micro-USDC and wei exact beyond safe JS integer precision, summing spendable balances after per-chain flooring', () => {
    const ctx = makeTestContext();
    seedExact(ctx);
    const before = structuredClone(ctx.repos.tables);
    const wallet = buildWalletContext(ctx);
    expect(wallet.address).toBe(getAddress(ctx.config.wallet.address));
    expect(wallet.refreshed_at).toBe(ctx.now().toUTC().toISO());
    expect(wallet.status).toBe('complete');
    expect(wallet.chains.find((chain) => chain.chain_id === BASE)?.tokens).toEqual({
      USDC: { balance: '0.000007', spendable: '0.000007', pending: '0', gas_reserve: '0' },
      ETH: { balance: '0.002000000000000002', spendable: '0.000000000000000002', pending: '0', gas_reserve: '0.002' },
    });
    expect(wallet.totals).toEqual({
      USDC: { balance: '9007199261.864456', spendable: '9007199261.864456', pending: '0', gas_reserve: '0' },
      ETH: { balance: '0.012000000000000006', spendable: '0.000000000000000003', pending: '0', gas_reserve: '0.014' },
    });
    expect(ctx.repos.tables).toEqual(before);
    expect(ctx.rpc.calls).toEqual([]);
    expect(ctx.llm.recorded).toEqual([]);
    expect(ctx.log.lines).toEqual([]);
  });

  it('subtracts only recent pending debit kinds and preserves separate pending and gas values', () => {
    const ctx = makeTestContext();
    ctx.limits.allowed_chain_ids = [BASE];
    seedBalances(ctx.repos, { [BASE]: { USDC: '100', ETH: '0.003' } });
    pending(ctx, '10');
    pending(ctx, '5', { kind: 'bridge_out', counts_toward_limit: false, intent_id: 'j' });
    pending(ctx, '2', { kind: 'autopay_prefund', counts_toward_limit: false, intent_id: 'k' });
    pending(ctx, '11', { kind: 'bridge_buffer', intent_id: 'j' });
    pending(ctx, '13', { kind: 'autopay_payment', intent_id: 'k' });
    pending(ctx, '19', { status: 'executed' });
    pending(ctx, '23', { status: 'failed' });
    pending(ctx, '29', { created_at: ctx.now().minus({ minutes: 10 }).toUTC().toISO()! });
    pending(ctx, '31', { created_at: ctx.now().minus({ minutes: 11 }).toUTC().toISO()! });
    pending(ctx, '0.0005', { token: 'ETH' });
    const wallet = buildWalletContext(ctx);
    expect(wallet.chains[0]?.tokens).toEqual({
      USDC: { balance: '100', spendable: '83', pending: '17', gas_reserve: '0' },
      ETH: { balance: '0.003', spendable: '0.0005', pending: '0.0005', gas_reserve: '0.002' },
    });
    expect(wallet.totals).toEqual(wallet.chains[0]?.tokens);
  });

  it('floors spendable at zero when pending debits exceed raw funds', () => {
    const ctx = makeTestContext();
    ctx.limits.allowed_chain_ids = [BASE];
    seedBalances(ctx.repos, { [BASE]: { USDC: '1', ETH: '0.001' } });
    pending(ctx, '2');
    expect(buildWalletContext(ctx).chains[0]?.tokens).toEqual({
      USDC: { balance: '1', spendable: '0', pending: '2', gas_reserve: '0' },
      ETH: { balance: '0.001', spendable: '0', pending: '0', gas_reserve: '0.002' },
    });
  });

  it('excludes disabled networks and contact inventory or private config from context', () => {
    const ctx = makeTestContext();
    seedExact(ctx);
    ctx.limits.allowed_chain_ids = [BASE];
    const wallet = buildWalletContext(ctx);
    expect(wallet.chains.map((chain) => chain.chain_id)).toEqual([BASE]);
    const json = JSON.stringify(wallet);
    for (const value of [
      'Aradhya',
      'Mihir',
      'rpc.invalid',
      'ui_token',
      'execution_outbound_token',
      ':memory:',
      '11155111',
      '421614',
    ]) {
      expect(json).not.toContain(value);
    }
    expect(wallet.facts.wallet_address).toContain(getAddress(ctx.config.wallet.address));
  });

  it('hides stale unavailable DB4 numbers and labels readable totals as partial', () => {
    const ctx = makeTestContext();
    seedExact(ctx);
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', ctx.now().toUTC().toISO()!);
    const wallet = buildWalletContext(ctx);
    expect(wallet.status).toBe('partial');
    expect(wallet.chains.find((chain) => chain.chain_id === ARB)).toMatchObject({
      status: 'unavailable',
      tokens: null,
    });
    expect(wallet.totals?.USDC.balance).toBe('9007199254.741');
    expect(wallet.facts.total_USDC).toMatch(/subtotal|readable/i);
    expect(wallet.facts).not.toHaveProperty(`balance_${ARB}_USDC`);
    expect(wallet.facts[`unavailable_${ARB}`]).toMatch(/unavailable|could not|couldn't|cannot/i);
    expect(JSON.stringify(wallet)).not.toContain('7.123456');
  });

  it('reports fully unavailable balances as null while retaining the configured address', () => {
    const ctx = makeTestContext();
    const wallet = buildWalletContext(ctx);
    expect(wallet.status).toBe('unavailable');
    expect(wallet.totals).toBeNull();
    expect(wallet.chains.every((chain) => chain.tokens === null)).toBe(true);
    expect(wallet.facts.wallet_address).toContain(getAddress(ctx.config.wallet.address));
    expect(wallet.facts.balances_unavailable).toMatch(/unavailable|could not|couldn't|cannot/i);
    expect(wallet.facts).not.toHaveProperty('total_USDC');
  });
});

describe('Wallet reply grounding: code-rendered labeled facts', () => {
  it('renders exact selected facts rather than allowing the model to supply wallet amounts or addresses', async () => {
    const context = groundedContext();
    const ids = ['wallet_address', `balance_${BASE}_USDC`, `spendable_${BASE}_ETH`];
    const { llm, calls } = model({ facts: ids });
    const reply = await generateWalletReply(llm, 'What is my balance and wallet address?', context, [], true);
    for (const id of ids) expect(reply).toContain(context.wallet!.facts[id]);
    expect(reply).toBe(ids.map((id) => context.wallet!.facts[id]).join('\n'));
    expect(reply).not.toContain(`balance_${BASE}_USDC`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.think).toBe(true);
    expect(calls[0]?.schema).toMatchObject({ additionalProperties: false });
  });

  it.each([
    { facts: ['invented_fact'] },
    { facts: ['wallet_address', 'wallet_address'] },
    { facts: [] },
    { intro: 'You have 999 USDC.', facts: ['wallet_address'] },
    { intro: 'You have fifty USDC.', facts: ['wallet_address'] },
    { intro: 'You have a dozen ETH.', facts: ['wallet_address'] },
    { facts: ['wallet_address'], closing: 'Your wallet is empty.' },
    { facts: ['wallet_address'], closing: 'The balance is one million USDC.' },
    { intro: 'Wallet: 0x1111111111111111111111111111111111111111', facts: ['wallet_address'] },
    { facts: ['wallet_address'], balance: '100' },
  ])('rejects ungrounded or malformed model output %#', async (output) => {
    const { llm } = model(output);
    await expect(generateWalletReply(llm, 'My wallet?', groundedContext(), [], false)).rejects.toBeInstanceOf(
      LlmFailed,
    );
  });

  it('cannot select an unavailable chain amount from stale chat assertions', async () => {
    const ctx = makeTestContext();
    seedExact(ctx);
    ctx.repos.db4.markUnavailable(ARB, 'Arbitrum Sepolia', ctx.now().toUTC().toISO()!);
    const context: ChatContext = { state: 'IDLE', wallet: buildWalletContext(ctx) };
    const { llm } = model({ facts: [`balance_${ARB}_USDC`] });
    await expect(
      generateWalletReply(
        llm,
        'How much there now?',
        context,
        [{ user: 'My Arbitrum balance?', assistant: 'You have 7.123456 USDC.' }],
        false,
      ),
    ).rejects.toBeInstanceOf(LlmFailed);
  });

  it('requires a fresh wallet snapshot before calling the wallet reply model', async () => {
    const { llm, calls } = model({ facts: ['wallet_address'] });
    await expect(generateWalletReply(llm, 'My balance?', { state: 'IDLE' }, [], false)).rejects.toBeInstanceOf(
      LlmFailed,
    );
    expect(calls).toEqual([]);
  });
});

describe('Configured wallet address in general chat', () => {
  it('permits the configured public address and passes no cached balance snapshot', async () => {
    const wallet = getAddress(makeTestContext().config.wallet.address);
    const { llm, calls } = model({ reply: `Your configured receiving address is ${wallet}.` });
    const reply = await generateChatReply(
      llm,
      'Explain the receiving address',
      { state: 'IDLE', wallet_address: wallet },
      [],
      true,
    );
    expect(reply).toContain(wallet);
    expect(JSON.parse(calls[0]!.user).wallet_context).toMatchObject({ wallet_address: wallet, wallet: null });
  });

  it('rejects an invented recipient address while allowing the verified pending summary address', async () => {
    const wallet = getAddress(makeTestContext().config.wallet.address);
    const recipient = '0x2222222222222222222222222222222222222222';
    const context: ChatContext = {
      state: 'AWAITING_CONFIRMATION',
      wallet_address: wallet,
      pending_summary: { text: `Send to the verified recipient (${recipient}).`, notes: [] },
    };
    const verified = model({ reply: `The displayed recipient address is ${recipient}.` });
    await expect(generateChatReply(verified.llm, 'Explain the recipient', context, [], false)).resolves.toContain(
      recipient,
    );
    const invented = model({ reply: 'The recipient address is 0x3333333333333333333333333333333333333333.' });
    await expect(generateChatReply(invented.llm, 'Explain the recipient', context, [], false)).rejects.toBeInstanceOf(
      LlmFailed,
    );
  });
});
