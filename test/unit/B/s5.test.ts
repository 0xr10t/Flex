// Tests: §8.6 S5 recipient spans — C-109 (rule 1 verbatim), C-110 (rule 2 drops chain/token alias, back-reference,
// placeholder, me/my/I), C-111 (rule 3 address regex, normalize()), C-112 (rule 4 candidates added; SQB-16), C-113 (rule 5
// overlaps keep the longest), C-114 (rule 6 mentioned → mentioned_spans), C-115 / C-413 / C-414 (rule 7 follow-ups,
// §17.2 steps 2–3), C-116 (rule 8 document payees, source untrusted, SQB-17), C-117 (rule 9 Q_NO_PAYEE), C-315 (Q_NO_PAYEE),
// C-316 (Q_FOLLOWUP_WHO), C-108 (SPLIT_UNSUPPORTED, decided after S5), C-144 (prompt gets masked_text_s3 + CANDIDATES),
// C-399/C-404 (no untrusted values in the prompt; mentioned names never looked up), §16.1. The cross-lane span-offset
// contract: every `spans[i].span` / `mentioned_spans[i]` indexes `masked_text_s3` (slice(start,end) === text), no overlaps.
import { describe, expect, it } from 'vitest';
import type { StepContext } from '../../../src/contracts/step.js';
import type { ActionKind, QItem, RecipientSpan } from '../../../src/contracts/types.js';
import { s3 } from '../../../src/pipeline/s3-amounts.js';
import { s5 } from '../../../src/pipeline/s5-spans.js';
import type { TestContext } from '../../fakes/context.js';
import { chip, drive, expectLabelsOk, scannedCtx, text } from './helpers.js';

type Sp = { text: string; kind: 'name' | 'ens' | 'address' | 'group'; role?: 'payee' | 'mentioned' };
type Amt = { phrase: string; number: string; token?: 'USDC' | 'ETH' | null; role?: 'pay' | 'context' };
const ADDR = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E';
const ADDR2 = '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0';

async function setup(
  typed: string,
  o: {
    amounts?: Amt[];
    spans?: Sp[];
    actions?: ActionKind[];
    untrusted?: QItem[];
    llmSpans?: boolean;
    s3answers?: Parameters<typeof drive>[2];
  } = {},
): Promise<TestContext> {
  const calls: Array<{ name: 'amounts' | 'spans'; match: string; output: unknown }> = [
    {
      name: 'amounts',
      match: typed,
      output: {
        amounts: (o.amounts ?? []).map((a) => ({ relative: null, token: 'USDC', fiat: null, role: 'pay', ...a })),
      },
    },
  ];
  if (o.llmSpans !== false) {
    calls.push({ name: 'spans', match: '', output: { spans: (o.spans ?? []).map((s) => ({ role: 'payee', ...s })) } });
  }
  const ctx = await scannedCtx(typed, { fixture: { calls }, req: { untrusted: o.untrusted ?? [] } });
  const d = await drive(s3, ctx, o.s3answers ?? []);
  if (d.result.kind !== 'continue') throw new Error(`S3 stopped: ${JSON.stringify(d.result)}`);
  ctx.req.actions = o.actions ?? ['i'];
  return ctx;
}
const run = (ctx: StepContext, answers: Parameters<typeof drive>[2] = []) => drive(s5, ctx, answers);
const payees = (ctx: TestContext) => ctx.req.spans.map((s) => [s.text, s.kind]);

function expectOffsetContract(ctx: TestContext): void {
  const masked = ctx.req.masked_text_s3 ?? '';
  const all = [...ctx.req.spans.map((s) => s.span), ...ctx.req.mentioned_spans].filter(
    (s): s is NonNullable<typeof s> => s !== null,
  );
  for (const s of all) expect(masked.slice(s.start, s.end), JSON.stringify(s)).toBe(s.text);
  const sorted = [...all].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++)
    expect(sorted[i]!.start, 'overlap').toBeGreaterThanOrEqual(sorted[i - 1]!.end);
}

