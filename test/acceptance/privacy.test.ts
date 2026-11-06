// Privacy fix 8 end to end through the HTTP API: a message or a "yes" sends nothing to the RPC once balances are known;
// only a cold start reads.
import { describe, expect, it } from 'vitest';
import { expectHandedOff } from './checks.js';
import { harness } from './harness.js';

describe('privacy fix 8: balances are not read because of a message', () => {
  it('a full payment (message, summary, "yes", hand-off) sends nothing to the RPC', async () => {
    const h = await harness('A-47');
    const r = await h.say('Send 50 USDc to ARADHYA');
    expect(r.body.state).toBe('awaiting_confirmation');
    expectHandedOff(await h.confirm(r, 'yes'));
    expect(h.rpc.calls).toEqual([]);
    await h.finish();
  });

  it('a cold start reads every allowed chain once; the next message reads nothing', async () => {
    const h = await harness('none', { balances: null });
    await h.say('send 5 usdc to mihir');
    expect(h.rpc.calls).toHaveLength(6);
    expect(h.rows<{ n: number }>('SELECT COUNT(*) AS n FROM db4_balances')[0]?.n).toBe(6);
    h.rpc.calls.length = 0;
    await h.say('send 6 usdc to mihir');
    expect(h.rpc.calls).toEqual([]);
    await h.finish();
  });
});
