// Lane D tester: §10.6 autopay schedule (pure functions in src/plan/schedule.ts + S9 questions/derived values)
// and §10.7 cancel (`l`).
import { DateTime } from 'luxon';
import { describe, expect, it, vi } from 'vitest';
import type { CalendarSchedule, Weekday } from '../../../src/contracts/types.js';
import {
  clampDayOfMonth,
  cronFor,
  daysForTimesPerWeek,
  enumerateOccurrences,
  expiresAt,
  firstOccurrence,
  onDateForDuration,
  parseEnd,
  paymentsPerWeek,
  type ScheduleCore,
} from '../../../src/plan/schedule.js';
import {
  ALICE_CS,
  ARB,
  BASE,
  addAmount,
  addAutopay,
  addMihir,
  planIdFor,
  ctxD,
  expectError,
  expectQuestion,
  pay,
  sched,
  setLimits,
  weekly,
} from './helpers.js';
import { fakeParseAmountText } from './parse-mock.js';
import {
  NOW_E6,
  amountOf,
  answerAndReenter,
  asK,
  asL,
  asJ,
  chip,
  db1Count,
  expectValidPlan,
  kSetup,
  planOf,
  run,
  runOk,
  text,
  usdc,
  type KOpts,
} from './s9-helpers.js';

vi.mock('../../../src/amounts/parse.js', async () => {
  const m = await import('./parse-mock.js');
  return { parseAmountText: (t: string) => m.fakeParseAmountText(t) };
});

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const thu = DateTime.fromISO('2026-11-05T23:00:00', { zone: IST }); // Thursday
const ms = (iso: string): number => DateTime.fromISO(iso, { setZone: true }).toMillis();
const local = (dts: DateTime[]): string[] => dts.map((d) => d.toFormat('yyyy-MM-dd HH:mm'));
const pInt = (s: string): number | null => {
  const r = fakeParseAmountText(s);
  return r.ok ? Number(r.value) : null;
};

/** A `k` with an end phrase so only the field under test can ask a question. */
const withEnd = (o: KOpts, end = 'for 4 payments'): KOpts => ({
  ...o,
  clause: `${o.clause ?? 'pay mihir 10 usdc every friday'} ${end}`,
});