describe('S5 rules 1-3 (filtering)', () => {
  it('LIVE-P046: myself is never resolved as a named payee', async () => {
    const ctx = await setup('transfer 20 usdc to myself', {
      amounts: [{ phrase: '20 usdc', number: '20' }],
      spans: [{ text: 'myself', kind: 'name' }],
    });
    const r = await run(ctx);
    expect(r.questions[0]?.code).toBe('Q_NO_PAYEE');
    expect(ctx.req.spans).toEqual([]);
    expect(ctx.repos.tables.db3.size).toBe(0);
  });

  it('LIVE-P084/P085: a lexical all-ENS-members group overrides a person interpretation', async () => {
    const ctx = await setup('send 5 usdc to all iitr.eth members', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'iitr.eth', kind: 'ens' }],
    });
    const r = await run(ctx);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([['iitr.eth', 'group']]);
    expectOffsetContract(ctx);
  });

  it.each(['Mihir2', '2Mihir', 'Mihir_2', 'Mihiré', 'éMihir', 'Mihir\u0301', 'Mihir२', '𐐀Mihir', 'Mihir𐐀'])(
    'B11: a partial name span cannot resolve the distinct identifier %s',
    async (identifier) => {
      const ctx = await setup(`send 10 usdc to ${identifier}`, {
        amounts: [{ phrase: '10 usdc', number: '10' }],
        spans: [{ text: 'Mihir', kind: 'name' }],
        s3answers: [chip('no')], // a leading digit is separately checked as an uncovered amount
      });
      const r = await run(ctx);
      expect(r.questions[0]?.code).toBe('Q_NO_PAYEE');
      expect(ctx.req.spans).toEqual([]);
      expect(ctx.repos.tables.db3.size).toBe(0);
    },
  );

  it('B11: skips a partial identifier and claims a later complete name with punctuation', async () => {
    const ctx = await setup('send 10 usdc to Mihir2, ask Mihir.', {
      amounts: [{ phrase: '10 usdc', number: '10' }],
      spans: [{ text: 'Mihir', kind: 'name' }],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['Mihir', 'name']]);
    expect(ctx.req.spans[0]?.span?.start).toBe(ctx.req.masked_text_s3?.lastIndexOf('Mihir'));
    expectOffsetContract(ctx);
  });

  it('C-144: LLM #3 prompt = masked_text_s3 + CANDIDATES (every S2 address/ens/group candidate), no raw amounts', async () => {
    const ctx = await setup(`send 5 usdc to ${ADDR} and riya.eth`, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [],
    });
    await run(ctx);
    const call = ctx.llm.recorded.find((c) => c.name === 'spans');
    expect(call?.user).toBe(
      `Message: <<<${ctx.req.masked_text_s3}>>>\nCANDIDATES: ${JSON.stringify([ADDR, 'riya.eth'])}`,
    );
    expect(call?.user).not.toContain('5 usdc');
  });

  it('rule 1 (C-109): a span whose text is not verbatim in masked_text_s3 is dropped (case-sensitive)', async () => {
    const ctx = await setup('send 5 usdc to riya', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'Riya', kind: 'name' },
        { text: 'Rya', kind: 'name' },
      ],
    });
    const r = await run(ctx);
    expect(ctx.req.spans).toEqual([]);
    expect(r.questions[0]?.code).toBe('Q_NO_PAYEE'); // rule 9
  });

  it('rule 1: a span naming text that only existed before masking (the amount phrase) is dropped', async () => {
    const ctx = await setup('send 5 usdc to riya', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: '5 usdc', kind: 'name' },
        { text: 'riya', kind: 'name' },
      ],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya', 'name']]);
  });

  it('rule 2 (C-110): chain alias, token alias, fiat word, back-reference word, placeholder, me/my/I are dropped', async () => {
    const typed = 'send 5 usdc to riya on base, her eth, me my I';
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'base', kind: 'name' },
        { text: 'usdc', kind: 'name' },
        { text: 'eth', kind: 'name' },
        { text: 'her', kind: 'name' },
        { text: 'me', kind: 'name' },
        { text: 'my', kind: 'name' },
        { text: 'I', kind: 'name' },
        { text: 'riya', kind: 'name' },
      ],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya', 'name']]);
  });

  it('rule 2: placeholder-shaped words and "[amount]" returned as spans are dropped', async () => {
    const typed = 'pay riya 5 usdc, ignore address_abcdefab and [amount] and group_abcdefab';
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'address_abcdefab', kind: 'name' },
        { text: '[amount]', kind: 'name' },
        { text: 'group_abcdefab', kind: 'name' },
        { text: 'riya', kind: 'name' },
      ],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya', 'name']]);
  });

  it('rule 3 (C-111): kind address must match the address regex; ens/group must pass normalize(); otherwise dropped', async () => {
    const typed = 'pay 0x123 and riya..eth and ok.eth';
    const ctx = await setup(typed, {
      spans: [
        { text: '0x123', kind: 'address' },
        { text: 'riya..eth', kind: 'ens' },
        { text: 'ok.eth', kind: 'ens' },
        { text: 'Bad Name.eth', kind: 'group' },
      ],
      s3answers: [chip('no')],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['ok.eth', 'ens']]);
  });

  it('rule 3: a valid full address is kept as kind address with offsets', async () => {
    const ctx = await setup(`send 5 usdc to ${ADDR}`, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: ADDR, kind: 'address' }],
    });
    expect((await run(ctx)).result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([[ADDR, 'address']]);
    expect(ctx.req.state).toBe('SPANS_TAGGED');
    expectLabelsOk(ctx);
  });
});

