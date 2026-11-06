import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';
import { executionsOf } from '../../src/chain/redeem.v2.js';
import { checkEnvelope } from '../../src/mapping/check.js';
import { callsOf, encodeExecuteBatch, paymentTookEffect } from '../../src/payments/payment-i.js';
import type { Intent } from '../../src/schemas/intent.v2.js';
import { USDC } from '../../src/schemas/intent.v2.js';
import { ALEX, BASE, BOB, WALLET, envelope, payEth, payUsdc } from '../support/envelopes.js';
import { transferLog } from '../support/fake-chain.js';

describe('building the batch (rules 1 and 3)', () => {
  it('USDC is a transfer on the token, with no native value (B1)', () => {
    const [call] = callsOf(payUsdc(0, [[ALEX, '10.5']]));
    expect(call?.target).toBe(USDC[BASE]);
    expect(call?.value).toBe(0n);
    expect(decodeFunctionData({ abi: erc20Abi, data: call?.callData as Hex }).args).toEqual([ALEX, 10_500_000n]);
  });

  it('ETH has the value and empty data', () => {
    expect(callsOf(payEth(0, [[ALEX, '0.01']]))).toEqual([
      { target: ALEX, value: 10_000_000_000_000_000n, callData: '0x' },
    ]);
  });

  it('gives the same calls as the verified encoder, so the two paths cannot drift', () => {
    const intent = payUsdc(0, [
      [ALEX, '10'],
      [BOB, '20.5'],
    ]);
    const checked = checkEnvelope(envelope([intent]));
    if (!checked.ok) throw new Error('expected a valid envelope');
    expect(callsOf(intent)).toEqual(executionsOf(checked.plan.steps[0]?.intent as Intent));
  });

  it('uses batch mode for one recipient too (A.5 rule 3)', () => {
    const data = encodeExecuteBatch(callsOf(payUsdc(0, [[ALEX, '10']])));
    const { args } = decodeFunctionData({
      abi: parseAbi(['function execute(bytes32 mode, bytes executionCalldata)']),
      data,
    });
    expect(args[0]).toBe(`0x01${'00'.repeat(31)}`);
    const [calls] = decodeAbiParameters(
      [{ type: 'tuple[]', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }] }],
      args[1],
    );
    expect(calls).toHaveLength(1);
  });

  it('keeps every recipient in order', () => {
    const data = encodeExecuteBatch(
      callsOf(
        payEth(0, [
          [ALEX, '0.1'],
          [BOB, '0.2'],
        ]),
      ),
    );
    expect(data.toLowerCase()).toContain(ALEX.slice(2).toLowerCase());
    expect(data.toLowerCase().indexOf(ALEX.slice(2).toLowerCase())).toBeLessThan(
      data.toLowerCase().indexOf(BOB.slice(2).toLowerCase()),
    );
  });
});

describe('the effect check (rule 8)', () => {
  const intent = payUsdc(0, [
    [ALEX, '10'],
    [BOB, '20'],
  ]);
  const token = USDC[BASE];
  const paid = [transferLog(token, WALLET, ALEX, 10_000_000n), transferLog(token, WALLET, BOB, 20_000_000n)];

  it('passes when each recipient got the exact amount', () => {
    expect(paymentTookEffect(intent, WALLET, paid)).toBe(true);
  });
  it('accepts logs in another order', () => {
    expect(paymentTookEffect(intent, WALLET, [...paid].reverse())).toBe(true);
  });
  it('fails with no logs (B1)', () => {
    expect(paymentTookEffect(intent, WALLET, [])).toBe(false);
  });
  it('fails when one recipient is missing', () => {
    expect(paymentTookEffect(intent, WALLET, paid.slice(0, 1))).toBe(false);
  });
  it('fails on a wrong amount', () => {
    expect(paymentTookEffect(intent, WALLET, [paid[0]!, transferLog(token, WALLET, BOB, 1n)])).toBe(false);
  });
  it('fails when the transfer came from another token', () => {
    const other = USDC[421614];
    expect(paymentTookEffect(intent, WALLET, [paid[0]!, transferLog(other, WALLET, BOB, 20_000_000n)])).toBe(false);
  });
  it('fails when someone else paid', () => {
    expect(paymentTookEffect(intent, WALLET, [paid[0]!, transferLog(token, ALEX, BOB, 20_000_000n)])).toBe(false);
  });
  it('fails when one person got paid twice and another not at all', () => {
    expect(paymentTookEffect(intent, WALLET, [paid[0]!, paid[0]!])).toBe(false);
  });
  it('ignores unrelated logs in the same receipt', () => {
    const unrelated = {
      ...paid[0]!,
      topics: ['0x' + 'ab'.repeat(32)] as unknown as (typeof paid)[0]['topics'],
    };
    expect(paymentTookEffect(intent, WALLET, [...paid, unrelated])).toBe(true);
  });
  it('relies on the receipt for ETH, where transfers emit no log', () => {
    expect(paymentTookEffect(payEth(0, [[ALEX, '0.01']]), WALLET, [])).toBe(true);
  });
});
