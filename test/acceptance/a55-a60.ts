// A-55 (pipeline half) … A-60 (spec §20.2).
import { describe, expect, it } from 'vitest';
import {
  expectEnvelope,
  expectError,
  expectHandedOff,
  lastHistory,
  noSubmission,
  pending,
  spend,
  usdcIntent,
} from './checks.js';
import {
  ARADHYA,
  ARB,
  BASE,
  MIHIR,
  USDC_ADDR,
  eth,
  harness,
  lines,
  scanLogs,
  sensitiveValues,
  suiteLogDir,
  usdc,
} from './harness.js';
import { planIdFor, DELEGATE, seedAutopay, seedSpend } from './seed.js';

export function registerA55toA59(): void {
  describe('A-55 … A-59', () => {
    it("A-55 SQ-D-16: an autopay_payment report reduces today's remaining allowance for the next request", async () => {
      const h = await harness('A-55');
      const id = seedAutopay(h, { amount: '5' });
      seedSpend(h, { amount: '290', kind: 'payment' });
      expect(
        await h.report({
          kind: 'autopay_payment',
          request_id: 'req_00000000aaaa',
          status: 'executed',
          tx_hash: '0x' + 'ef'.repeat(32),
          executed_at: '2026-11-05T17:00:00Z',
          autopay: { autopay_id: id, plan_id: planIdFor(id), executor_address: DELEGATE, slot: 0, status: 'active', amount: '5', fee: '0.05', chain_id: BASE, token: 'USDC' },
        }),
      ).toBe(204);
      const r = await h.say('send 10 usdc to mihir');
      expect(r.body.question?.code).toBe('Q_LIMIT_OVERRIDE');
      expect(r.body.question?.text).toBe(
        "This is 10 USDC, over today's limit of 300 (only 4.95 is left). Go ahead this once?",
      );
      await h.finish();
    });

    it('A-56: pending payment from 2 min ago is subtracted from spendable (chain choice moves to Arbitrum)', async () => {
      const h = await harness('A-56');
      h.advance(-2);
      seedSpend(h, { amount: '70', status: 'pending', executed_at: null, tx_hash: null });
      h.advance(2);
      const r = await h.say('send 50 usdc to aradhya');
      // Base 80 - 70 pending = 10 spendable, Arbitrum 60 -> Arbitrum, no bridge.
      expect(lines(r)).toEqual(['Send 50 USDC to Aradhya (0x3fA9…c21E) on Arbitrum Sepolia.']);
      expect(r.body.summary?.footer).toEqual(['Spent today after this: 120 of 300 USDC.']); // pending counts toward the day
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        usdcIntent({ step: 0, chain: ARB, token_address: USDC_ADDR[ARB], amount: usdc('50'), recipient: ARADHYA }),
      ]);
      await h.finish();
    });

    it('A-56: a pending payment from 11 min ago is outside the window and not subtracted (control)', async () => {
      const h = await harness('A-56-control');
      h.advance(-11);
      seedSpend(h, { amount: '70', status: 'pending', executed_at: null, tx_hash: null });
      h.advance(11);
      const r = await h.say('send 50 usdc to aradhya');
      expect(lines(r)).toEqual(['Send 50 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia.']);
      await h.finish();
    });

    // SQ-O-03 F-11: one recipient, so the pairing is unambiguous and nothing is asked.
    it('A-57: "10 usdc and 0.01 eth to mihir" -> two i intents with different tokens', async () => {
      const h = await harness('A-57');
      const r = await h.say('send 10 usdc and 0.01 eth to mihir');
      expect(h.asked).toEqual([]);
      expect(lines(r)).toEqual([
        'Send 10 USDC to Mihir (0x91Ab…77d0) on Base Sepolia.',
        'Send 0.01 ETH to Mihir (0x91Ab…77d0) on Base Sepolia.',
      ]);
      expect(r.body.summary?.footer).toEqual([
        'Spent today after this: 10 of 300 USDC.',
        'Spent today after this: 0.01 of 0.15 ETH.',
      ]);
      expectHandedOff(await h.confirm(r, 'yes'));
      expectEnvelope(h, r.body.request_id, [
        usdcIntent({ step: 0, chain: BASE, token_address: USDC_ADDR[BASE], amount: usdc('10'), recipient: MIHIR }),
        {
intent_id: 'i',
step: 1,
depends_on: [],
token: 'ETH',
token_address: null,
chain_id: BASE,
recipients: [{ amount: eth('0.01'), recipient: MIHIR }]
},
      ]);
      expect(lastHistory(h)).toHaveLength(2);
      expect(spend(h)).toEqual([
        pending('payment', BASE, '10', 0, 'i', { recipient: MIHIR }),
        pending('payment', BASE, '0.01', 1, 'i', { recipient: MIHIR, token: 'ETH' }),
      ]);
      await h.finish();
    });

    it('A-58: monthly schedules require an explicit fixed-interval choice', async () => {
      const h = await harness('A-58');
      const question = await h.say('pay mihir 10 usdc every month on the 31st for 3 months');
      expect(question.body.question?.code).toBe('Q_AUTOPAY_MONTHLY');
      expect(h.exec.submissions).toHaveLength(0);
      const r = await h.answer(question, { chip: 'thirty_days' });
      expect(r.body.state).toBe('awaiting_confirmation');
      expect(r.body.summary?.notes.join(' ')).not.toContain('28th');
      expect(lines(r)[0]).toContain('every 30 days');
      expectHandedOff(await h.confirm(r, 'yes'));
      const k = h.envelope.intents[0];
      if (k?.intent_id !== 'k') throw new Error('missing autopay');
      expect(k.schedule.interval_seconds).toBe(30 * 86400);
      expect(k.schedule.max_runs).toBe(4);
      expect(k.limits.max_per_run).toEqual(usdc('10.05'));
      expect(k.limits.max_total).toEqual(usdc('40.2'));
      expect(k).not.toHaveProperty('cre_job');
      await h.finish();
    });

    it('SQ-O-03 F-11: "send 10 usdc and 20 usdc to mihir and aradhya" -> Q_PAIR_AMOUNT per amount, then the pairing stands', async () => {
      const h = await harness('SQ-O-03');
      const r1 = await h.say('send 10 usdc and 20 usdc to mihir and aradhya');
      expect(r1.body.question?.code).toBe('Q_PAIR_AMOUNT');
      expect(r1.body.question?.text).toBe('Who should get 10 USDC?');
      expect(r1.body.question?.chips.map((c) => c.label)).toEqual(['Mihir', 'Aradhya']);
      const r2 = await h.answer(r1, { chipLabel: 'Mihir' });
      expect(r2.body.question?.code).toBe('Q_PAIR_AMOUNT');
      expect(r2.body.question?.text).toBe('Who should get 20 USDC?');
      const r3 = await h.answer(r2, { chipLabel: 'Aradhya' });
      expect(r3.body.state).toBe('awaiting_confirmation');
      expect(lines(r3)).toEqual([
        'Send 10 USDC to Mihir (0x91Ab…77d0) and 20 USDC to Aradhya (0x3fA9…c21E) on Base Sepolia in one atomic payment.',
      ]);
      await h.finish();
    });

    it('A-59: LLM fixture returns mispaired output twice -> PAIRING_FAILED', async () => {
      const h = await harness('A-59');
      const r = await h.say('send 40 usdc to aradhya and 20 usdc to mihir');
      expectError(
        r,
        'PAIRING_FAILED',
        "I couldn't tell which amount goes to whom. Could you rephrase, one payment per line?",
      );
      const calls = h.llm.recorded.filter((c) => c.name === 'payments');
      expect(calls).toHaveLength(2);
      expect(calls[0]!.user).not.toContain('CORRECTION:');
      expect(calls[1]!.user).toMatch(/CORRECTION: .+/);
      noSubmission(h);
      expect(spend(h)).toEqual([]);
      await h.finish();
    });
  });
}

export function registerA60(): void {
  describe('A-60', () => {
    it('A-60: logs after A-01 … A-59 contain no amount, address, name, ENS name or prompt text (and only allowlisted fields)', () => {
      const { lines: n, hits } = scanLogs(suiteLogDir(), sensitiveValues());
      expect(n, 'the suite must have produced log lines').toBeGreaterThan(0);
      // Make sure the registry really holds what the suite used.
      const values = sensitiveValues();
      expect(values.some(([v]) => v === ARADHYA)).toBe(true);
      expect(values.some(([, k]) => k === 'prompt')).toBe(true);
      expect(hits).toEqual([]);
    });
  });
}
