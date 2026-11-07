// The CLI follows a handed-off request in the wallet: green when a transaction went through, red when it did not.
import { describe, expect, it } from 'vitest';
import {
  describeStep,
  namesFromSummary,
  progressLines,
  watchRequest,
  type StepView,
} from '../../../src/cli/agent/progress.js';
import type { Line } from '../../../src/cli/repl.js';

const SOHAM = '0x141A811C87980B283aa6cC9E1B19d945FAA7ac78';
const ABHI = '0x6b522Bc45F1007E08024d676F9d2428Ab90a9d89';
const HASH = `0x${'ab'.repeat(32)}`;

const step = (over: Partial<StepView> = {}): StepView => ({
  step: 0,
  kind: 'i',
  chain_id: 84532,
  token: 'USDC',
  recipients: [{ address: ABHI, amount: '1' }],
  state: 'preparing',
  tx_hash: null,
  error_code: null,
  ...over,
});
const text = (lines: Line[]) => lines.map((l) => l.map((s) => s.text).join(''));
const tones = (lines: Line[]) => [...new Set(lines.flatMap((l) => l.map((s) => s.tone)))];

describe('describing a step', () => {
  it('uses the names from the summary you confirmed, matched by the exact short address', () => {
    const names = namesFromSummary([
      '1. Send 1 USDC to Soham (0x141A…ac78) on Arbitrum Sepolia.',
      '2. Send 1 USDC to Abhivansh (0x6b52…9d89) on Base Sepolia.',
    ]);
    expect(describeStep(step(), names)).toBe('1 USDC to Abhivansh (0x6b52…9d89) on Base Sepolia');
    expect(describeStep(step({ chain_id: 421614, recipients: [{ address: SOHAM, amount: '1' }] }), names)).toBe(
      '1 USDC to Soham (0x141A…ac78) on Arbitrum Sepolia',
    );
    expect(describeStep(step())).toBe('1 USDC to 0x6b52…9d89 on Base Sepolia');
  });

  it('describes bridges, batches, recurring plans and cancellations', () => {
    expect(describeStep(step({ kind: 'j', chain_id: 11155111, dest_chain_id: 84532, amount: '5' }))).toBe(
      '5 USDC from Ethereum Sepolia to Base Sepolia',
    );
    expect(
      describeStep(
        step({
          recipients: [
            { address: SOHAM, amount: '1' },
            { address: ABHI, amount: '2' },
          ],
        }),
      ),
    ).toBe('USDC to 2 recipients on Base Sepolia');
    expect(describeStep(step({ kind: 'k' }))).toBe('Recurring 1 USDC to 0x6b52…9d89 on Base Sepolia');
    expect(describeStep(step({ kind: 'l' }))).toBe('Cancel a recurring payment on Base Sepolia');
  });
});

