// Regression coverage for B16/B17 through the real HTTP registry and SQLCipher repositories.
// LLM and execution are fixtures; no network or signing.
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
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
  ])('B16: confirms and hands off the requested local start $start', async ({ clock, start, time, first }) => {
    await withDailySchedule(`starting ${start} for 8 payments`, clock, 'America/New_York', async (h, response) => {
      const intent = await confirmSchedule(h, response);
      const startAt = Date.parse(first) / 1000;
      expect(intent.schedule).toEqual({
        start_at: startAt,
        interval_seconds: 86400,
        max_runs: 8,
        late_window_seconds: 3600,
        end_at: startAt + 7 * 86400 + 3600,
      });
      expect(intent.executor).toBe('chainlink-cre');
      expect(JSON.stringify(response.body.summary)).toContain(`at ${time} (America/New_York)`);
    });
  });

  it('B16: recurrence uses fixed UTC intervals and discloses the local-time change across DST end', async () => {
    await withDailySchedule(
      'starting October 31 2026 at 10am for 8 payments',
      '2026-10-30T14:00:00Z',
      'America/New_York',
      async (h, response) => {
        const intent = await confirmSchedule(h, response);
        const occurrences = Array.from({ length: intent.schedule.max_runs }, (_, i) =>
          DateTime.fromSeconds(intent.schedule.start_at + i * intent.schedule.interval_seconds, {
            zone: 'America/New_York',
          }),
        );
        expect(occurrences).toHaveLength(8);
        expect(occurrences.slice(0, 2).map((d) => d.toISO())).toEqual([
          '2026-10-31T10:00:00.000-04:00',
          '2026-11-01T09:00:00.000-05:00',
        ]);
        expect(intent.schedule.interval_seconds).toBe(86400);
        expect(response.body.summary?.notes.join(' ')).toContain('daylight saving');
      },
    );
  });

  it.each([
    'starting November 20 2026 until November 10 2026',
    'from 2026-11-20 to 2026-11-10',
    'starting on November 20 2026 until November 10 2026',
    'beginning on November 20 2026 until November 10 2026',
  ])('B17: rejects the reversed explicit range %s before confirmation or handoff', async (range) => {
    await withDailySchedule(range, '2026-11-05T17:30:00Z', 'Asia/Kolkata', async (h, response) => {
      expect(response.body.error?.code).toBe('AUTOPAY_NO_OCCURRENCES');
      expect(response.body.state).not.toBe('awaiting_confirmation');
      expect(response.body.summary).toBeUndefined();
      expect(h.exec.submissions).toHaveLength(0);
      const attempted = await h.confirm(response, 'yes');
      expect(attempted.body.state).not.toBe('done');
      expect(h.exec.submissions).toHaveLength(0);
    });
  });

  it.each(['starting November 10 2026 until November 20 2026', 'from 10 to 20 November 2026'])(
    'B17: still hands off the valid inclusive range %s',
    async (range) => {
      await withDailySchedule(range, '2026-11-05T17:30:00Z', 'Asia/Kolkata', async (h, response) => {
        const intent = await confirmSchedule(h, response);
        const startAt = Date.parse('2026-11-10T10:00:00+05:30') / 1000;
        expect(intent.schedule).toEqual({
          start_at: startAt,
          interval_seconds: 86400,
          max_runs: 11,
          late_window_seconds: 3600,
          end_at: startAt + 10 * 86400 + 3600,
        });
        expect(intent.limits.max_total.value).toBe('11.55');
        expect(intent).not.toHaveProperty('prefund');
      });
    },
  );
});
