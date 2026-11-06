// Independent P10 regressions for the two observed live-model interval errors. No model or network calls.
import { describe, expect, it } from 'vitest';
import { s8 } from '../../../src/pipeline/s8-pair.js';
import { s9 } from '../../../src/pipeline/s9-plan.js';
import { enumerateOccurrences } from '../../../src/plan/schedule.js';
import { FixtureLlmClient } from '../../fakes/llm.js';
import {
  addAmount,
  addAradhya,
  addMihir,
  ctxD,
  expectError,
  llmItem,
  paymentsCall,
  setClauses,
  type SchedFields,
} from './helpers.js';
import { amountOf, asK, usdc } from './s9-helpers.js';

function setup(text: string, first: SchedFields, second?: SchedFields) {
  const ctx = ctxD({ actions: ['k'], balances: usdc('0', '1000', '0') });
  setClauses(ctx, [text]);
  const value = text.includes('10 usdc') ? '10' : '5';
  const amount = addAmount(ctx, value);
  const recipient = text.includes('aradhya') ? addAradhya(ctx) : addMihir(ctx);
  ctx.req.masked_text_s8 = text.replace(`${value} usdc`, amount).replace(/mihir|aradhya/, recipient);
  const llm = new FixtureLlmClient({
    calls: [
      paymentsCall(amount, [llmItem('k', amount, recipient, 'unstated', first)]),
      ...(second === undefined
        ? []
        : [paymentsCall('CORRECTION: ', [llmItem('k', amount, recipient, 'unstated', second)])]),
    ],
  });
  ctx.llm = llm;
  return { ctx, llm };
}

describe('P10 live-model schedule regressions', () => {
  const liveCases: Array<{ id: string; text: string; fields: SchedFields }> = [
    {
      id: 'LIVE-P061',
      text: 'pay mihir 5 usdc every monday for 4 weeks',
      fields: { frequency: 'weekly', days_of_week: ['MON'] },
    },
    {
      id: 'LIVE-P073',
      text: 'pay aradhya 10 usdc every month on the 31st for 4 months',
      fields: { frequency: 'monthly', day_of_month: 31 },
    },
  ];

  it.each(liveCases)('$id P10 wrong interval twice ends with PAIRING_FAILED and no plan', async ({ text, fields }) => {
    const wrong = { ...fields, interval: 4 };
    const { ctx, llm } = setup(text, wrong, wrong);
    expectError(await s8.step(ctx), 'PAIRING_FAILED');
    expect(ctx.req.payments).toBeUndefined();
    expect(ctx.req.plan).toBeUndefined();
    expect(ctx.exec.submissions).toHaveLength(0);
    expect(llm.recorded).toHaveLength(2);
    expect(llm.recorded[0]?.user).not.toContain('CORRECTION:');
    expect(llm.recorded[1]?.user).toContain('how long, not how often; interval must be 1.');
  });

  it.each(liveCases)('$id P10 wrong then right plans all four occurrences at interval 1', async ({ text, fields }) => {
    const { ctx, llm } = setup(text, { ...fields, interval: 4 }, { ...fields, interval: 1 });
    expect(await s8.step(ctx)).toEqual({ kind: 'continue' });
    expect(llm.recorded).toHaveLength(2);
    let result = await s9.step(ctx);
    if (fields.frequency === 'monthly') {
      if (result.kind !== 'question') throw new Error('monthly choice required');
      expect(result.question.code).toBe('Q_AUTOPAY_MONTHLY');
      await s9.onAnswer?.(ctx, result.question, { kind: 'chip', chip_id: 'thirty_days' });
      result = await s9.step(ctx);
    }
    expect(result).toEqual({ kind: 'continue' });
    const k = asK(ctx.req.plan?.[0]);
    expect(k.schedule.interval_seconds).toBe(fields.frequency === 'monthly' ? 30 * 86400 : 604800);
    expect(k.schedule.max_runs).toBe(4);
    expect(amountOf(ctx, k.limits.max_total)).toBe(fields.frequency === 'monthly' ? '40.2' : '20.2');
    expect(ctx.exec.submissions).toHaveLength(0);
  });

  it.each([
    { phrase: 'every other friday', days_of_week: ['FRI'] as const },
    { phrase: 'every 2 weeks', days_of_week: null },
    { phrase: 'fortnightly', days_of_week: null },
  ])('P10 accepts the explicit interval in "$phrase" without a retry', async ({ phrase, days_of_week }) => {
    const { ctx, llm } = setup(`pay mihir 5 usdc ${phrase} for 4 payments`, {
      frequency: 'weekly',
      interval: 2,
      days_of_week: days_of_week === null ? null : [...days_of_week],
    });
    expect(await s8.step(ctx)).toEqual({ kind: 'continue' });
    expect(llm.recorded).toHaveLength(1);
    expect(await s9.step(ctx)).toEqual({ kind: 'continue' });
    const k = asK(ctx.req.plan?.[0]);
    expect(k.display.schedule).toMatchObject({ frequency: 'weekly', interval: 2 });
    const occurrences = enumerateOccurrences(k.display.schedule, 52).occurrences;
    expect(occurrences).toHaveLength(4);
    expect(occurrences[1]?.diff(occurrences[0]!, 'days').days).toBe(14);
  });

  it.each([
    { phrase: 'every 1 week', frequency: 'weekly' as const },
    { phrase: 'every one month', frequency: 'monthly' as const },
    { phrase: 'every one day', frequency: 'daily' as const },
  ])('P10 accepts matching explicit interval 1 in "$phrase"', async ({ phrase, frequency }) => {
    const fields = { frequency, interval: 1 };
    const { ctx, llm } = setup(`pay mihir 5 usdc ${phrase} for 4 payments`, fields, fields);
    expect(await s8.step(ctx)).toEqual({ kind: 'continue' });
    expect(llm.recorded).toHaveLength(1);
  });

  it.each([
    {
      text: 'pay mihir 5 usdc every week for 4 payments',
      wrong: { frequency: 'weekly' as const, interval: 1, days_of_week: ['MON' as const] },
      correction: 'the request names no day of the week',
    },
    {
      text: 'pay mihir 5 usdc every month for 4 payments',
      wrong: { frequency: 'monthly' as const, interval: 1, day_of_month: 15 },
      correction: 'day_of_month must be a day the user wrote',
    },
    {
      text: 'pay mihir 5 usdc every week for 4 payments',
      wrong: { frequency: 'weekly' as const, interval: 1, times_per_week: 3 },
      correction: 'times_per_week needs',
    },
  ])('P10 rejects invented schedule fields: $correction', async ({ text, wrong, correction }) => {
    const { ctx, llm } = setup(text, wrong, wrong);
    expectError(await s8.step(ctx), 'PAIRING_FAILED');
    expect(llm.recorded[1]?.user).toContain(correction);
    expect(ctx.req.plan).toBeUndefined();
  });
});
