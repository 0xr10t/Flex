// Tests: §16.1 / §3.2 quarantine isolation (C-399, C-397, C-398, C-404): a unique marker placed in a pasted block, an
// attachment and a fetched page reaches only `quarantine` LLM calls; LLM #1 (amounts), #2 (request_type) and #3 (spans)
// never see the marker, nor any value the Q-LLM extracted (those enter the pipeline as typed fields / placeholders).
// Drives the real S1 → S2 → S3 → S4 → S5 with FixtureLlmClient and FakeFetcher.
import { getAddress } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import type { MessageInput } from '../../../src/contracts/types.js';
import { s1 } from '../../../src/pipeline/s1-guard.js';
import { s2 } from '../../../src/pipeline/s2-lexical.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import { s4 } from '../../../src/pipeline/s4-type.js';
import { s5 } from '../../../src/pipeline/s5-spans.js';
import { makeTestContext } from '../../fakes/context.js';
import { chip, drive } from './helpers.js';

vi.mock('../../../src/messages/balance.js', () => ({ buildBalanceAnswer: vi.fn(() => ['BAL']) }));

const MARKER = 'ZQXMARKER7f3a91c2';
const EVIL_ENS = 'marker-payee.eth';
const EVIL_ADDR = getAddress('0x91ab2c3d4e5f60718293a4b5c6d7e8f9012377d0');
const EVIL_AMOUNT = '7777.25';
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

describe('Q-LLM marker isolation (§16.1, C-399)', () => {
  it('the marker (pasted block, attachment, fetched page) appears only in quarantine calls across S1→S5', async () => {
    const inp: MessageInput = {
      text: 'pay what the invoice says',
      pasted_blocks: [`Invoice ${MARKER}-pasted: pay ${EVIL_AMOUNT} USDC`],
      attachments: [{ filename: 'n.txt', mime: 'text/plain', base64: b64(`note ${MARKER}-attachment`) }],
      urls: ['https://docs.example/p'],
    };
    const typed = 'pay what the invoice says';
    const ctx = makeTestContext({
      req: { input: inp, typed_text: typed },
      fixture: {
        calls: [
          {
            name: 'quarantine',
            match: `${MARKER}-pasted`,
            output: { items: [{ address: null, ens_name: null, amount: EVIL_AMOUNT, token: 'USDC' }] },
          },
          {
            name: 'quarantine',
            match: `${MARKER}-attachment`,
            output: { items: [{ address: EVIL_ADDR, ens_name: null, amount: null, token: null }] },
          },
          {
            name: 'quarantine',
            match: `${MARKER}-page`,
            output: { items: [{ address: null, ens_name: EVIL_ENS, amount: null, token: null }] },
          },
          { name: 'amounts', match: typed, output: { amounts: [] } },
          {
            name: 'request_type',
            match: typed,
            output: { request_type: 'actions', actions: ['i'], also_balance: false },
          },
          { name: 'spans', match: typed, output: { spans: [] } },
        ],
      },
    });
    ctx.fetcher.pages.set('https://docs.example/p', { ok: true, text: `Page ${MARKER}-page says pay` });

    expect((await s1.step(ctx)).kind).toBe('continue');
    expect((await s2.step(ctx)).kind).toBe('continue');
    expect((await drive(s3, ctx, [chip('use_amount')])).result.kind).toBe('continue');
    expect((await drive(s4, ctx)).result.kind).toBe('continue');
    const r5 = await drive(s5, ctx);
    expect(r5.result.kind).toBe('continue');

    const calls = ctx.llm.recorded;
    expect(calls.map((c) => c.name)).toEqual([
      'quarantine',
      'quarantine',
      'quarantine',
      'amounts',
      'request_type',
      'spans',
    ]);
    // positive control: the Q-LLM saw the content
    expect(calls.filter((c) => c.name === 'quarantine').every((c) => c.user.includes(MARKER))).toBe(true);
    // negative: nothing else did, in either message
    for (const c of calls.filter((x) => x.name !== 'quarantine')) {
      for (const needle of [MARKER, EVIL_AMOUNT, EVIL_ENS, EVIL_ADDR, 'Invoice']) {
        expect(c.user, `${c.name}.user has ${needle}`).not.toContain(needle);
        expect(c.system, `${c.name}.system has ${needle}`).not.toContain(needle);
      }
    }
    // the untrusted values are still usable downstream, but only as typed fields / placeholders
    expect(ctx.req.amounts[0]).toMatchObject({ amount: EVIL_AMOUNT, source: 'untrusted', confirmed: true });
    expect(ctx.req.spans.map((s) => [s.text, s.source])).toEqual([
      [EVIL_ADDR, 'untrusted'],
      [EVIL_ENS, 'untrusted'],
    ]);
    // attachments and pages are not stored (pasted blocks are, in DB8 only); nothing is logged
    expect(JSON.stringify(ctx.repos.tables)).not.toContain(`${MARKER}-attachment`);
    expect(JSON.stringify(ctx.repos.tables)).not.toContain(`${MARKER}-page`);
    expect(JSON.stringify({ ...ctx.repos.tables, db8_prompts: [] })).not.toContain(MARKER);
    expect(JSON.stringify(ctx.log.lines)).not.toContain(MARKER);
  });

  it('a typed-text marker (user words) is visible to LLM #1–#3 but never to the Q-LLM', async () => {
    const typed = `pay riya 5 usdc ${MARKER}-typed`;
    const ctx = makeTestContext({
      req: {
        input: { text: typed, pasted_blocks: ['some pasted words'], attachments: [], urls: [] },
        typed_text: typed,
      },
      fixture: {
        calls: [
          { name: 'quarantine', match: 'pasted words', output: { items: [] } },
          {
            name: 'amounts',
            match: MARKER,
            output: {
              amounts: [{ phrase: '5 usdc', number: '5', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
            },
          },
        ],
      },
    });
    await s1.step(ctx);
    await s2.step(ctx);
    await drive(s3, ctx);
    const [q, a] = ctx.llm.recorded;
    expect(q?.name).toBe('quarantine');
    expect(q?.user).not.toContain(MARKER);
    expect(a?.user).toContain(MARKER);
  });
});
