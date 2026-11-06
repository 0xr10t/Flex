// Privacy fixes end to end through the HTTP API: fix 8 (a message or a "yes" sends nothing to the RPC once balances are
// known; only a cold start reads) and fix 5 (typed links are never opened; urls[] links only when `fetch.enabled`).
import { describe, expect, it } from 'vitest';
import { expectHandedOff } from './checks.js';
import { harness } from './harness.js';

const SESSION_TABLES = ['db1_amount_placeholders', 'db3_address_placeholders', 'db8_prompts', 'db8_history'];

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

describe('privacy fix 5: links', () => {
  it('with fetch.enabled false, a urls[] link → LINKS_OFF: nothing fetched, no model call, nothing written', async () => {
    const h = await harness('none');
    h.config.fetch.enabled = false;
    const r = await h.say('pay this invoice', { urls: ['https://invoice.example/1'] });
    expect(r.body.state).toBe('error');
    expect(r.body.error?.code).toBe('LINKS_OFF');
    expect(r.body.error?.message).toBe(
      "Opening links is turned off for privacy, so link 1 wasn't read and nothing was done. Paste its text instead.",
    );
    expect(h.fetcher.calls).toEqual([]);
    expect(h.llm.recorded).toEqual([]);
    for (const t of SESSION_TABLES) expect(h.count(t), t).toBe(0);
    await h.finish();
  });

  it('a link typed in the message is never fetched, even with fetch.enabled true', async () => {
    const h = await harness('none');
    h.config.fetch.enabled = true;
    h.fetcher.pages.set('https://invoice.example/1', { ok: true, text: 'pay bob.eth 5 usdc' });
    await h.say('pay what https://invoice.example/1 says');
    expect(h.fetcher.calls).toEqual([]);
    expect(h.llm.recorded.filter((c) => c.name === 'quarantine')).toEqual([]);
    await h.finish();
  });

  it('with fetch.enabled true, a urls[] link is still read (control)', async () => {
    const h = await harness('none');
    h.config.fetch.enabled = true;
    h.fetcher.pages.set('https://invoice.example/1', { ok: true, text: 'nothing useful' });
    await h.say('read this', { urls: ['https://invoice.example/1'] });
    expect(h.fetcher.calls).toEqual(['https://invoice.example/1']);
    await h.finish();
  });
});