describe('S5 rules 4-6 (candidates, overlaps, mentioned)', () => {
  it('rule 4 (C-112): S2 candidates the model missed are added as payees (address, ens)', async () => {
    const ctx = await setup(`send 5 usdc to ${ADDR} and riya.eth`, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([
      [ADDR, 'address'],
      ['riya.eth', 'ens'],
    ]);
    expect(ctx.req.spans.every((s) => s.role === 'payee' && s.source === 'user')).toBe(true);
  });

  it('rule 4 / SQB-16: a candidate returned with another kind gets the S2 kind', async () => {
    const ctx = await setup(`send 5 usdc to ${ADDR}`, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: ADDR, kind: 'name' }],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([[ADDR, 'address']]);
  });

  it('rule 4: a group candidate ("everyone under iitr.eth") is added with the parent text', async () => {
    const ctx = await setup('send 5 usdc to everyone under iitr.eth', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['iitr.eth', 'group']]);
    expectOffsetContract(ctx);
  });

  it('rule 5 (C-113): overlapping spans keep the longest', async () => {
    const ctx = await setup('send 5 usdc to riya.eth', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'riya', kind: 'name' },
        { text: 'riya.eth', kind: 'ens' },
      ],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya.eth', 'ens']]);
    expectOffsetContract(ctx);
  });

  it('rule 6 (C-114, C-404): role=mentioned is dropped from spans (no payee) and recorded in mentioned_spans', async () => {
    const typed = 'pay Aman 5 usdc for the service Aman did for my friend Kabir';
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Kabir', kind: 'name', role: 'mentioned' },
      ],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['Aman', 'name']]);
    expect(ctx.req.mentioned_spans.map((s) => s.text)).toEqual(['Kabir']);
    expect(ctx.repos.tables.db3.size).toBe(0);
    expect(ctx.ens.calls).toEqual([]);
    expectOffsetContract(ctx);
  });
});

