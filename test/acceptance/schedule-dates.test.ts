// Regression coverage for B16/B17 through the real HTTP registry and SQLCipher repositories.
// LLM and execution are fixtures; no network or signing.
import { describe, expect, it } from 'vitest';
import { enumerateOccurrences } from '../../src/plan/schedule.js';
import { BASE, Harness, type Resp } from './harness.js';
import type { FixtureCall, FixtureFile } from '../fakes/llm.js';

const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output, attempt: 1 });

function dailyFixture(): FixtureFile {
  return {
    calls: [
      call('amounts', {
        amounts: [{ phrase: '1 usdc', number: '1', relative: null, token: 'USDC', fiat: null, role: 'pay' }],
      }),
      call('request_type', { request_type: 'actions', actions: ['k'], also_balance: false }),
      call('spans', { spans: [{ text: 'Mihir', kind: 'name', role: 'payee' }] }),
      call('payments', {
        payments: [
          {
            kind: 'k',
            amount: '$amount:0',
            recipient: '$recipient:0',
            chain: BASE,
            frequency: 'daily',
            interval: 1,
            times_per_week: null,
            days_of_week: null,
            day_of_month: null,
          },
        ],
      }),
    ],
  };
}

async function withDailySchedule(
  prompt: string,
  clock: string,
  timezone: string,
  check: (h: Harness, response: Resp) => Promise<void>,
): Promise<void> {
  const h = new Harness('schedule-dates', dailyFixture(), {
    clock,
    balances: { [BASE]: { USDC: '2000', ETH: '0.1' } },
  });
  try {
    await h.open(timezone);
    const response = await h.say(`pay 1 usdc to Mihir daily ${prompt} on base`);
    expect(response.http).toBe(200);
    await check(h, response);
  } finally {
    await h.finish();
  }
}

async function confirmSchedule(h: Harness, response: Resp) {
  expect(response.body.state).toBe('awaiting_confirmation');
  const confirmed = await h.confirm(response, 'yes');
  expect(confirmed.http).toBe(200);
  expect(confirmed.body.state).toBe('done');
  expect(h.exec.submissions).toHaveLength(1);
  const intent = h.envelope.intents.find((p) => p.intent_id === 'k');
  if (!intent || intent.intent_id !== 'k') throw new Error('expected an autopay envelope');
  return intent;
}

describe('schedule dates through HTTP', () => {
  it.each([
    {
      clock: '2026-01-15T15:00:00Z',
      start: 'July 1 2026 at 10am',
      date: '2026-07-01',
      time: '10:00',
      first: '2026-07-01T10:00:00-04:00',
      cron: '0 10 * * *',
    },
    {
      clock: '2026-07-15T14:00:00Z',
      start: 'December 1 2026 at 00:30',
      date: '2026-12-01',
      time: '00:30',
      first: '2026-12-01T00:30:00-05:00',
      cron: '30 0 * * *',
    },
    {
      clock: '2026-01-15T15:00:00Z',
      start: 'February 1 2026 at 10am',
      date: '2026-02-01',
      time: '10:00',
      first: '2026-02-01T10:00:00-05:00',
      cron: '0 10 * * *',
    },
    {
      clock: '2026-03-07T15:00:00Z',
      start: 'in 2 days at 10am',
      date: '2026-03-09',
      time: '10:00',
      first: '2026-03-09T10:00:00-04:00',
      cron: '0 10 * * *',
    },
    {
      clock: '2026-10-31T14:00:00Z',
      start: 'in 2 days at 00:30',
      date: '2026-11-02',
      time: '00:30',
      first: '2026-11-02T00:30:00-05:00',
      cron: '30 0 * * *',
    },
  ])(
    'B16: confirms and hands off the requested local start $start',
    async ({ clock, start, date, time, first, cron }) => {
      await withDailySchedule(`starting ${start} for 8 payments`, clock, 'America/New_York', async (h, response) => {
        const intent = await confirmSchedule(h, response);
        expect(intent.schedule).toMatchObject({
          timezone: 'America/New_York',
          start_date: date,
          time_of_day: time,
          first_occurrence: first,
        });
        expect(intent.cre_job).toMatchObject({ cron, timezone: 'America/New_York' });
        expect(JSON.stringify(response.body.summary)).toContain(`at ${time} (America/New_York)`);
      });
    },
  );

  it('B16: recurrence retains its wall time as the IANA zone crosses DST end', async () => {
    await withDailySchedule(
      'starting October 31 2026 at 10am for 8 payments',
      '2026-10-30T14:00:00Z',
      'America/New_York',
      async (h, response) => {
        const intent = await confirmSchedule(h, response);
        const occurrences = enumerateOccurrences(intent.schedule, 52).occurrences;
        expect(occurrences).toHaveLength(8);
        expect(occurrences.slice(0, 2).map((d) => d.toISO())).toEqual([
          '2026-10-31T10:00:00.000-04:00',
          '2026-11-01T10:00:00.000-05:00',
        ]);
        expect(intent.cre_job.cron).toBe('0 10 * * *');
      },
    );
  });

  it.each(['starting November 20 2026 until November 10 2026', 'from 2026-11-20 to 2026-11-10'])(
    'B17: rejects the reversed explicit range %s before confirmation or handoff',
    async (range) => {
      await withDailySchedule(range, '2026-11-05T17:30:00Z', 'Asia/Kolkata', async (h, response) => {
        expect(response.body.error?.code).toBe('AUTOPAY_NO_OCCURRENCES');
        expect(response.body.state).not.toBe('awaiting_confirmation');
        expect(response.body.summary).toBeUndefined();
        expect(h.exec.submissions).toHaveLength(0);
        const attempted = await h.confirm(response, 'yes');
        expect(attempted.body.state).not.toBe('done');
        expect(h.exec.submissions).toHaveLength(0);
      });
    },
  );

  it.each(['starting November 10 2026 until November 20 2026', 'from 10 to 20 November 2026'])(
    'B17: still hands off the valid inclusive range %s',
    async (range) => {
      await withDailySchedule(range, '2026-11-05T17:30:00Z', 'Asia/Kolkata', async (h, response) => {
        const intent = await confirmSchedule(h, response);
        expect(intent.schedule).toMatchObject({
          start_date: '2026-11-10',
          first_occurrence: '2026-11-10T10:00:00+05:30',
          end: { type: 'on_date', date: '2026-11-20' },
        });
        expect(intent.prefund.value).toBe('11');
        const occurrences = enumerateOccurrences(intent.schedule, 52).occurrences;
        expect(occurrences).toHaveLength(11);
        expect(occurrences.at(-1)?.toISODate()).toBe('2026-11-20');
      });
    },
  );
});
