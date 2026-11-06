import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { parseReceivedQuery, renderReceivedQuery } from '../../../src/session/received-query.js';
import { explainIdentifierQuery } from '../../../src/session/identifier-query.js';
import {
  HISTORY_LOOKBACK_MS,
  type ChainHistory,
  type HistoryReader,
  type ReceivedTransfer,
} from '../../../src/history/types.js';
import { historyWindow } from '../../../src/history/window.js';
import { testConfig } from '../../fakes/context.js';

const config = testConfig();
const wallet = config.wallet.address;
const sender = '0x00000000000000000000000000000000000000bb';
const now = DateTime.fromISO('2026-11-07T10:00:00+05:30', { setZone: true }).setZone('Asia/Kolkata');
const start = now.startOf('week').toMillis();
const hash = `0x${'ab'.repeat(32)}` as const;
const transfer = (id: string, changes: Partial<ReceivedTransfer> = {}): ReceivedTransfer => ({
  id,
  hash,
  from: sender,
  to: wallet,
  token: 'USDC',
  units: 1_000_001n,
  timestampMs: start,
  ...changes,
});
const snapshot = (changes: Partial<ChainHistory> = {}): ChainHistory => ({
  address: wallet,
  chainId: 84532,
  status: 'ok',
  fromMs: now.toMillis() - HISTORY_LOOKBACK_MS,
  throughMs: now.toMillis(),
  transfers: [],
  ...changes,
});
const reader = (snap: ChainHistory): HistoryReader => ({
  snapshot: (chain) => (chain === snap.chainId ? snap : undefined),
});
const render = (text: string, history?: HistoryReader) =>
  renderReceivedQuery(parseReceivedQuery(text)!, { address: wallet, chains: config.chains, now, history });