describe('S5 span offsets index masked_text_s3 (cross-lane contract)', () => {
  it('amounts masked BEFORE the names (placeholder length ≠ phrase length): offsets still slice masked_text_s3', async () => {
    const typed = 'send 50 usdc to riya and 7 usdc to Mihir because Kabir asked';
    const ctx = await setup(typed, {
      amounts: [
        { phrase: '50 usdc', number: '50' },
        { phrase: '7 usdc', number: '7' },
      ],
      spans: [
        { text: 'riya', kind: 'name' },
        { text: 'Mihir', kind: 'name' },
        { text: 'Kabir', kind: 'name', role: 'mentioned' },
      ],
    });
    expect(ctx.req.masked_text_s3!.length).not.toBe(typed.length);
    await run(ctx);
    expect(ctx.req.spans.map((s) => s.span?.text)).toEqual(['riya', 'Mihir']);
    expect(ctx.req.mentioned_spans).toHaveLength(1);
    expectOffsetContract(ctx);
    // and the offsets are NOT typed_text offsets
    expect(typed.slice(ctx.req.spans[1]!.span!.start, ctx.req.spans[1]!.span!.end)).not.toBe('Mihir');
  });

  it('context amounts masked as "[amount]" before the name: offsets still slice masked_text_s3', async () => {
    const typed = 'he charged 500 last time, pay Aman 5 usdc';
    const ctx = await setup(typed, {
      amounts: [
        { phrase: '500', number: '500', role: 'context' },
        { phrase: '5 usdc', number: '5' },
      ],
      spans: [{ text: 'Aman', kind: 'name' }],
    });
    expect(ctx.req.masked_text_s3).toMatch(/^he charged \[amount\] last time, pay Aman amount_[0-9a-f]{8}$/);
    await run(ctx);
    expect(ctx.req.spans[0]?.span).toMatchObject({ text: 'Aman', start: ctx.req.masked_text_s3!.indexOf('Aman') });
    expectOffsetContract(ctx);
  });

  it('a name that occurs twice in masked_text_s3: the returned span maps to the first unused occurrence; each returned copy takes the next occurrence', async () => {
    const typed = 'pay Aman 5 usdc for what Aman did';
    const one = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'Aman', kind: 'name' }],
    });
    await run(one);
    expect(one.req.spans).toHaveLength(1);
    expect(one.req.spans[0]?.span?.start).toBe(one.req.masked_text_s3!.indexOf('Aman'));
    expectOffsetContract(one);

    const two = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Aman', kind: 'name' },
      ],
    });
    await run(two);
    expect(two.req.spans.map((s) => s.span?.start)).toEqual([4, two.req.masked_text_s3!.lastIndexOf('Aman')]);
    expectOffsetContract(two);
  });

  it('DOCUMENTED: a mentioned name that occurs twice but is returned once yields ONE mentioned span (the other occurrence stays untagged)', async () => {
    const typed = 'pay Aman 5 usdc, Kabir asked and Kabir agreed';
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Kabir', kind: 'name', role: 'mentioned' },
      ],
    });
    await run(ctx);
    expect(ctx.req.mentioned_spans).toHaveLength(1);
    expect(ctx.req.mentioned_spans[0]?.start).toBe(ctx.req.masked_text_s3!.indexOf('Kabir'));
  });

  it('F-12: same name payee once and mentioned once (different occurrences) asks Q_NAME_ROLE; after "pay" the offsets hold', async () => {
    const typed = 'pay Aman 5 usdc; Aman is not who paid before';
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Aman', kind: 'name', role: 'mentioned' },
      ],
    });
    const r = await run(ctx, [chip('pay')]);
    expect(r.questions.map((q) => q.code)).toEqual(['Q_NAME_ROLE']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.mentioned_spans).toHaveLength(0);
    expectOffsetContract(ctx);
  });

  it('an S2 candidate occurring twice yields ONE payee span at its first occurrence (documented behaviour)', async () => {
    const typed = 'send 5 usdc to riya.eth, i mean riya.eth';
    const ctx = await setup(typed, { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
    await run(ctx);
    expect(ctx.req.spans).toHaveLength(1);
    expectOffsetContract(ctx);
  });

  it('clause_index of every span refers to the TYPED clause of the same words', async () => {
    const typed = 'send 50 usdc to riya, then 7 usdc to Mihir';
    const ctx = await setup(typed, {
      amounts: [
        { phrase: '50 usdc', number: '50' },
        { phrase: '7 usdc', number: '7' },
      ],
      spans: [
        { text: 'riya', kind: 'name' },
        { text: 'Mihir', kind: 'name' },
      ],
    });
    await run(ctx);
    const clauseOf = (word: string) => ctx.req.scan.clauses.find((c) => c.text.includes(word))!.index;
    expect(ctx.req.spans.map((s) => s.span!.clause_index)).toEqual([clauseOf('riya'), clauseOf('Mihir')]);
  });
});

