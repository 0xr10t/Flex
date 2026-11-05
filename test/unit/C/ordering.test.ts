// Lane C — §8.7 S6 order of resolution, §9.7 one question at a time in payee order + attempt counting,
// §13.4 question shape, §18 logging.
import { describe, expect, it } from 'vitest';
import { s6 } from '../../../src/pipeline/s6-resolve.js';
import {
  ARB,
  BASE,
  COIN,
  Driver,
  NEWADDR,
  OTHER,
  RIYA,
  expectCleanLogs,
  expectQuestion,
  makeCtx,
  start,
} from './helpers.js';

describe('§9.7 ordering and counting', () => {
  it('C-200 C-118 §9.7: questions one at a time, in the order payees appear', async () => {
    const ctx = makeCtx({
      text: `pay riya, Mihir and ${NEWADDR}`,
      spans: [
        { text: 'riya', kind: 'name' },
        { text: 'Mihir', kind: 'name' },
        { text: NEWADDR, kind: 'address' },
      ],
    });
    const d = new Driver(ctx);
    await d.start();
    expect(expectQuestion(d, 'Q_WHO_IS').text).toBe('Who is "riya"?');
    expect(ctx.req.resolved).toEqual([]);
    await d.text(OTHER);
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    await d.chip('yes');
    await d.text('Riya');
    // Mihir (known) is resolved silently; the next question is for the third payee.
    expect(expectQuestion(d, 'Q_ADDRESS_CORRECT', 1).text).toBe(`Is ${NEWADDR} correct?`);
    expect(ctx.req.resolved.map((r) => r.display_name)).toEqual(['Riya', 'Mihir']);
    await d.chip('yes');
    await d.text('Third');
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved.map((r) => [r.span_index, r.display_name])).toEqual([
      [0, 'Riya'],
      [1, 'Mihir'],
      [2, 'Third'],
    ]);
    expect(ctx.req.state).toBe('RECIPIENTS_RESOLVED');
    expectCleanLogs(ctx, ['riya', 'mihir', 'third']);
  });

  it('C-118 §8.7: all payees known → no question, resolved aligned with spans, n_payees logged', async () => {
    const { ctx, d } = await start({
      text: 'pay Mihir and Aradhya',
      spans: [
        { text: 'Mihir', kind: 'name' },
        { text: 'Aradhya', kind: 'name' },
      ],
    });
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved.map((r) => r.span_index)).toEqual([0, 1]);
    expect(ctx.log.lines).toContainEqual(
      expect.objectContaining({ event: 'recipients_resolved', step: 's6', n_payees: 2 }),
    );
  });

  it('C-118 §8.7: no payees → continue without questions', async () => {
    const { ctx, d } = await start({ text: 'what is my balance' });
    expect(d.last).toEqual({ kind: 'continue' });
    expect(ctx.req.resolved).toEqual([]);
  });

  it('C-200 §9.7: every re-ask has a new question_id, attempt+1, max_attempts 4', async () => {
    const { d } = await start({ text: 'pay riya', spans: [{ text: 'riya', kind: 'name' }] });
    const ids = new Set<string>();
    for (let attempt = 1; attempt <= 4; attempt++) {
      const q = expectQuestion(d, 'Q_WHO_IS', attempt);
      ids.add(q.question_id);
      if (attempt < 4) await d.text('?');
    }
    expect(ids.size).toBe(4);
  });

  it('C-200 §9.7: a new question for the same payee starts at attempt 1 (only re-asks count)', async () => {
    const { d } = await start({ text: 'pay riya', spans: [{ text: 'riya', kind: 'name' }] });
    await d.text('??');
    await d.text('??');
    expectQuestion(d, 'Q_WHO_IS', 3);
    await d.text(NEWADDR);
    expectQuestion(d, 'Q_ADDRESS_CORRECT', 1);
    await d.chip('yes');
    expectQuestion(d, 'Q_NAME_FOR_ADDRESS', 1);
  });

  it('C-200 §3.3 step contract: re-entering S6 while a question is pending returns that question unchanged', async () => {
    const { ctx, d } = await start({ text: 'pay riya', spans: [{ text: 'riya', kind: 'name' }] });
    const q = d.q;
    expect(await s6.step(ctx)).toEqual({ kind: 'question', question: q });
  });

  it('C-200 §9.7: an ENS payee with differing chains is asked after the earlier payee is done', async () => {
    const ctx = makeCtx({
      text: `pay ${NEWADDR} and riya.eth`,
      spans: [
        { text: NEWADDR, kind: 'address' },
        { text: 'riya.eth', kind: 'ens' },
      ],
    });
    ctx.ens.set('riya.eth', COIN[BASE], RIYA).set('riya.eth', COIN[ARB], OTHER);
    const d = new Driver(ctx);
    await d.start();
    expectQuestion(d, 'Q_ADDRESS_CORRECT');
    expect(ctx.ens.calls).toEqual([]); // the second payee is not touched yet
    await d.chip('yes');
    await d.text('First');
    expectQuestion(d, 'Q_ENS_CHAIN', 1);
  });
});
