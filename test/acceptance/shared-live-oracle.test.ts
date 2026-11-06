// Validate the opt-in live evaluator's expectations with recorded Ollama replies; no live model or sockets.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { envelopeDiff, summaryOk } from '../live/intent-oracle.js';
import { addr, Harness, lines, loadFixture, MIHIR, short } from './harness.js';
import { seedAutopay } from './seed.js';

interface Entry {
  id: string;
  prompt: string;
  expected: { plan: Array<Record<string, unknown>> };
}
const entries = JSON.parse(readFileSync(new URL('../live/prompts.json', import.meta.url), 'utf8')) as Entry[];

describe('v2 live-evaluation oracle, checked offline', () => {
  it.each(['A-01', 'A-11', 'A-58'])(
    '%s agrees with the actual pipeline and rejects changed intent content',
    async (id) => {
      const entry = entries.find((e) => e.id === id)!;
      const h = new Harness(`oracle-${id}`, loadFixture(id), {});
      try {
        if (id === 'A-11') seedAutopay(h);
        await h.open();
        let pending = await h.say(entry.prompt);
        if (id === 'A-58') pending = await h.answer(pending, { chip: 'four_weeks' });
        expect(pending.body.state).toBe('awaiting_confirmation');
        expect(summaryOk(lines(pending), entry.expected.plan, {})).toEqual({ ok: true, why: '' });
        await h.confirm(pending, 'yes');
        expect(envelopeDiff(h.envelope, entry.expected.plan, {}, h)).toEqual([]);
        const changed = structuredClone(h.envelope);
        const intent = changed.intents.find((i) => i.intent_id !== 'j')!;
        if (intent.intent_id === 'i') intent.recipients[0]!.amount.value = '999';
        if (intent.intent_id === 'k') intent.limits.max_total.base_units = '40000000'; // drops all four fees
        if (intent.intent_id === 'l') intent.plan_id = `0x${'00'.repeat(32)}`;
        expect(envelopeDiff(changed, entry.expected.plan, {}, h).length).toBeGreaterThan(0);
      } finally {
        await h.finish({ allowUnused: true });
      }
    },
  );

  it('checks each amount in an atomic summary rather than equating a line with one payment', () => {
    const expected = [
      { t: 'i', tok: 'USDC', amt: '10', to: 'Mihir', chain: 'base' },
      { t: 'i', tok: 'USDC', amt: '20', to: 'addr:187', chain: 'base' },
    ];
    const line = `Send 10 USDC to Mihir (${short(MIHIR)}) and 20 USDC to Bob (${short(addr(187))}) on Base Sepolia in one atomic payment.`;
    expect(summaryOk([line], expected, {}).ok).toBe(true);
    expect(summaryOk([line.replace('20 USDC', '21 USDC')], expected, {}).ok).toBe(false);
  });
});