function seedPrevious(
  ctx: TestContext,
  names: Array<{ name: string; address?: string }>,
  kinds: Array<'single' | 'group'> = [],
): string[] {
  const phs = names.map((n, i) =>
    ctx.repos.db3.mint({
      session_id: ctx.req.session_id,
      request_id: 'req_000000000000',
      kind: kinds[i] ?? 'single',
      name: n.name,
      address: (n.address ?? ADDR) as never,
      ens_name: null,
      chain_id: 84532,
      group_placeholder: null,
      source: 'contact',
    }),
  );
  ctx.repos.db8.appendHistory({
    session_id: ctx.req.session_id,
    request_id: 'req_000000000000',
    payments_json: JSON.stringify(
      phs.map((p) => ({ kind: 'i', amount: 'amount_00000000', recipient: p, chain: 'unstated' })),
    ),
    handed_off_at: '2026-11-05T10:00:00.000Z',
  });
  return phs;
}

describe('S5 follow-ups (rule 7, §17.2 steps 2-3, C-115, C-413, C-414, C-316, C-315)', () => {
  const typed = 'send 5 usdc more to her';

  it('back-reference word + no payee + exactly one previous payee → used (followup_placeholder, source user)', async () => {
    const ctx = await setup(typed, {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'her', kind: 'name' }],
    });
    const [ph] = seedPrevious(ctx, [{ name: 'Aradhya' }]);
    const r = await run(ctx);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toEqual([
      {
        text: 'Aradhya',
        kind: 'name',
        role: 'payee',
        span: null,
        source: 'user',
        followup_placeholder: ph,
        untrusted_item_index: null,
      },
    ]);
  });

  it('several previous payees → Q_FOLLOWUP_WHO (chips = payees); the chosen chip becomes the payee', async () => {
    const ctx = await setup(typed, { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
    const [a, b] = seedPrevious(ctx, [{ name: 'Aradhya' }, { name: 'Mihir', address: ADDR2 }]);
    const r = await run(ctx, [text('nobody'), chip(b!)]);
    expect(r.questions[0]).toMatchObject({
      code: 'Q_FOLLOWUP_WHO',
      input: 'chips',
      text: 'Who should get this: Aradhya and Mihir?',
    });
    expect(r.questions[0]?.chips.map((c) => c.id)).toEqual([a, b]);
    expect(r.questions[1]?.attempt).toBe(2);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.spans).toHaveLength(1);
    expect(ctx.req.spans[0]).toMatchObject({ text: 'Mihir', followup_placeholder: b, span: null });
  });

  it('no previous payee (empty history) → Q_NO_PAYEE', async () => {
    const ctx = await setup(typed, { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
    const r = await run(ctx);
    expect(r.questions[0]).toMatchObject({ code: 'Q_NO_PAYEE', text: 'Who should receive this?' });
  });

  it('only the MOST RECENT history entry counts, and group recipients are not offered', async () => {
    const ctx = await setup(typed, { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
    seedPrevious(ctx, [{ name: 'Old1' }, { name: 'Old2', address: ADDR2 }]);
    const [recent] = seedPrevious(ctx, [{ name: 'Recent' }]);
    const r = await run(ctx);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(ctx.req.spans[0]?.followup_placeholder).toBe(recent);

    const g = await setup(typed, { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
    seedPrevious(g, [{ name: 'Grp' }], ['group']);
    expect((await run(g)).questions[0]?.code).toBe('Q_NO_PAYEE');
  });

  it('a stated payee beats the follow-up path (history is not consulted)', async () => {
    const ctx = await setup('send 5 usdc more to riya', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'riya', kind: 'name' }],
    });
    seedPrevious(ctx, [{ name: 'Aradhya' }]);
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya', 'name']]);
    expect(ctx.req.spans[0]?.followup_placeholder).toBeNull();
  });

  it('Q_NO_PAYEE answers: name / ens / address text become a user span of the right kind; empty re-asks', async () => {
    for (const [ans, kind] of [
      ['Riya', 'name'],
      ['riya.eth', 'ens'],
      [ADDR, 'address'],
    ] as const) {
      const ctx = await setup('pay 5 usdc', { amounts: [{ phrase: '5 usdc', number: '5' }], spans: [] });
      const r = await run(ctx, [text('   '), text(ans)]);
      expect(r.questions.map((q) => q.attempt)).toEqual([1, 2]);
      expect(r.result).toEqual({ kind: 'continue' });
      expect(ctx.req.spans).toEqual([
        {
          text: ans,
          kind,
          role: 'payee',
          span: null,
          source: 'user',
          followup_placeholder: null,
          untrusted_item_index: null,
        },
      ]);
    }
  });

  it('Q_NO_PAYEE asked for k and l as well (rule 9); not for a request without i/k/l', async () => {
    for (const actions of [['k'], ['l']] as ActionKind[][]) {
      const ctx = await setup('do it', { spans: [], actions });
      expect((await run(ctx)).questions[0]?.code).toBe('Q_NO_PAYEE');
    }
    const none = await setup('do it', { spans: [], actions: [] });
    expect((await run(none)).result).toEqual({ kind: 'continue' });
  });
});

describe('S5 document payees (rule 8, C-116, SQB-17, C-397)', () => {
  const q = (o: Partial<QItem>, item_index = 0): QItem => ({
    item_index,
    address: null,
    ens_name: null,
    amount: null,
    token: null,
    ...o,
  });

  it('no typed payee and no back-reference: document addresses / ENS names become source=untrusted payees', async () => {
    const ctx = await setup('pay what the invoice says', {
      untrusted: [q({ address: ADDR }), q({ ens_name: 'riya.eth' }, 1)],
    });
    const r = await run(ctx);
    expect(r.result).toEqual({ kind: 'continue' });
    const spans: RecipientSpan[] = ctx.req.spans;
    expect(spans).toEqual([
      {
        text: ADDR,
        kind: 'address',
        role: 'payee',
        span: null,
        source: 'untrusted',
        followup_placeholder: null,
        untrusted_item_index: 0,
      },
      {
        text: 'riya.eth',
        kind: 'ens',
        role: 'payee',
        span: null,
        source: 'untrusted',
        followup_placeholder: null,
        untrusted_item_index: 1,
      },
    ]);
  });

  it('SQB-17: an item with both address and ENS uses the address; duplicates collapse', async () => {
    const ctx = await setup('pay what the invoice says', {
      untrusted: [
        q({ address: ADDR, ens_name: 'a.eth' }),
        q({ address: ADDR.toLowerCase() as never }, 1),
        q({ ens_name: 'b.eth' }, 2),
        q({ ens_name: 'B.eth' }, 3),
      ],
    });
    await run(ctx);
    expect(ctx.req.spans.map((s) => s.text)).toEqual([ADDR, 'b.eth']);
  });

  it('a typed payee means document payees are ignored (C-397)', async () => {
    const ctx = await setup('send 5 usdc to riya', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'riya', kind: 'name' }],
      untrusted: [q({ address: ADDR })],
    });
    await run(ctx);
    expect(payees(ctx)).toEqual([['riya', 'name']]);
    expect(ctx.req.spans[0]?.source).toBe('user');
  });

  it('with a back-reference word the follow-up path is used, not the document', async () => {
    const ctx = await setup('send 5 usdc more to her', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [],
      untrusted: [q({ address: ADDR })],
    });
    const r = await run(ctx);
    expect(r.questions[0]?.code).toBe('Q_NO_PAYEE');
    expect(ctx.req.spans).toEqual([]);
  });

  it('C-399: document values never appear in the LLM #3 prompt', async () => {
    const ctx = await setup('pay what the invoice says', {
      untrusted: [q({ address: ADDR2, ens_name: 'evil.eth', amount: '999.5', token: 'USDC' })],
      s3answers: [chip('use_amount')],
    });
    await run(ctx);
    const all = ctx.llm.recorded.map((c) => c.system + c.user).join('\n');
    for (const s of [ADDR2, 'evil.eth', '999.5']) expect(all).not.toContain(s);
  });
});