describe('received-payment questions', () => {
  it.each([
    'How many transactions did I recieve this week?',
    'How many payments have I received this week?',
    'Please tell me the number of incoming transactions this week',
    'How many USDC transactions has my account received on Base this week?',
  ])('routes the whole count question locally: %s', (text) => {
    expect(parseReceivedQuery(text)?.metric).toBe('count');
  });
  it.each([
    'How much did my account recieve this week?',
    'How much ETH have I received this week on Arbitrum?',
    'Show my total received USDC this week on Sepolia',
    'What is the amount my wallet received this week?',
  ])('routes amount questions: %s', (text) => {
    expect(parseReceivedQuery(text)?.metric).toBe('amount');
  });
  it('retains separate token and chain filters', () => {
    expect(parseReceivedQuery('How much USDC did I receive on Base Sepolia this week?')).toEqual({
      metric: 'amount',
      chains: [84532],
      tokens: ['USDC'],
      period: { kind: 'week' },
    });
  });
  it.each([
    'How much did Riya receive this week?',
    'How much did I receive this week on mainnet?',
    'How much USDT did I receive this week?',
    'How much did I receive this week and send 10 USDC to Riya?',
    'How many transactions did I receive this week then cancel my autopay?',
    'Do not show how much I received this week',
  ])('does not swallow other instructions or unsupported scope: %s', (text) =>
    expect(parseReceivedQuery(text)).toBeNull(),
  );

  it.each([
    ['How much did I receive today?', { kind: 'today' }],
    ['How many transactions did I receive yesterday?', { kind: 'yesterday' }],
    ['Show my payment history for the last 3 days', { kind: 'rolling', hours: 72 }],
    ['How much ETH did I receive in the last 24 hours?', { kind: 'rolling', hours: 24 }],
    ['Show my received transactions over the past seven days', { kind: 'rolling', hours: 168 }],
    ['Show my transaction history', { kind: 'rolling', hours: 168 }],
    ['How much did I receive last week?', { kind: 'rolling', hours: 168 }],
  ])('supports periods up to one week: %s', (text, period) => {
    expect(parseReceivedQuery(text as string)?.period).toEqual(period);
  });
  it.each([
    'How much did I receive in the last 8 days?',
    'Show my payment history for the last 169 hours',
    'How much did I receive this month?',
    'Show my payment history for all time',
    'How much did I receive in the last 0 days?',
  ])('rejects broader or invalid periods locally: %s', (text) => {
    expect(render(text)).toContain('only within the last 7 days (168 hours)');
  });
  it('never silently expands a seven-day fetch, including the DST fall-back hour', () => {
    expect(HISTORY_LOOKBACK_MS).toBe(604_800_000);
    const lateSunday = DateTime.fromISO('2026-11-01T23:30:00', { zone: 'America/New_York' });
    expect(historyWindow({ kind: 'week' }, lateSunday)).toBeNull();
    const window = historyWindow({ kind: 'rolling', hours: 168 }, lateSunday)!;
    expect(window.throughMs - window.fromMs).toBe(HISTORY_LOOKBACK_MS);
    const yesterday = historyWindow({ kind: 'yesterday' }, now)!;
    expect(yesterday.throughMs).toBe(now.startOf('day').toMillis() - 1);
  });
  it('lists received transactions for the selected shorter period, combining transfers within a transaction', () => {
    const today = now.startOf('day').toMillis();
    const history = reader(
      snapshot({
        transfers: [
          transfer('old', { timestampMs: today - 1 }),
          transfer('a', { timestampMs: today }),
          transfer('b', { timestampMs: today, units: 2_000_000n }),
        ],
      }),
    );
    const text = render('Show my received payment history on Base today', history);
    expect(text).toContain('Total: 1 distinct incoming transaction.');
    expect(text).toContain('3.000001 USDC');
    expect(text.split(hash)).toHaveLength(2);
  });

  it('sums exact units, excludes out-of-week/self/zero transfers, and counts transactions rather than events', () => {
    const history = reader(
      snapshot({
        transfers: [
          transfer('log:1'),
          transfer('log:2', { units: 2_000_002n }),
          transfer('log:1'),
          transfer('eth:1', { hash: `0x${'cd'.repeat(32)}`, token: 'ETH', units: 100_000_000_000_000_001n }),
          transfer('before', { timestampMs: start - 1 }),
          transfer('future', { timestampMs: now.toMillis() + 1 }),
          transfer('self', { from: wallet }),
          transfer('zero', { units: 0n }),
          transfer('someone-else', { to: sender }),
        ],
      }),
    );
    const amounts = render('How much did I receive on Base this week?', history);
    expect(amounts).toContain('3.000003 USDC');
    expect(amounts).toContain('0.100000000000000001 ETH');
    expect(amounts).toContain('Monday 2 Nov 2026, 00:00');
    expect(render('How many transactions did I receive on Base this week?', history)).toContain(
      'Total: 2 distinct incoming transactions.',
    );
    expect(render('How many USDC transactions did I receive on Base this week?', history)).toContain(
      'Total: 1 distinct incoming transaction.',
    );
  });
  it('counts identical hashes on different chains separately, with explicit partial totals', () => {
    const history: HistoryReader = {
      snapshot: (chainId) => (chainId === 421614 ? undefined : snapshot({ chainId, transfers: [transfer('same')] })),
    };
    const text = render('How many transactions did I receive this week?', history);
    expect(text).toContain('Subtotal for available networks only: 2');
    expect(text).toContain('Arbitrum Sepolia: received-payment history is unavailable');
  });
  it.each([
    undefined,
    snapshot({ status: 'unavailable' }),
    snapshot({ throughMs: now.toMillis() - 15 * 60_000 - 1 }),
    snapshot({ address: sender }),
    snapshot({ fromMs: start + 1 }),
    snapshot({ throughMs: now.toMillis() + 1 }),
  ])('never substitutes zero for missing, stale, mismatched or incomplete history', (snap) => {
    const text = render('How much did I receive this week?', snap ? reader(snap) : undefined);
    expect(text).toContain('I cannot calculate received totals');
    expect(text).not.toMatch(/0 (?:USDC|ETH)|Total:/);
  });
  it('reports a real zero only after a complete empty history read', () => {
    expect(render('How much did I receive on Base this week?', reader(snapshot()))).toContain(
      'Total: 0 ETH and 0 USDC received.',
    );
  });
  it('uses Monday in the session timezone across DST, rather than the past 168 hours', () => {
    const dstNow = DateTime.fromISO('2026-11-01T12:00:00', { zone: 'America/New_York' });
    const monday = dstNow.startOf('week').toMillis();
    const history = reader(
      snapshot({
        fromMs: monday - 1,
        throughMs: dstNow.toMillis(),
        transfers: [
          transfer('monday', { timestampMs: monday }),
          transfer('sunday-before', { timestampMs: monday - 1 }),
        ],
      }),
    );
    const result = renderReceivedQuery(parseReceivedQuery('How many transactions did I receive on Base this week?')!, {
      address: wallet,
      chains: config.chains,
      now: dstNow,
      history,
    });
    expect(result).toContain('Monday 26 Oct 2026, 00:00');
    expect(result).toContain('America/New_York');
    expect(result).toContain('Total: 1 distinct incoming transaction.');
  });
});