describe('progress lines', () => {
  it('prints a green block with the explorer link once a transaction is confirmed, and only once', () => {
    const said = new Map();
    expect(progressLines([step({ state: 'awaiting_approval' })], said, new Map())).toEqual([]);
    const ok = progressLines([step({ state: 'confirmed', tx_hash: HASH })], said, new Map());
    expect(text(ok)).toEqual([
      '✓ Went through · 1 USDC to 0x6b52…9d89 on Base Sepolia',
      `  https://sepolia.basescan.org/tx/${HASH}`,
    ]);
    expect(tones(ok)).toEqual([5]);
    expect(progressLines([step({ state: 'confirmed', tx_hash: HASH })], said, new Map())).toEqual([]);
    expect(progressLines([step({ state: 'completed', tx_hash: HASH })], said, new Map())).toEqual([]);
  });

  it('prints a red block with the reason when a step did not go through', () => {
    const said = new Map();
    const bad = progressLines([step({ state: 'failed', error_code: 'USER_REJECTED' })], said, new Map());
    expect(text(bad)).toEqual([
      '✗ Did not go through · 1 USDC to 0x6b52…9d89 on Base Sepolia',
      '  You rejected it in MetaMask.',
    ]);
    expect(tones(bad)).toEqual([6]);
    const reverted = progressLines(
      [step({ step: 1, state: 'failed', error_code: 'TX_REVERTED', tx_hash: HASH })],
      said,
      new Map(),
    );
    expect(text(reverted)).toContain(`  https://sepolia.basescan.org/tx/${HASH}`);
    expect(
      text(progressLines([step({ step: 2, state: 'failed', error_code: 'NEW_CODE' })], said, new Map())),
    ).toContain('  The wallet stopped it (NEW_CODE).');
  });

  it('reports each step of a request on its own, in green or red', () => {
    const lines = progressLines(
      [
        step({ state: 'confirmed', tx_hash: HASH }),
        step({ step: 1, chain_id: 421614, state: 'failed', error_code: 'USER_REJECTED' }),
      ],
      new Map(),
      new Map(),
    );
    expect(lines.map((l) => l[0]!.tone)).toEqual([5, 5, 6, 6]);
  });

  it('says a bridge went through on the source, then again when it is delivered', () => {
    const said = new Map();
    const bridge = step({ kind: 'j', chain_id: 11155111, dest_chain_id: 84532, amount: '5', tx_hash: HASH });
    const sent = progressLines([{ ...bridge, state: 'confirmed' }], said, new Map());
    expect(text(sent)[0]).toBe('✓ Went through · 5 USDC from Ethereum Sepolia to Base Sepolia');
    expect(text(sent).at(-1)).toContain('I will tell you when the bridge delivers it.');
    const delivered = progressLines([{ ...bridge, state: 'completed' }], said, new Map());
    expect(text(delivered)).toEqual(['✓ Delivered · 5 USDC arrived on Base Sepolia']);
    expect(tones(delivered)).toEqual([5]);
  });

  it('turns red if a step that looked confirmed fails afterwards', () => {
    const said = new Map();
    progressLines([step({ state: 'confirmed', tx_hash: HASH })], said, new Map());
    const later = progressLines(
      [step({ state: 'failed', error_code: 'EFFECT_MISSING', tx_hash: HASH })],
      said,
      new Map(),
    );
    expect(tones(later)).toEqual([6]);
  });

  it('mentions a pending smart-account setup once, without colour', () => {
    const said = new Map();
    const first = progressLines([step({ state: 'needs_setup' })], said, new Map());
    expect(text(first)).toEqual(['Waiting for the smart-account setup on Base Sepolia in your wallet page.']);
    expect(tones(first)).toEqual([1]);
    expect(progressLines([step({ state: 'needs_setup' })], said, new Map())).toEqual([]);
  });
});

describe('following a request', () => {
  it('asks the wallet with its token until every step has an outcome, then stops', async () => {
    const replies: StepView[][] = [
      [step({ state: 'awaiting_approval' })],
      [step({ state: 'confirming', tx_hash: HASH })],
      [step({ state: 'confirmed', tx_hash: HASH })],
      [step({ state: 'completed', tx_hash: HASH })],
    ];
    const calls: { url: string; auth: string | null }[] = [];
    const out: Line[] = [];
    const watch = watchRequest({
      walletUrl: 'http://127.0.0.1:8788/',
      token: 'wallet-token',
      requestId: 'req_0123456789ab',
      onLines: (lines) => out.push(...lines),
      intervalMs: 1,
      slowIntervalMs: 1,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get('authorization') });
        return new Response(JSON.stringify({ steps: replies[Math.min(calls.length - 1, replies.length - 1)] }));
      }) as typeof fetch,
    });
    await watch.done;
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      url: 'http://127.0.0.1:8788/v1/intents/req_0123456789ab',
      auth: 'Bearer wallet-token',
    });
    expect(text(out)[0]).toBe('✓ Went through · 1 USDC to 0x6b52…9d89 on Base Sepolia');
  });

  it('keeps asking through wallet errors and stops when told to', async () => {
    let calls = 0;
    const watch = watchRequest({
      walletUrl: 'http://127.0.0.1:8788',
      token: 't',
      requestId: 'req_0123456789ab',
      onLines: () => undefined,
      intervalMs: 1,
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) throw new Error('down');
        return new Response('{}', { status: 500 });
      }) as unknown as typeof fetch,
    });
    while (calls < 3) await new Promise((r) => setTimeout(r, 2));
    watch.stop();
    await watch.done;
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('gives up after its time limit and says so', async () => {
    const out: Line[] = [];
    const watch = watchRequest({
      walletUrl: 'http://127.0.0.1:8788',
      token: 't',
      requestId: 'req_0123456789ab',
      onLines: (lines) => out.push(...lines),
      intervalMs: 1,
      maxMs: -1,
      fetchImpl: (async () => new Response(JSON.stringify({ steps: [step()] }))) as unknown as typeof fetch,
    });
    await watch.done;
    expect(text(out)).toEqual(['Stopped following this request. The wallet page shows where it is.']);
  });
});