describe('S5 SPLIT_UNSUPPORTED (§8.5 rule 3, decided after S5, C-108)', () => {
  const two: Sp[] = [
    { text: 'riya', kind: 'name' },
    { text: 'mihir', kind: 'name' },
  ];

  it('split word + exactly one pay amount + two recipients → SPLIT_UNSUPPORTED', async () => {
    const ctx = await setup('split 30 usdc between riya and mihir', {
      amounts: [{ phrase: '30 usdc', number: '30' }],
      spans: two,
    });
    expect(ctx.req.scan.split.length).toBeGreaterThan(0);
    expect((await run(ctx)).result).toEqual({ kind: 'error', code: 'SPLIT_UNSUPPORTED' });
  });

  it('one recipient, or two amounts, or no split word → fine', async () => {
    const a = await setup('split 30 usdc with riya', {
      amounts: [{ phrase: '30 usdc', number: '30' }],
      spans: [two[0]!],
    });
    expect((await run(a)).result).toEqual({ kind: 'continue' });
    const b = await setup('split 30 usdc and 10 usdc between riya and mihir', {
      amounts: [
        { phrase: '30 usdc', number: '30' },
        { phrase: '10 usdc', number: '10' },
      ],
      spans: two,
    });
    expect((await run(b)).result).toEqual({ kind: 'continue' });
    const c = await setup('send 30 usdc to riya and mihir', {
      amounts: [{ phrase: '30 usdc', number: '30' }],
      spans: two,
    });
    expect((await run(c)).result).toEqual({ kind: 'continue' });
  });
});