describe('C-449 §20.1 schedule: schedule.ts pure functions (§10.6)', () => {
  it.each([
    [1, ['THU']],
    [2, ['MON', 'THU']],
    [3, ['MON', 'WED', 'FRI']],
    [4, ['MON', 'TUE', 'THU', 'FRI']],
    [5, ['MON', 'TUE', 'WED', 'THU', 'FRI']],
    [6, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']],
  ] as Array<[number, Weekday[]]>)('C-226 §10.6 times_per_week %i → %j (1 = today, a Thursday)', (n, days) => {
    expect(daysForTimesPerWeek(n, thu)).toEqual(days);
  });

  it('C-227 §10.6 day_of_month: 1–28 unchanged, 29–31 → 28 (clamped)', () => {
    expect(clampDayOfMonth(1)).toEqual({ day: 1, clamped: false });
    expect(clampDayOfMonth(28)).toEqual({ day: 28, clamped: false });
    for (const d of [29, 30, 31]) expect(clampDayOfMonth(d)).toEqual({ day: 28, clamped: true });
  });

  it('C-240 §10.6 derived 9: cron strings (weekly 0=SUN…6=SAT sorted, daily, monthly)', () => {
    const base = { time_of_day: '10:00', day_of_month: null, days_of_week: null };
    expect(cronFor({ ...base, frequency: 'weekly', days_of_week: ['FRI'] })).toBe('0 10 * * 5');
    expect(cronFor({ ...base, frequency: 'weekly', days_of_week: ['SUN'] })).toBe('0 10 * * 0');
    expect(cronFor({ ...base, frequency: 'weekly', days_of_week: ['SAT', 'MON', 'WED'] })).toBe('0 10 * * 1,3,6');
    expect(cronFor({ ...base, frequency: 'daily', time_of_day: '18:30' })).toBe('30 18 * * *');
    expect(cronFor({ ...base, frequency: 'monthly', day_of_month: 15 })).toBe('0 10 15 * *');
  });

  it('C-235 §10.6 derived 4: payments in any 7-day window (daily ⌈7/i⌉, weekly = days, monthly 1)', () => {
    expect(paymentsPerWeek({ frequency: 'daily', interval: 1, days_of_week: null })).toBe(7n);
    expect(paymentsPerWeek({ frequency: 'daily', interval: 2, days_of_week: null })).toBe(4n);
    expect(paymentsPerWeek({ frequency: 'daily', interval: 7, days_of_week: null })).toBe(1n);
    expect(paymentsPerWeek({ frequency: 'weekly', interval: 1, days_of_week: ['MON', 'WED', 'FRI'] })).toBe(3n);
    expect(paymentsPerWeek({ frequency: 'monthly', interval: 1, days_of_week: null })).toBe(1n);
  });

  it('C-239 §10.6 derived 8: expires_at = 23:59:59 on the last occurrence date in the timezone, as UTC', () => {
    const last = DateTime.fromISO('2026-12-25T10:00:00', { zone: IST });
    expect(expiresAt(last, IST)).toBe('2026-12-25T18:29:59Z');
    const ny = DateTime.fromISO('2026-11-05T10:00:00', { zone: NY });
    expect(expiresAt(ny, NY)).toBe('2026-11-06T04:59:59Z');
  });

  it('C-231 §10.6 end: "for N weeks/months/days" → first date + N units − 1 day', () => {
    const first = DateTime.fromISO('2026-11-06T10:00:00', { zone: IST });
    expect(onDateForDuration(first, 8, 'weeks')).toBe('2026-12-31');
    expect(onDateForDuration(first, 10, 'days')).toBe('2026-11-15');
    expect(onDateForDuration(first, 3, 'months')).toBe('2027-02-05');
  });

  const E = [
    ['for 8 payments', { type: 'for_count', n: 8 }],
    ['for 3 times', { type: 'for_count', n: 3 }],
    ['for five payments', { type: 'for_count', n: 5 }],
    ['for 8 weeks', { type: 'for_units', n: 8, unit: 'weeks' }],
    ['for 3 months', { type: 'for_units', n: 3, unit: 'months' }],
    ['for 10 days', { type: 'for_units', n: 10, unit: 'days' }],
    ['until I cancel', { type: 'until_cancelled' }],
    ['until I stop', { type: 'until_cancelled' }],
    ['forever', { type: 'until_cancelled' }],
    ['indefinitely', { type: 'until_cancelled' }],
    ['ongoing', { type: 'until_cancelled' }],
  ] as const;
  it.each(E)('C-231 §10.6 end phrase "%s"', (phrase, expected) => {
    expect(parseEnd(`pay mihir 10 usdc every friday ${phrase}`, null, pInt)).toEqual(expected);
  });

  it('C-231 §10.6 end: "until <date>" (chrono date) → on_date; nothing stated → null', () => {
    expect(parseEnd('pay mihir 10 usdc every friday until dec 1', '2026-12-01', pInt)).toEqual({
      type: 'on_date',
      date: '2026-12-01',
    });
    expect(parseEnd('pay mihir 10 usdc every friday', null, pInt)).toBeNull();
  });

  it('C-230 §10.6 first occurrence: ≥ start_date and strictly after now (time already passed today → tomorrow)', () => {
    const core: ScheduleCore = {
      frequency: 'daily',
      interval: 1,
      days_of_week: null,
      day_of_month: null,
      time_of_day: '10:00',
      timezone: IST,
      start_date: '2026-11-05',
    };
    expect(firstOccurrence(core, thu).toMillis()).toBe(ms('2026-11-06T10:00:00+05:30'));
    expect(firstOccurrence({ ...core, time_of_day: '23:00' }, thu).toMillis()).toBe(ms('2026-11-06T23:00:00+05:30'));
    expect(firstOccurrence({ ...core, time_of_day: '23:01' }, thu).toMillis()).toBe(ms('2026-11-05T23:01:00+05:30'));
    expect(firstOccurrence({ ...core, start_date: '2026-11-10' }, thu).toMillis()).toBe(
      ms('2026-11-10T10:00:00+05:30'),
    );
  });

  it('C-230 §10.6 first occurrence: weekly picks the first listed weekday on/after start; monthly the first matching day', () => {
    const core: ScheduleCore = {
      frequency: 'weekly',
      interval: 1,
      days_of_week: ['FRI'],
      day_of_month: null,
      time_of_day: '10:00',
      timezone: IST,
      start_date: '2026-11-05',
    };
    expect(firstOccurrence(core, thu).toMillis()).toBe(ms('2026-11-06T10:00:00+05:30'));
    const monthly: ScheduleCore = { ...core, frequency: 'monthly', days_of_week: null, day_of_month: 5 };
    expect(firstOccurrence(monthly, thu).toMillis()).toBe(ms('2026-12-05T10:00:00+05:30'));
  });

  it('C-232 §10.6 derived 1: daily interval 2 keeps 10:00 local across the DST end (America/New_York)', () => {
    const s: CalendarSchedule = sched(
      'daily',
      '2026-10-30T10:00:00-04:00',
      { type: 'after_count', count: 4 },
      { interval: 2, tz: NY },
    );
    const occ = enumerateOccurrences(s, 52);
    expect(local(occ.occurrences)).toEqual([
      '2026-10-30 10:00',
      '2026-11-01 10:00',
      '2026-11-03 10:00',
      '2026-11-05 10:00',
    ]);
    expect(occ.exceedsMaxWeeks).toBe(false);
  });

  it('C-232 §10.6 derived 1: weekly interval 2 counts 7-day blocks from the first occurrence (MON, THU every 2nd week)', () => {
    const s = weekly(
      ['MON', 'THU'],
      '2026-10-26T10:00:00-04:00',
      { type: 'after_count', count: 5 },
      { interval: 2, tz: NY },
    );
    expect(local(enumerateOccurrences(s, 52).occurrences)).toEqual([
      '2026-10-26 10:00',
      '2026-10-29 10:00',
      '2026-11-09 10:00',
      '2026-11-12 10:00',
      '2026-11-23 10:00',
    ]);
  });

  it('C-232 §10.6 derived 1: monthly interval 2 keeps the day and local time (DST changes in between)', () => {
    const s = sched(
      'monthly',
      '2026-10-28T10:00:00-04:00',
      { type: 'after_count', count: 3 },
      { dom: 28, interval: 2, tz: NY },
    );
    expect(local(enumerateOccurrences(s, 52).occurrences)).toEqual([
      '2026-10-28 10:00',
      '2026-12-28 10:00',
      '2027-02-28 10:00',
    ]);
  });

  it('C-232 §10.6 derived 1: on_date includes occurrences on the end date and excludes later ones', () => {
    const s = weekly(['FRI'], '2026-11-06T10:00:00+05:30', { type: 'on_date', date: '2026-11-20' });
    expect(local(enumerateOccurrences(s, 52).occurrences)).toEqual([
      '2026-11-06 10:00',
      '2026-11-13 10:00',
      '2026-11-20 10:00',
    ]);
  });

  it('C-232 C-234 §10.6 derived 1+3: until_cancelled = occurrences before first + max weeks; no duration error', () => {
    const s = weekly(['FRI'], '2026-11-06T10:00:00+05:30', { type: 'until_cancelled' });
    const o = enumerateOccurrences(s, 52);
    expect(o.occurrences).toHaveLength(52);
    expect(o.exceedsMaxWeeks).toBe(false);
  });

  it('C-234 §10.6 derived 3: last occurrence exactly first + max weeks is allowed, one later is LIMIT', () => {
    const at = (count: number): ReturnType<typeof enumerateOccurrences> =>
      enumerateOccurrences(weekly(['FRI'], '2026-11-06T10:00:00+05:30', { type: 'after_count', count }), 52);
    expect(at(53).exceedsMaxWeeks).toBe(false);
    expect(at(54).exceedsMaxWeeks).toBe(true);
    const byDate = enumerateOccurrences(
      weekly(['FRI'], '2026-11-06T10:00:00+05:30', { type: 'on_date', date: '2028-01-01' }),
      52,
    );
    expect(byDate.exceedsMaxWeeks).toBe(true);
  });
});

describe('S9 `k` fields (§10.6 table)', () => {
  const getK = async (o: KOpts, end = 'for 4 payments') => {
    const { ctx, payment } = kSetup(withEnd(o, end));
    let result = await run(ctx, [payment]);
    if (result.kind === 'question' && result.question.code === 'Q_AUTOPAY_MONTHLY') {
      result = (await answerAndReenter(ctx, result.question, chip('four_weeks'))).next!;
    }
    expect(result).toEqual({ kind: 'continue' });
    expectValidPlan(ctx);
    const plan = planOf(ctx);
    return { ctx, k: asK(plan[plan.length - 1]) };
  };

  it('C-327 C-224 §10.6 frequency null → Q_AUTOPAY_FREQUENCY with chips Daily, Weekly, Monthly; no DB1 mint yet', async () => {
    const { ctx, payment } = kSetup(withEnd({ frequency: null, days_of_week: null }));
    const before = db1Count(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_FREQUENCY');
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['daily', 'Daily'],
      ['weekly', 'Weekly'],
      ['monthly', 'Monthly'],
    ]);
    expect(db1Count(ctx)).toBe(before);
    expect(ctx.req.plan).toBeUndefined();
  });

  it('C-224 §10.6 Q_AUTOPAY_FREQUENCY answer survives re-entry through step_state: weekly → THU schedule', async () => {
    const { ctx, payment } = kSetup(withEnd({ frequency: null, days_of_week: null }));
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_FREQUENCY');
    const { answer, next } = await answerAndReenter(ctx, q, chip('weekly'));
    expect(answer).toEqual({ kind: 'continue' });
    expect(next).toEqual({ kind: 'continue' });
    expectValidPlan(ctx);
    expect(asK(planOf(ctx)[0]).display.schedule).toMatchObject({ frequency: 'weekly', days_of_week: ['THU'] });
    expect(ctx.req.step_state.s9).toBeUndefined();
  });

  it('C-224 §10.6 Q_AUTOPAY_FREQUENCY invalid answer → re-ask (same code, attempt + 1, same chips)', async () => {
    const { ctx, payment } = kSetup(withEnd({ frequency: null, days_of_week: null }));
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_FREQUENCY');
    const { answer } = await answerAndReenter(ctx, q, text('banana'));
    const q2 = expectQuestion(answer, 'Q_AUTOPAY_FREQUENCY');
    expect(q2.attempt).toBe(q.attempt + 1);
    expect(q2.chips).toEqual(q.chips);
    expect(q2.question_id).not.toBe(q.question_id);
  });

  it.each(['daily', 'weekly'] as const)('C-224 §10.6 Q_AUTOPAY_FREQUENCY chip %s is accepted', async (f) => {
    const { ctx, payment } = kSetup(withEnd({ frequency: null, days_of_week: null }));
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_FREQUENCY');
    const { next } = await answerAndReenter(ctx, q, chip(f));
    expect(next).toEqual({ kind: 'continue' });
    expect(asK(planOf(ctx)[0]).display.schedule.frequency).toBe(f);
  });

  it('C-224 §10.6 times_per_week = 7 → daily without a question (also over a weekly/null frequency)', async () => {
    for (const frequency of [null, 'weekly'] as const) {
      const { k } = await getK({ frequency, days_of_week: null, times_per_week: 7 });
      expect(k.display.schedule).toMatchObject({ frequency: 'daily', days_of_week: null });
      expect(k.schedule.interval_seconds).toBe(86400);
    }
  });

  it('C-225 §10.6 interval null → 1; interval from S8 is kept', async () => {
    expect((await getK({})).k.display.schedule.interval).toBe(1);
    const { k } = await getK({ frequency: 'daily', days_of_week: null, interval: 2 });
    expect(k.display.schedule.interval).toBe(2);
    expect(k.schedule.interval_seconds).toBe(172800);
  });

  it('C-226 §10.6 days the user named win over times_per_week', async () => {
    const { k } = await getK({ days_of_week: ['TUE'], times_per_week: 3 });
    expect(k.display.schedule.days_of_week).toEqual(['TUE']);
  });

  it('C-226 §10.6 named days are stored in week order', async () => {
    const { k } = await getK({ days_of_week: ['FRI', 'MON'] });
    expect(k.display.schedule.days_of_week).toEqual(['MON', 'FRI']);
  });

  it.each([
    [1, ['THU']],
    [2, ['MON', 'THU']],
    [3, ['MON', 'WED', 'FRI']],
    [4, ['MON', 'TUE', 'THU', 'FRI']],
    [5, ['MON', 'TUE', 'WED', 'THU', 'FRI']],
    [6, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']],
  ] as Array<[number, Weekday[]]>)('C-226 §10.6 weekly with times_per_week %i → %j', async (n, days) => {
    const { k } = await getK({ days_of_week: null, times_per_week: n });
    expect(k.display.schedule.days_of_week).toEqual(days);
  });

  it('C-226 §10.6 weekly with no days and no times_per_week → today’s weekday (Thursday)', async () => {
    const { k } = await getK({ days_of_week: null });
    expect(k.display.schedule.days_of_week).toEqual(['THU']);
  });

  it.each([15, 28, 29, 30, 31])('monthly day %i requires an explicit fixed-interval choice', async (day) => {
    const { ctx, payment } = kSetup(withEnd({ frequency: 'monthly', days_of_week: null, day_of_month: day }));
    const before = db1Count(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_MONTHLY');
    expect(q.chips.map((c) => c.label)).toEqual(['Every 4 weeks', 'Every 30 days']);
    expect(db1Count(ctx)).toBe(before);
    const invalid = await answerAndReenter(ctx, q, text('keep the 31st'));
    expect(expectQuestion(invalid.answer, 'Q_AUTOPAY_MONTHLY').attempt).toBe(2);
    expect((await answerAndReenter(ctx, q, chip('thirty_days'))).next).toEqual({ kind: 'continue' });
    const k = asK(planOf(ctx)[0]);
    expect(k.schedule).toMatchObject({ interval_seconds: 2592000, max_runs: 4 });
    expect(k.display.schedule.day_of_month).toBeNull();
    expect(ctx.req.notes).not.toContain('Paid on the 28th, since months differ in length.');
  });

  it('C-228 §10.6 time_of_day: chrono time in the clause, else defaults.autopay_time_of_day', async () => {
    const a = (await getK({ chrono: [{ kind: 'time', time: '18:30' }] })).k;
    expect(a.display.schedule.time_of_day).toBe('18:30');
    expect(a.schedule.start_at * 1000).toBe(ms('2026-11-06T18:30:00+05:30'));
    expect((await getK({})).k.display.schedule.time_of_day).toBe('10:00');
  });

  it('C-229 §10.6 timezone = session timezone (schedule and cre_job)', async () => {
    const { k } = await getK({ timezone: NY, now: '2026-11-05T12:00:00Z' });
    expect(k.display.schedule.timezone).toBe(NY);
    expect(k.schedule.start_at * 1000).toBe(ms('2026-11-06T10:00:00-05:00'));
  });

  it('C-230 §10.6 start_date: chrono start date in the clause (daily and weekly), else today', async () => {
    const d = (await getK({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'start', date: '2026-11-10' }] }))
      .k;
    expect(d.display.schedule.start_date).toBe('2026-11-10');
    expect(ms(d.display.schedule.first_occurrence)).toBe(ms('2026-11-10T10:00:00+05:30'));
    const w = (await getK({ chrono: [{ kind: 'start', date: '2026-11-10' }] })).k;
    expect(ms(w.display.schedule.first_occurrence)).toBe(ms('2026-11-13T10:00:00+05:30'));
    expect((await getK({})).k.display.schedule.start_date).toBe('2026-11-05');
  });

  it('C-230 §10.6 first occurrence is strictly after now: 10:00 already passed today → tomorrow', async () => {
    const { k } = await getK({ frequency: 'daily', days_of_week: null });
    expect(ms(k.display.schedule.first_occurrence)).toBe(ms('2026-11-06T10:00:00+05:30'));
  });

  it('C-230 §10.6 first occurrence today when the time is still ahead (now 08:00 IST)', async () => {
    const { k } = await getK({ frequency: 'daily', days_of_week: null, now: '2026-11-05T02:30:00Z' });
    expect(ms(k.display.schedule.first_occurrence)).toBe(ms('2026-11-05T10:00:00+05:30'));
  });

  it('C-230 §10.6 chrono time 23:30 today (after now 23:00) → today; exactly 23:00 → tomorrow', async () => {
    const a = (await getK({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'time', time: '23:30' }] })).k;
    expect(ms(a.display.schedule.first_occurrence)).toBe(ms('2026-11-05T23:30:00+05:30'));
    const b = (await getK({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'time', time: '23:00' }] })).k;
    expect(ms(b.display.schedule.first_occurrence)).toBe(ms('2026-11-06T23:00:00+05:30'));
  });

  it('C-328 C-230 §10.6 start date in the past → Q_AUTOPAY_START (date input); a future answer is used', async () => {
    const { ctx, payment } = kSetup(withEnd({ chrono: [{ kind: 'start', date: '2026-11-01' }] }));
    const before = db1Count(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_START');
    expect(db1Count(ctx)).toBe(before);
    const { next } = await answerAndReenter(ctx, q, text('2026-11-10'));
    expect(next).toEqual({ kind: 'continue' });
    const k = asK(planOf(ctx)[0]);
    expect(k.display.schedule.start_date).toBe('2026-11-10');
    expect(ms(k.display.schedule.first_occurrence)).toBe(ms('2026-11-13T10:00:00+05:30'));
  });

  it('C-335 C-230 §10.6 Q_AUTOPAY_START: "tomorrow" is parsed relative to now in the session timezone; today is accepted', async () => {
    const { ctx, payment } = kSetup(
      withEnd({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'start', date: '2026-11-01' }] }),
    );
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_START');
    await answerAndReenter(ctx, q, text('tomorrow'));
    expect(asK(planOf(ctx)[0]).display.schedule.start_date).toBe('2026-11-06');
    const s2 = kSetup(
      withEnd({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'start', date: '2026-11-01' }] }),
    );
    const q2 = expectQuestion(await run(s2.ctx, [s2.payment]), 'Q_AUTOPAY_START');
    await answerAndReenter(s2.ctx, q2, text('2026-11-05'));
    expect(asK(planOf(s2.ctx)[0]).display.schedule.start_date).toBe('2026-11-05');
  });

  it('C-230 §10.6 Q_AUTOPAY_START: a past or unparseable answer re-asks (attempt + 1)', async () => {
    const { ctx, payment } = kSetup(withEnd({ chrono: [{ kind: 'start', date: '2026-11-01' }] }));
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_START');
    for (const bad of ['2026-11-02', 'whenever']) {
      const { answer } = await answerAndReenter(ctx, q, text(bad));
      expect(expectQuestion(answer, 'Q_AUTOPAY_START').attempt).toBe(q.attempt + 1);
    }
  });

  it.each([
    ['for 5 payments', { type: 'after_count', count: 5 }],
    ['for 5 times', { type: 'after_count', count: 5 }],
    ['for five payments', { type: 'after_count', count: 5 }],
    ['for 2 weeks', { type: 'on_date', date: '2026-11-19' }],
    ['for 3 months', { type: 'on_date', date: '2027-02-05' }],
    ['until I cancel', { type: 'until_cancelled' }],
    ['forever', { type: 'until_cancelled' }],
    ['indefinitely', { type: 'until_cancelled' }],
    ['ongoing', { type: 'until_cancelled' }],
  ])('C-231 §10.6 end "%s" (weekly Friday, first 2026-11-06)', async (phrase, end) => {
    const { k } = await getK({}, phrase);
    expect(k.display.schedule.end).toEqual(end);
  });

  it('C-231 §10.6 end "for 10 days" (daily, first 2026-11-06) → on_date 2026-11-15', async () => {
    const { k } = await getK({ frequency: 'daily', days_of_week: null }, 'for 10 days');
    expect(k.display.schedule.end).toEqual({ type: 'on_date', date: '2026-11-15' });
  });

  it('C-231 §10.6 end "until <date>" from chrono → on_date', async () => {
    const { k } = await getK({ chrono: [{ kind: 'end', date: '2026-12-01' }] }, 'until dec 1');
    expect(k.display.schedule.end).toEqual({ type: 'on_date', date: '2026-12-01' });
  });

  it('C-329 C-231 §10.6 nothing stated → Q_AUTOPAY_END with chips After a number of payments / Until a date / Until I cancel', async () => {
    const { ctx, payment } = kSetup();
    const before = db1Count(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    expect(q.chips.map((c) => c.label)).toEqual(['After a number of payments', 'Until a date', 'Until I cancel']);
    expect(db1Count(ctx)).toBe(before);
  });

  it('C-330 C-231 §13.4 Q_AUTOPAY_END → "After a number of payments" → Q_AUTOPAY_COUNT; 1–520 whole numbers only', async () => {
    const { ctx, payment } = kSetup();
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    const { answer } = await answerAndReenter(ctx, q, chip(q.chips[0]?.id ?? ''));
    const qc = expectQuestion(answer, 'Q_AUTOPAY_COUNT');
    for (const bad of ['0', '521', 'abc', '-3']) {
      const r = await answerAndReenter(ctx, qc, text(bad));
      expect(expectQuestion(r.answer, 'Q_AUTOPAY_COUNT').attempt).toBe(qc.attempt + 1);
    }
    const ok = await answerAndReenter(ctx, qc, text('5'));
    expect(ok.next).toEqual({ kind: 'continue' });
    expect(asK(planOf(ctx)[0]).display.schedule.end).toEqual({ type: 'after_count', count: 5 });
  });

  it('SQ-D-16 F-5 content amount: C-231 §13.4 Q_AUTOPAY_COUNT 520 is accepted by the question but exceeds the duration limit → LIMIT_AUTOPAY_DURATION', async () => {
    const { ctx, payment } = kSetup();
    markContent(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    const qc = expectQuestion((await answerAndReenter(ctx, q, chip(q.chips[0]?.id ?? ''))).answer, 'Q_AUTOPAY_COUNT');
    const r = await answerAndReenter(ctx, qc, text('520'));
    expectError(r.next as never, 'LIMIT_AUTOPAY_DURATION', { weeks: '52' });
  });

  it('C-331 C-231 §13.4 Q_AUTOPAY_END → "Until a date" → Q_AUTOPAY_DATE: must be after the first occurrence date', async () => {
    const { ctx, payment } = kSetup();
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    const { answer } = await answerAndReenter(ctx, q, chip(q.chips[1]?.id ?? ''));
    const qd = expectQuestion(answer, 'Q_AUTOPAY_DATE');
    for (const bad of ['2026-11-06', '2026-11-05', 'later']) {
      const r = await answerAndReenter(ctx, qd, text(bad));
      expect(expectQuestion(r.answer, 'Q_AUTOPAY_DATE').attempt).toBe(qd.attempt + 1);
    }
    const ok = await answerAndReenter(ctx, qd, text('2026-11-20'));
    expect(ok.next).toEqual({ kind: 'continue' });
    expect(asK(planOf(ctx)[0]).display.schedule.end).toEqual({ type: 'on_date', date: '2026-11-20' });
  });

  it('C-231 §13.4 Q_AUTOPAY_END → "Until I cancel" → until_cancelled', async () => {
    const { ctx, payment } = kSetup();
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    const r = await answerAndReenter(ctx, q, chip(q.chips[2]?.id ?? ''));
    expect(r.next).toEqual({ kind: 'continue' });
    expect(asK(planOf(ctx)[0]).display.schedule.end).toEqual({ type: 'until_cancelled' });
  });

  it('C-231 §9.7 Q_AUTOPAY_END: an unknown chip re-asks', async () => {
    const { ctx, payment } = kSetup();
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_END');
    const r = await answerAndReenter(ctx, q, chip('bogus'));
    expect(expectQuestion(r.answer, 'Q_AUTOPAY_END').attempt).toBe(q.attempt + 1);
  });

  it('C-231 §10.6 two `k` payments: answers are kept per payment across re-entries', async () => {
    const { ctx, payment, recipient } = kSetup(withEnd({ frequency: null, days_of_week: null }));
    const second = pay(ctx, 'k', addAmount(ctx, '5', { clause: 0 }), recipient, 'unstated', {
      frequency: null,
      interval: null,
      times_per_week: null,
      days_of_week: null,
      day_of_month: null,
    });
    const q1 = expectQuestion(await run(ctx, [payment, second]), 'Q_AUTOPAY_FREQUENCY');
    const r1 = await answerAndReenter(ctx, q1, chip('weekly'));
    const q2 = expectQuestion(r1.next as never, 'Q_AUTOPAY_FREQUENCY');
    const r2 = await answerAndReenter(ctx, q2, chip('daily'));
    expect(r2.next).toEqual({ kind: 'continue' });
    const plan = planOf(ctx);
    expect(plan.map((p) => asK(p).display.schedule.frequency)).toEqual(['weekly', 'daily']);
    expect(plan.map((p) => p.step)).toEqual([0, 1]);
    expect(ctx.req.step_state.s9).toBeUndefined();
  });

  it('C-233 §10.6 derived 2: end date before the first occurrence → AUTOPAY_NO_OCCURRENCES', async () => {
    const { ctx, payment } = kSetup(
      withEnd({ frequency: 'daily', days_of_week: null, chrono: [{ kind: 'end', date: '2026-11-05' }] }, 'until nov 5'),
    );
    expectError(await run(ctx, [payment]), 'AUTOPAY_NO_OCCURRENCES');
  });

  it('SQ-D-16 F-5 content amount: C-234 §10.6 derived 3: "for 60 weeks" → LIMIT_AUTOPAY_DURATION {weeks: 52}; no DB1 mint', async () => {
    const { ctx, payment } = kSetup(withEnd({}, 'for 60 weeks'));
    markContent(ctx);
    const before = db1Count(ctx);
    expectError(await run(ctx, [payment]), 'LIMIT_AUTOPAY_DURATION', { weeks: '52' });
    expect(db1Count(ctx)).toBe(before);
    expect(ctx.req.plan).toBeUndefined();
  });

  it('SQ-D-16 F-5 content amount: C-234 §10.6 derived 3: 53 weekly payments end exactly on first + 52 weeks → allowed; 54 → LIMIT_AUTOPAY_DURATION', async () => {
    const ok = kSetup(withEnd({ balances: usdc('0', '5000', '0') }, 'for 53 payments'));
    expect(asK((await runOk(ok.ctx, [ok.payment]))[0]).display.schedule.end).toEqual({
      type: 'after_count',
      count: 53,
    });
    const bad = kSetup(withEnd({ balances: usdc('0', '5000', '0') }, 'for 54 payments'));
    markContent(bad.ctx);
    expectError(await run(bad.ctx, [bad.payment]), 'LIMIT_AUTOPAY_DURATION');
  });

  it('C-232 C-234 §10.6 until_cancelled enumerates occurrences before first + 52 weeks: 52 Fridays, total_cap 520', async () => {
    const { ctx, k } = await getK({ balances: usdc('0', '1000', '0') }, 'until I cancel');
    expect(amountOf(ctx, k.limits.max_total)).toBe('522.6');
    expect(k.schedule.end_at * 1000).toBe(ms('2027-10-29T05:30:00Z')); // first Fri 2026-11-06 + 51 weeks
  });

  it.each([
    ['weekly ×3 days', { times_per_week: 3, days_of_week: null }, '10', '30'],
    ['daily', { frequency: 'daily' as const, days_of_week: null }, '10', '40'],
    ['daily every 2', { frequency: 'daily' as const, days_of_week: null, interval: 2 }, '10', '40'],
    ['monthly', { frequency: 'monthly' as const, days_of_week: null, day_of_month: 10 }, '10', '10'],
  ])(
    'C-235 §10.6 derived 4: SQ-R-03 per_period_cap %s = amount × max scheduled payments in 7 days',
    async (_n, o, amount, cap) => {
      const { ctx, k } = await getK({ ...o, amount });
      expect(amountOf(ctx, k.display.per_period_cap)).toBe(cap);
    },
  );

  it('SQ-D-16 F-5 content amount: C-235 §10.6 derived 4: per_period_cap above autopay_max_per_period → LIMIT_AUTOPAY_PERIOD {cap, token, max}', async () => {
    const { ctx, payment } = kSetup(
      withEnd({ frequency: 'daily', days_of_week: null, amount: '20' }, 'for 7 payments'),
    );
    markContent(ctx);
    const before = db1Count(ctx);
    expectError(await run(ctx, [payment]), 'LIMIT_AUTOPAY_PERIOD', { cap: '140', token: 'USDC', max: '100' });
    expect(db1Count(ctx)).toBe(before);
  });

  it('SQ-D-16 F-5 content amount: C-236 §10.6 derived 5: amount_per_payment > per_tx_max → LIMIT_PER_TX', async () => {
    const { ctx, payment } = kSetup(withEnd({}));
    setLimits(ctx, { per_tx_max: { USDC: '5', ETH: '0.05' } });
    markContent(ctx);
    expectError(await run(ctx, [payment]), 'LIMIT_PER_TX', { amount: '10', token: 'USDC', max: '5' });
  });

  it('C-236 §10.6 derived 5: amount equal to per_tx_max is allowed', async () => {
    const { ctx, payment } = kSetup(withEnd({}));
    setLimits(ctx, { per_tx_max: { USDC: '10', ETH: '0.05' } });
    await runOk(ctx, [payment]);
  });

  it('C-237 C-205 §10.6 derived 6 + §10.2: total_cap = amount × occurrences is the prefund need used for the chain choice', async () => {
    // total 40 (4 × 10): Base has 30, Arbitrum 45 → Arbitrum is the only Mihir chain that can prefund 40
    const { ctx, payment } = kSetup(withEnd({ balances: usdc('0', '30', '45') }));
    const plan = await runOk(ctx, [payment]);
    expect(plan).toHaveLength(1);
    const k = asK(plan[0]);
    expect(k.chain_id).toBe(ARB);
    expect(amountOf(ctx, k.limits.max_total)).toBe('40.2');
  });

  it('C-205 C-237 §10.2 §10.4 the prefund (total_cap) is bridged when no chain can fund it; k depends on the bridge', async () => {
    const { ctx, payment } = kSetup(withEnd({ balances: usdc('0', '25', '30') }, 'for 4 payments'));
    // need 40: nothing ≥ 40; target Arbitrum (30, largest) short 10; Base surplus 25
    const plan = await runOk(ctx, [payment]);
    expect(plan.map((p) => p.intent_id)).toEqual(['j', 'k']);
    expect(asJ(plan[0])).toMatchObject({ source_chain_id: BASE, dest_chain_id: ARB, funds_steps: [1] });
    expect(amountOf(ctx, asJ(plan[0]).amount)).toBe('10.2');
    expect(asK(plan[1]).depends_on).toEqual([0]);
  });

  it('C-237 C-214 §10.4 prefund 80 with 30 + 50 spendable cannot be bridged with the 2% pad → INSUFFICIENT_FUNDS {need 80.6, have 80}', async () => {
    const { ctx, payment } = kSetup(withEnd({ balances: usdc('0', '30', '50') }, 'for 8 payments'));
    expectError(await run(ctx, [payment]), 'INSUFFICIENT_FUNDS', { token: 'USDC', need: '80.4', have: '80' });
  });

  it('C-238 §10.6 derived 7: both caps are minted in DB1 (source derived, origins, confirmed, token)', async () => {
    const { ctx, k } = await getK({ times_per_week: 3, days_of_week: null });
    expect(ctx.repos.db1.get(k.display.per_period_cap)).toMatchObject({
      amount: '30',
      token: 'USDC',
      source: 'derived',
      origin: 'autopay_per_period_cap',
      confirmed: true,
    });
    expect(ctx.repos.db1.get(k.limits.max_total)).toMatchObject({
      amount: '20.1',
      token: 'USDC',
      source: 'derived',
      origin: 'autopay_max_total',
      confirmed: true,
    });
  });

  it('C-239 §10.6 derived 8: expires_at is 23:59:59 on the last occurrence date in the session timezone (DST case)', async () => {
    const { k } = await getK(
      { timezone: NY, now: '2026-10-30T12:00:00Z', frequency: 'daily', days_of_week: null, interval: 2 },
      'for 4 payments',
    );
    expect(ms(k.display.schedule.first_occurrence)).toBe(ms('2026-10-30T10:00:00-04:00'));
    expect(k.schedule.end_at * 1000).toBe(ms('2026-11-05T15:00:00Z')); // 2026-11-05 23:59:59 EST
    expect(k.schedule.interval_seconds).toBe(172800);
    expect(k.executor).toBe('chainlink-cre');
  });

  it.each([
    [{}, 604800, 1],
    [{ times_per_week: 3, days_of_week: null }, 604800, 3],
    [{ days_of_week: ['SUN'] as Weekday[] }, 604800, 1],
    [{ frequency: 'daily' as const, days_of_week: null }, 86400, 1],
    [{ frequency: 'monthly' as const, days_of_week: null }, 2419200, 1],
  ])('fixed schedules for %j use %i seconds across %i legs', async (o, seconds, count) => {
    const { ctx } = await getK(o);
    const legs = planOf(ctx).map(asK);
    expect(legs).toHaveLength(count);
    for (const k of legs) {
      expect(k.schedule.interval_seconds).toBe(seconds);
      expect(k.executor).toBe('chainlink-cre');
      expect(k).not.toHaveProperty('cre_job');
    }
  });

  it('C-241 §10.6 derived 10: autopay_id = ap_<12hex>, unique per k', async () => {
    const { ctx, payment, recipient } = kSetup(withEnd({}));
    const second = pay(ctx, 'k', addAmount(ctx, '5', { clause: 0 }), recipient, 'unstated', {
      frequency: 'daily',
      days_of_week: null,
    });
    const plan = await runOk(ctx, [payment, second]);
    const ids = plan.map((p) => asK(p).autopay_id);
    for (const id of ids) expect(id).toMatch(/^ap_[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(2);
  });

  it('C-224 C-231 §10.6 questions never leak DB1 mints (Q_AUTOPAY_FREQUENCY, _START, _END, _COUNT, _DATE)', async () => {
    const { ctx, payment } = kSetup({
      frequency: null,
      days_of_week: null,
      chrono: [{ kind: 'start', date: '2026-11-01' }],
    });
    const before = db1Count(ctx);
    let q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_FREQUENCY');
    expect(db1Count(ctx)).toBe(before);
    let r = await answerAndReenter(ctx, q, chip('weekly'));
    q = expectQuestion(r.next as never, 'Q_AUTOPAY_START');
    expect(db1Count(ctx)).toBe(before);
    r = await answerAndReenter(ctx, q, text('2026-11-10'));
    q = expectQuestion(r.next as never, 'Q_AUTOPAY_END');
    expect(db1Count(ctx)).toBe(before);
    r = await answerAndReenter(ctx, q, chip('end_count'));
    q = expectQuestion(r.answer, 'Q_AUTOPAY_COUNT');
    expect(db1Count(ctx)).toBe(before);
    r = await answerAndReenter(ctx, q, text('3'));
    expect(r.next).toEqual({ kind: 'continue' });
    expect(db1Count(ctx)).toBe(before + 4); // fee, max_per_run, max_total and the private per-period cap, only in the final phase
  });
});

describe('S9 cancel `l` (§10.7)', () => {
  const lSetup = () => {
    const ctx = ctxD({ actions: ['l'], balances: usdc('0', '10', '10') });
    const mi = addMihir(ctx);
    return { ctx, mi, payment: pay(ctx, 'l', null, mi) };
  };

  it('C-206 C-242 C-245 §10.7 one active autopay → l with autopay_id, chain_id, delegate_address from DB7; refund_remaining true', async () => {
    const { ctx, mi, payment } = lSetup();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', chain_id: ARB, delegate: ALICE_CS });
    const plan = await runOk(ctx, [payment]);
    expect(plan).toEqual([
      {
        intent_id: 'l',
        step: 0,
        autopay_id: 'ap_0000000000f7',
        chain_id: ARB,
        plan_id: planIdFor('ap_0000000000f7'),
        recipient: mi,
      },
    ]);
  });

  it('C-242 §10.7 only autopays of this recipient address are considered', async () => {
    const { ctx, payment } = lSetup();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', address: ALICE_CS, name: 'Alice' });
    expectError(await run(ctx, [payment]), 'NO_ACTIVE_AUTOPAY', { name: 'Mihir' });
  });

  it('C-243 §10.7 only a pending autopay → AUTOPAY_NOT_READY', async () => {
    const { ctx, payment } = lSetup();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', status: 'pending' });
    const msg = expectError(await run(ctx, [payment]), 'AUTOPAY_NOT_READY');
    // §10.7 says "That autopay …", §15 says "That repeating payment …"; the catalog follows §15
    expect(msg).toMatch(/^That (autopay|repeating payment) is still being set up\. Try again shortly\.$/);
  });

  it('C-243 §10.7 an active autopay wins over a pending one (no error)', async () => {
    const { ctx, payment } = lSetup();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7', status: 'pending' });
    addAutopay(ctx, { autopay_id: 'ap_0000000000a1' });
    const plan = await runOk(ctx, [payment]);
    expect(asL(plan[0]).autopay_id).toBe('ap_0000000000a1');
  });

  it('C-243 §10.7 none at all, or only cancelled → NO_ACTIVE_AUTOPAY {name}', async () => {
    const a = lSetup();
    expectError(await run(a.ctx, [a.payment]), 'NO_ACTIVE_AUTOPAY', { name: 'Mihir' });
    const b = lSetup();
    addAutopay(b.ctx, { autopay_id: 'ap_0000000000f7', status: 'cancelled' });
    expectError(await run(b.ctx, [b.payment]), 'NO_ACTIVE_AUTOPAY', { name: 'Mihir' });
  });

  function two(ctx: ReturnType<typeof lSetup>['ctx']): void {
    addAutopay(ctx, {
      autopay_id: 'ap_0000000000f7',
      schedule: weekly(['MON'], '2026-11-10T10:00:00.000+05:30', { type: 'until_cancelled' }),
    });
    addAutopay(ctx, {
      autopay_id: 'ap_0000000000a1',
      chain_id: ARB,
      amount: '20',
      delegate: ALICE_CS,
      schedule: sched('daily', '2026-11-12T10:00:00.000+05:30', { type: 'until_cancelled' }),
    });
  }

  it('C-332 C-244 §10.7 several active → Q_AUTOPAY_PICK with chips like "10 USDC weekly on MON, Base Sepolia, since 2026-11-10"', async () => {
    const { ctx, payment } = lSetup();
    two(ctx);
    const before = db1Count(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_PICK');
    expect(q.chips.map((c) => [c.id, c.label])).toEqual([
      ['ap_0000000000f7', '10 USDC weekly on MON, Base Sepolia, since 2026-11-10'],
      ['ap_0000000000a1', '20 USDC daily, Arbitrum Sepolia, since 2026-11-12'],
    ]);
    expect(db1Count(ctx)).toBe(before);
  });

  it('C-244 C-245 §10.7 the picked chip selects the autopay; its DB7 fields are used', async () => {
    const { ctx, payment } = lSetup();
    two(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_PICK');
    const r = await answerAndReenter(ctx, q, chip('ap_0000000000a1'));
    expect(r.next).toEqual({ kind: 'continue' });
    expectValidPlan(ctx);
    expect(asL(planOf(ctx)[0])).toMatchObject({
      autopay_id: 'ap_0000000000a1',
      chain_id: ARB,
      plan_id: planIdFor('ap_0000000000a1'),
    });
  });

  it('C-244 §9.7 Q_AUTOPAY_PICK invalid answer → re-ask with attempt + 1 and the same chips', async () => {
    const { ctx, payment } = lSetup();
    two(ctx);
    const q = expectQuestion(await run(ctx, [payment]), 'Q_AUTOPAY_PICK');
    const r = await answerAndReenter(ctx, q, text('banana'));
    const q2 = expectQuestion(r.answer, 'Q_AUTOPAY_PICK');
    expect(q2.attempt).toBe(q.attempt + 1);
    expect(q2.chips).toEqual(q.chips);
  });

  it('C-217 C-245 §10.4 gas check covers the chain of an l intent → NO_GAS', async () => {
    const ctx = ctxD({ actions: ['l'], balances: { [BASE]: { ETH: '0.001' } } });
    const mi = addMihir(ctx);
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    expectError(await run(ctx, [pay(ctx, 'l', null, mi)]), 'NO_GAS', { chain: 'Base Sepolia', reserve: '0.002' });
  });

  it('C-223 C-245 §10.7 an l intent needs no funds: no bridges and no DB1 mints', async () => {
    const { ctx, payment } = lSetup();
    addAutopay(ctx, { autopay_id: 'ap_0000000000f7' });
    const before = db1Count(ctx);
    const plan = await runOk(ctx, [payment]);
    expect(plan.map((p) => p.intent_id)).toEqual(['l']);
    expect(db1Count(ctx)).toBe(before);
    expect(asL(plan[0]).plan_id).toBe(planIdFor(asL(plan[0]).autopay_id));
    expect(NOW_E6).toBeTruthy();
  });
});

/** SQ-D-16 F-5: an amount from attached content in the request keeps the limit errors at S9 (typed amounts are left to S10). */
function markContent(ctx: Parameters<typeof addAmount>[0]): void {
  addAmount(ctx, '1', { source: 'untrusted' });
}

describe('SQ-D-16 F-5 typed amounts: S9 lets the limit through (S10 asks)', () => {
  it('SQ-D-16 F-3 S9 a 60-week repeating payment from typed amounts passes S9 (S10 asks about the 52-week limit)', async () => {
    const { ctx, payment } = kSetup(withEnd({}, 'for 60 weeks'));
    const plan = await runOk(ctx, [payment]);
    expect(plan.map((p) => p.intent_id)).toEqual(['k']);
  });

  it('SQ-D-16 F-3 S9 a per-period cap over the autopay limit passes S9 for typed amounts', async () => {
    const { ctx, payment } = kSetup(
      withEnd({ frequency: 'daily', days_of_week: null, amount: '20' }, 'for 7 payments'),
    );
    const plan = await runOk(ctx, [payment]);
    expect(plan.map((p) => p.intent_id)).toEqual(['k']);
  });

  it('SQ-D-16 F-1 S9 a repeating amount over per_tx_max passes S9 for typed amounts', async () => {
    const { ctx, payment } = kSetup(withEnd({}));
    setLimits(ctx, { per_tx_max: { USDC: '5', ETH: '0.05' } });
    const plan = await runOk(ctx, [payment]);
    expect(plan.map((p) => p.intent_id)).toEqual(['k']);
  });
});
