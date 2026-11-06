import { describe, expect, it } from 'vitest';
import type { ChainId } from '../../src/contracts/types.js';
import type { FixtureCall, FixtureFile } from '../fakes/llm.js';
import { Harness, ARB, BASE } from './harness.js';

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