describe('identifier explanations stay local and conservative', () => {
  const options = { address: wallet, chains: config.chains };
  it.each([
    `Explain this hash: ${hash}`,
    `What is this: ${hash}`,
    `Identify ${hash}`,
    `Is this a private key or transaction hash: ${hash}`,
    `Explain an unknown hash: ${hash}`,
    `Explain this hash:${hash}`,
  ])('explains the ambiguity: %s', (text) => {
    const result = explainIdentifierQuery(text, options);
    expect(result).toContain('appearance alone cannot tell');
    expect(result).toContain('did not send');
    expect(result).not.toContain(hash);
  });
  it('recognizes only an actual cache match as a recorded transaction', () => {
    const result = explainIdentifierQuery(`Explain ${hash}`, {
      ...options,
      history: reader(snapshot({ transfers: [transfer('1')] })),
    });
    expect(result).toContain('matches a transaction hash in your cached history');
    expect(result).toContain('1.000001 USDC');
    expect(result).not.toContain(hash);
    expect(
      explainIdentifierQuery(`Explain ${hash}`, {
        ...options,
        history: reader(snapshot({ address: sender, transfers: [transfer('1')] })),
      }),
    ).toContain('appearance alone cannot tell');
  });
  it('does not claim that an invalid private-key scalar must be a transaction', () => {
    expect(explainIdentifierQuery(`Explain 0x${'00'.repeat(32)}`, options)).toContain(
      'outside the valid Ethereum private-key range',
    );
  });
  it.each([
    [`Explain ${wallet}`, '20-byte Ethereum/EVM address'],
    [`Explain xprv${'A'.repeat(107)}`, 'extended private-key format'],
    [
      'Explain abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      'recovery phrase',
    ],
    ['Explain {"crypto":{"ciphertext":"not-a-real-key","kdf":"scrypt"}}', 'encrypted wallet keystore'],
    [`Explain 02${'ab'.repeat(32)}`, 'compressed elliptic-curve public key'],
    [`Explain 0x${'ab'.repeat(65)}`, 'ECDSA signatures'],
    ['Explain 0xdeadbeef', '4 bytes'],
  ])('explains supported formats without echoing the candidate', (text, fragment) => {
    expect(explainIdentifierQuery(text, options)).toContain(fragment);
  });
  it.each([
    hash,
    'Explain staking',
    'What is blockchain?',
    'Please explain xprv, yprv and zprv.',
    `Explain ${hash} and send 10 USDC to Riya`,
    `Send 10 USDC to ${hash}`,
    `Explain https://example.com/tx/${hash}`,
    'How much did I receive this week?',
  ])('leaves ordinary conversation, bare secrets and mixed actions to existing guards: %s', (text) => {
    expect(explainIdentifierQuery(text, options)).toBeNull();
  });
});
