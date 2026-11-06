import { describe, expect, it } from 'vitest';
import type { ChainId } from '../../src/contracts/types.js';
import type { FixtureCall, FixtureFile } from '../fakes/llm.js';
import { Harness, ARB, BASE, MIHIR } from './harness.js';

const payment = (n: number, chain: ChainId | 'unstated') => ({
  kind: 'i',
  amount: `$amount:${n}`,
  recipient: `$recipient:${n}`,
  chain,
  frequency: null,
  interval: null,
  times_per_week: null,
  days_of_week: null,
  day_of_month: null,
});
function fixture(chains: Array<ChainId | 'unstated'>, corrected?: Array<ChainId | 'unstated'>): FixtureFile {
  const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output, attempt: 1 });
  return {
    calls: [
      call('amounts', {
        amounts: chains.map((_, i) => ({
          phrase: `${(i + 1) * 10} usdc`,
          number: String((i + 1) * 10),
          relative: null,
          token: 'USDC',
          fiat: null,
          role: 'pay',
        })),
      }),
      call('request_type', { request_type: 'actions', actions: ['i'], also_balance: false }),
      call('spans', {
        spans: (chains.length === 1 ? ['Mihir'] : ['Aradhya', 'Mihir']).map((text) => ({
          text,
          kind: 'name',
          role: 'payee',
        })),
      }),
      call('payments', { payments: chains.map((chain, i) => payment(i, chain)) }),
      ...(corrected ? [call('payments', { payments: corrected.map((chain, i) => payment(i, chain)) })] : []),
    ],
  };
}

describe('G01 explicit chain binding through HTTP', () => {
  it('rejects chains swapped between otherwise correctly paired clauses after one correction', async () => {
    const h = new Harness('chain-swap', fixture([ARB, BASE], [ARB, BASE]), {});
    try {
      const response = await h.say('send 10 usdc to Aradhya on base and 20 usdc to Mihir on arbitrum');
      expect(response.body.error?.code).toBe('PAIRING_FAILED');
      expect(h.exec.submissions).toHaveLength(0);
    } finally {
      await h.finish();
    }
  });

  it('does not turn an explicitly requested Arbitrum payment into automatic Base selection', async () => {
    const h = new Harness('chain-dropped', fixture(['unstated'], ['unstated']), {});
    try {
      const response = await h.say('send 10 usdc to Mihir on arbitrum');
      expect(response.body.error?.code).toBe('PAIRING_FAILED');
      expect(h.exec.submissions).toHaveLength(0);
    } finally {
      await h.finish();
    }
  });

  it('a corrected response reaches confirmation and submits the explicitly requested chains', async () => {
    const h = new Harness('chain-corrected', fixture([ARB, BASE], [BASE, ARB]), {});
    try {
      const response = await h.sayAndConfirm('send 10 usdc to Aradhya on base and 20 usdc to Mihir on arbitrum');
      expect(response.body.state).toBe('done');
      expect(h.envelope.intents.map((it) => ('chain_id' in it ? it.chain_id : null))).toEqual([BASE, ARB]);
    } finally {
      await h.finish();
    }
  });

  it.each(['send 10 usdc to Mihir on arbitrum', 'send 10 usdc to Mihir, on arbitrum'])(
    'accepts an accurate same-clause or suffix chain: %s',
    async (text) => {
      const h = new Harness('chain-valid', fixture([ARB]), {});
      try {
        expect((await h.sayAndConfirm(text)).body.state).toBe('done');
        expect(h.envelope.intents[0]).toMatchObject({ chain_id: ARB });
      } finally {
        await h.finish();
      }
    },
  );
});

function invoiceFixture(chains: Array<ChainId | 'unstated'>): FixtureFile {
  const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
  return {
    calls: [
      call('quarantine', { items: [{ address: MIHIR, ens_name: null, amount: '10', token: 'USDC' }] }),
      call('amounts', { amounts: [] }),
      call('request_type', { request_type: 'actions', actions: ['i'], also_balance: false }),
      call('spans', { spans: [] }),
      ...chains.map((chain) => call('payments', { payments: [payment(0, chain)] })),
    ],
  };
}

describe('G01 document-only explicit chain binding through HTTP', () => {
  it('rejects an omitted document payment chain after one correction', async () => {
    const h = new Harness('invoice-chain-dropped', invoiceFixture(['unstated', 'unstated']), {});
    try {
      const amount = await h.say('pay this invoice on arbitrum', {
        pasted_blocks: [`Invoice: 10 USDC to ${MIHIR}.`],
      });
      expect(amount.body.question?.code).toBe('Q_UNTRUSTED_AMOUNT');
      const response = await h.answer(amount, { chipLabel: 'Use this amount' });
      expect(response.body.error?.code, JSON.stringify(response.body)).toBe('PAIRING_FAILED');
      expect(response.body.summary).toBeUndefined();
      expect(h.exec.submissions).toHaveLength(0);
      const calls = h.llm.recorded.filter((c) => c.name === 'payments');
      expect(calls).toHaveLength(2);
      expect(calls[1]?.user).toContain('CORRECTION:');
      expect(h.llm.remaining()).toEqual([]);
    } finally {
      await h.finish({ allowUnused: true });
    }
  });

  it.each([
    { prompt: 'pay this invoice on arbitrum', chains: [ARB], expected: ARB },
    { prompt: 'pay this invoice on arbitrum', chains: ['unstated', ARB], expected: ARB },
    { prompt: 'pay this invoice', chains: ['unstated'], expected: BASE },
  ] satisfies Array<{ prompt: string; chains: Array<ChainId | 'unstated'>; expected: ChainId }>)(
    'preserves document routing for $prompt with model chains $chains',
    async ({ prompt, chains, expected }) => {
      const h = new Harness('invoice-chain-control', invoiceFixture(chains), {});
      try {
        const amount = await h.say(prompt, { pasted_blocks: [`Invoice: 10 USDC to ${MIHIR}.`] });
        expect(amount.body.question?.code).toBe('Q_UNTRUSTED_AMOUNT');
        const response = await h.answer(amount, { chipLabel: 'Use this amount' });
        expect(response.body.state).toBe('awaiting_confirmation');
        expect((await h.confirm(response, 'yes')).body.state).toBe('done');
        expect(h.envelope.intents).toHaveLength(1);
        expect(h.envelope.intents[0]).toMatchObject({
          intent_id: 'i',
          chain_id: expected,
          recipients: [{ recipient: MIHIR }],
        });
        expect(h.llm.recorded.filter((c) => c.name === 'payments')).toHaveLength(chains.length);
        expect(h.llm.remaining()).toEqual([]);
      } finally {
        await h.finish({ allowUnused: true });
      }
    },
  );
});