describe('S5 failures and re-entrancy', () => {
  it('LLM #3 failing twice → MODEL_FAILED', async () => {
    const ctx = await scannedCtx('send 5 usdc to riya', {
      fixture: {
        calls: [
          {
            name: 'amounts',
            match: 'send',
            output: {
              amounts: [{ phrase: '5 usdc', number: '5', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
            },
          },
          { name: 'spans', match: '', output: null },
          { name: 'spans', match: '', output: null, attempt: 2 },
        ],
      },
    });
    await drive(s3, ctx);
    ctx.req.actions = ['i'];
    expect((await run(ctx)).result).toEqual({ kind: 'error', code: 'MODEL_FAILED' });
  });

  it('step() after completion continues without a second LLM call', async () => {
    const ctx = await setup('send 5 usdc to riya', {
      amounts: [{ phrase: '5 usdc', number: '5' }],
      spans: [{ text: 'riya', kind: 'name' }],
    });
    await run(ctx);
    expect(await s5.step(ctx)).toEqual({ kind: 'continue' });
    expect(ctx.llm.recorded.filter((c) => c.name === 'spans')).toHaveLength(1);
  });
});

describe('S5 Q_NAME_ROLE (F-12, SQ-O-01)', () => {
  const T = 'pay Aman 5 usdc; Aman is my flatmate';
  const base = {
    amounts: [{ phrase: '5 usdc', number: '5' }],
    spans: [
      { text: 'Aman', kind: 'name' as const },
      { text: 'Aman', kind: 'name' as const, role: 'mentioned' as const },
    ],
  };
  const spansCalls = (ctx: TestContext) => ctx.llm.recorded.filter((c) => c.name === 'spans');

  it('F-12: the question shape (text, chips, code), asked before req.spans is set', async () => {
    const ctx = await setup(T, base);
    const r = await run(ctx);
    expect(r.result.kind).toBe('question');
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0]!;
    expect(q.code).toBe('Q_NAME_ROLE');
    expect(q.text).toBe('Should I pay Aman?');
    expect(q.chips.map((c) => ({ id: c.id, label: c.label }))).toEqual([
      { id: 'pay', label: 'Yes, pay Aman' },
      { id: 'only_mentioned', label: "No, they're only mentioned" },
    ]);
    expect(q.attempt).toBe(1);
    expect(ctx.req.spans).toEqual([]);
  });

  it('F-12: "Yes, pay" by chip keeps the payee and drops that name\'s mentioned spans', async () => {
    const ctx = await setup(T, base);
    const r = await run(ctx, [chip('pay')]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([['Aman', 'name']]);
    expect(ctx.req.spans[0]!.span!.start).toBe(T.indexOf('Aman'));
    expect(ctx.req.mentioned_spans).toEqual([]);
    expectOffsetContract(ctx);
    expectLabelsOk(ctx);
  });

  it('F-12: a typed "yes" maps to the pay chip', async () => {
    const ctx = await setup(T, base);
    const r = await run(ctx, [text('yes')]);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([['Aman', 'name']]);
    expect(ctx.req.mentioned_spans).toEqual([]);
  });

  it('F-12: only mentioned (typed "no"), no payee left -> normal flow Q_NO_PAYEE; every occurrence is mentioned', async () => {
    const ctx = await setup(T, base);
    const r = await run(ctx, [text('no')]);
    expect(r.questions.map((q) => q.code)).toEqual(['Q_NAME_ROLE', 'Q_NO_PAYEE']);
    expect(ctx.req.spans).toEqual([]);
    expect(ctx.req.mentioned_spans.map((m) => m.text)).toEqual(['Aman', 'Aman']);
    const masked = ctx.req.masked_text_s3 ?? '';
    expect(ctx.req.mentioned_spans.map((m) => m.start)).toEqual([masked.indexOf('Aman'), masked.lastIndexOf('Aman')]);
    expectOffsetContract(ctx);
  });

  it('F-12: only mentioned (chip) while another payee remains -> no further question', async () => {
    const typed = 'pay Aman and Riya 5 usdc; Aman is my flatmate';
    const ctx = await setup(typed, {
      amounts: base.amounts,
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Riya', kind: 'name' },
        { text: 'Aman', kind: 'name', role: 'mentioned' },
      ],
    });
    const r = await run(ctx, [chip('only_mentioned')]);
    expect(r.questions.map((q) => q.code)).toEqual(['Q_NAME_ROLE']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([['Riya', 'name']]);
    expect(ctx.req.mentioned_spans.map((m) => m.text)).toEqual(['Aman', 'Aman']);
    expectOffsetContract(ctx);
  });

  it('F-12: an invalid answer re-asks with the same text and attempt+1 (the TOO_MANY_RETRIES limit belongs to the runner)', async () => {
    const ctx = await setup(T, base);
    const r = await run(ctx, [text('maybe'), text('hmm')]);
    expect(r.questions.map((q) => [q.code, q.text, q.attempt])).toEqual([
      ['Q_NAME_ROLE', 'Should I pay Aman?', 1],
      ['Q_NAME_ROLE', 'Should I pay Aman?', 2],
      ['Q_NAME_ROLE', 'Should I pay Aman?', 3],
    ]);
    expect(ctx.req.spans).toEqual([]);
  });

  it('F-12: two conflicting names are asked one at a time, in text order', async () => {
    const typed = 'pay Aman and Riya 5 usdc each; Riya is my friend, Aman is my flatmate';
    const ctx = await setup(typed, {
      amounts: base.amounts,
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Riya', kind: 'name' },
        { text: 'Riya', kind: 'name', role: 'mentioned' },
        { text: 'Aman', kind: 'name', role: 'mentioned' },
      ],
    });
    const r = await run(ctx, [chip('pay'), chip('only_mentioned')]);
    expect(r.questions.map((q) => q.text)).toEqual(['Should I pay Aman?', 'Should I pay Riya?']);
    expect(r.result).toEqual({ kind: 'continue' });
    expect(payees(ctx)).toEqual([['Aman', 'name']]);
    expect(ctx.req.mentioned_spans.map((m) => m.text)).toEqual(['Riya', 'Riya']);
    expectOffsetContract(ctx);
  });

  it('F-12: the conflict is case-insensitive ("Aradhya" payee vs "aradhya" mentioned)', async () => {
    const typed = 'pay Aradhya 5 usdc; aradhya is my flatmate';
    const ctx = await setup(typed, {
      amounts: base.amounts,
      spans: [
        { text: 'Aradhya', kind: 'name' },
        { text: 'aradhya', kind: 'name', role: 'mentioned' },
      ],
    });
    const r = await run(ctx);
    expect(r.questions.map((q) => q.code)).toEqual(['Q_NAME_ROLE']);
    expect(r.questions[0]!.text).toBe('Should I pay Aradhya?');
  });

  it('F-12: no conflict (different names) asks nothing', async () => {
    const typed = 'pay Aman 5 usdc; Kabir is my flatmate';
    const ctx = await setup(typed, {
      amounts: base.amounts,
      spans: [
        { text: 'Aman', kind: 'name' },
        { text: 'Kabir', kind: 'name', role: 'mentioned' },
      ],
    });
    const r = await run(ctx);
    expect(r.questions).toEqual([]);
    expect(r.result).toEqual({ kind: 'continue' });
  });

  it('F-12: exactly one LLM #3 (spans) call across question, re-ask and answer', async () => {
    const ctx = await setup(T, base);
    await run(ctx, [text('maybe'), chip('pay')]);
    expect(spansCalls(ctx)).toHaveLength(1);
  });
});
