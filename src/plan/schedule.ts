// Implements: §10.6 autopay (`k`) schedule — field rules (frequency, interval, days_of_week incl. the times-per-week
// table, day_of_month 29–31 → 28, time_of_day, timezone, start_date, first occurrence, end forms) and derived values
// 1–9 (occurrences with luxon in the session timezone, zero occurrences, duration limit, per-period cap, total cap,
// expires_at, cron), §14.2 interval contract (weeks counted as 7-day blocks since the first occurrence).
// Pure functions; S9 (src/pipeline/s9-plan.ts) wires them to questions, DB1 and DB5.

import { DateTime } from 'luxon';
import type { Schedule as ExecutionSchedule } from '@flex/protocol';
import type { Frequency, ScheduleEnd, CalendarSchedule, Weekday } from '../contracts/types.js';

export const WEEKDAYS: readonly Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/** luxon weekday (1 = Monday … 7 = Sunday) → Weekday. */
export function weekdayOf(dt: DateTime): Weekday {
  return WEEKDAYS[dt.weekday - 1] as Weekday;
}

/** §10.6 times-per-week table (n = 1 → today's weekday). */
export function daysForTimesPerWeek(n: number, today: DateTime): Weekday[] {
  switch (n) {
    case 2:
      return ['MON', 'THU'];
    case 3:
      return ['MON', 'WED', 'FRI'];
    case 4:
      return ['MON', 'TUE', 'THU', 'FRI'];
    case 5:
      return ['MON', 'TUE', 'WED', 'THU', 'FRI'];
    case 6:
      return ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
    default:
      return [weekdayOf(today)];
  }
}

export function sortDays(days: Weekday[]): Weekday[] {
  return [...new Set(days)].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b));
}

/** §10.6 day_of_month: 29–31 → 28 (caller adds the "Paid on the 28th" note when clamped). */
export function clampDayOfMonth(d: number): { day: number; clamped: boolean } {
  return d > 28 ? { day: 28, clamped: true } : { day: d, clamped: false };
}

export interface ScheduleCore {
  frequency: Frequency;
  interval: number;
  days_of_week: Weekday[] | null;
  day_of_month: number | null;
  time_of_day: string;
  timezone: string;
  start_date: string;
}

function atTime(date: DateTime, time: string): DateTime {
  const [h = '0', m = '0'] = time.split(':');
  return date.set({ hour: Number(h), minute: Number(m), second: 0, millisecond: 0 });
}

function matchesDay(core: ScheduleCore, date: DateTime): boolean {
  if (core.frequency === 'daily') return true;
  if (core.frequency === 'weekly') return (core.days_of_week ?? []).includes(weekdayOf(date));
  return date.day === core.day_of_month;
}

/**
 * §10.6 start_date: "The first occurrence is the first scheduled date-time ≥ start_date that is strictly after now."
 */
export function firstOccurrence(core: ScheduleCore, now: DateTime): DateTime {
  let day = DateTime.fromISO(core.start_date, { zone: core.timezone }).startOf('day');
  const nowTz = now.setZone(core.timezone);
  for (let i = 0; i < 800; i++) {
    if (matchesDay(core, day)) {
      const at = atTime(day, core.time_of_day);
      if (at > nowTz) return at;
    }
    day = day.plus({ days: 1 });
  }
  throw new Error('no first occurrence found');
}

/** "for N weeks/months/days" → on_date = first occurrence date + N units − 1 day (§10.6 end). */
export function onDateForDuration(first: DateTime, n: number, unit: 'days' | 'weeks' | 'months'): string {
  return first
    .startOf('day')
    .plus({ [unit]: n })
    .minus({ days: 1 })
    .toISODate() as string;
}

export interface Occurrences {
  occurrences: DateTime[];
  /** Some occurrence lies after first occurrence + autopay_max_weeks weeks (§10.6 derived 3). */
  exceedsMaxWeeks: boolean;
}

/** Convert calendar input to the exact fixed UTC intervals enforced by the wallet and CRE. */
export function fixedSchedule(
  s: CalendarSchedule,
  maxWeeks: number,
  lateWindow: number,
): Occurrences & { legs: ExecutionSchedule[] } {
  if (s.frequency === 'monthly') throw new Error('monthly needs an explicit fixed-interval choice');
  const first = DateTime.fromISO(s.first_occurrence, { setZone: true }).setZone(s.timezone);
  const interval = s.interval * (s.frequency === 'daily' ? 86400 : 604800);
  if (lateWindow < 60 || lateWindow > interval) throw new Error('late window exceeds interval');
  const starts =
    s.frequency === 'daily'
      ? [first]
      : (s.days_of_week ?? []).map((day) => {
          const delta = (WEEKDAYS.indexOf(day) - first.weekday + 8) % 7;
          return first.plus({ days: delta });
        });
  const counts = starts.map(() => 0);
  const occurrences: DateTime[] = [];
  const limit = first.toSeconds() + maxWeeks * 604800;
  const endDate =
    s.end.type === 'on_date' ? DateTime.fromISO(s.end.date, { zone: s.timezone }).endOf('day').toSeconds() : Infinity;
  let exceedsMaxWeeks = false;
  while (starts.length > 0) {
    if (s.end.type === 'after_count' && occurrences.length >= s.end.count) break;
    const candidates = starts.map((start, i) => start.toSeconds() + (counts[i] ?? 0) * interval);
    const next = Math.min(...candidates);
    if (next > endDate) break;
    if (s.end.type === 'until_cancelled' ? next >= limit : next > limit) {
      exceedsMaxWeeks = s.end.type !== 'until_cancelled';
      break;
    }
    const index = candidates.indexOf(next);
    counts[index] = (counts[index] ?? 0) + 1;
    occurrences.push(DateTime.fromSeconds(next, { zone: s.timezone }));
  }
  const legs = starts.flatMap((start, i): ExecutionSchedule[] => {
    const max_runs = counts[i] ?? 0;
    if (max_runs === 0) return [];
    const start_at = Math.floor(start.toSeconds());
    return [
      {
        start_at,
        interval_seconds: interval,
        max_runs,
        late_window_seconds: lateWindow,
        end_at: start_at + interval * (max_runs - 1) + lateWindow,
      },
    ];
  });
  return { legs, occurrences, exceedsMaxWeeks };
}

/** §10.6 derived 1: enumerate occurrences honouring `interval` counted from the first occurrence. */
export function enumerateOccurrences(s: CalendarSchedule, maxWeeks: number): Occurrences {
  const first = DateTime.fromISO(s.first_occurrence, { setZone: true }).setZone(s.timezone);
  const limit = first.plus({ weeks: maxWeeks });
  const out: DateTime[] = [];
  const end: ScheduleEnd = s.end;
  const endDate = end.type === 'on_date' ? DateTime.fromISO(end.date, { zone: s.timezone }).endOf('day') : null;
  const done = (dt: DateTime): 'stop' | 'take' | 'exceed' => {
    if (end.type === 'after_count' && out.length >= end.count) return 'stop';
    if (endDate !== null && dt > endDate) return 'stop';
    if (end.type === 'until_cancelled') return dt < limit ? 'take' : 'stop';
    return dt > limit ? 'exceed' : 'take';
  };
  const candidates = function* (): Generator<DateTime> {
    if (s.frequency === 'daily') {
      for (let k = 0; ; k++) yield first.plus({ days: k * s.interval });
    } else if (s.frequency === 'monthly') {
      for (let k = 0; ; k++) yield first.plus({ months: k * s.interval });
    } else {
      const days = s.days_of_week ?? [];
      if (days.length === 0) return;
      for (let d = 0; ; d++) {
        const dt = first.plus({ days: d });
        if (Math.floor(d / 7) % s.interval === 0 && days.includes(weekdayOf(dt))) yield dt;
      }
    }
  };
  for (const dt of candidates()) {
    const r = done(dt);
    if (r === 'stop') return { occurrences: out, exceedsMaxWeeks: false };
    if (r === 'exceed') return { occurrences: out, exceedsMaxWeeks: true };
    out.push(dt);
  }
  return { occurrences: out, exceedsMaxWeeks: false };
}

/**
 * SQ-R-03: the most occurrences in any 7-day window [t, t + 7 days), counted on the wall clock of the occurrences'
 * zone (so a DST change never widens the window).
 */
export function mostInAnyWeek(occurrences: readonly DateTime[]): number {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < occurrences.length; hi++) {
    const t = occurrences[hi] as DateTime;
    while (lo < hi && (occurrences[lo] as DateTime).plus({ seconds: 604800 }) <= t) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

/** §10.6 derived 4: the most payments in any 7-day window. */
export function paymentsPerWeek(s: Pick<CalendarSchedule, 'frequency' | 'interval' | 'days_of_week'>): bigint {
  if (s.frequency === 'daily') return BigInt(Math.ceil(7 / s.interval));
  if (s.frequency === 'weekly') return BigInt((s.days_of_week ?? []).length);
  return 1n;
}

/** §10.6 derived 8: 23:59:59 on the last occurrence's date in the session timezone, as ISO-8601 UTC. */
export function expiresAt(last: DateTime, timezone: string): string {
  return last
    .setZone(timezone)
    .set({ hour: 23, minute: 59, second: 59, millisecond: 0 })
    .toUTC()
    .toISO({ suppressMilliseconds: true }) as string;
}

const CRON_DAY: Record<Weekday, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

/** §10.6 derived 9: weekly `M H * * D1,D2` (0 = SUN … 6 = SAT); daily `M H * * *`; monthly `M H DOM * *`. */
export function cronFor(
  s: Pick<CalendarSchedule, 'frequency' | 'days_of_week' | 'day_of_month' | 'time_of_day'>,
): string {
  const [h = '0', m = '0'] = s.time_of_day.split(':');
  const mh = `${Number(m)} ${Number(h)}`;
  if (s.frequency === 'daily') return `${mh} * * *`;
  if (s.frequency === 'monthly') return `${mh} ${s.day_of_month ?? 1} * *`;
  const days = (s.days_of_week ?? []).map((d) => CRON_DAY[d]).sort((a, b) => a - b);
  return `${mh} * * ${days.join(',')}`;
}

// ───────────────────────────── text extraction (§10.6 end phrases) ─────────────────────────────

export type ParsedEnd =
  ScheduleEnd | { type: 'for_units'; n: number; unit: 'days' | 'weeks' | 'months' } | { type: 'for_count'; n: number };

const NUM = '(\\d+|[a-z]+(?:[ -][a-z]+){0,4})';
const COUNT_RE = new RegExp(`\\bfor\\s+${NUM}\\s+(payments?|times)\\b`, 'gi');
const UNITS_RE = new RegExp(`\\bfor\\s+${NUM}\\s+(days?|weeks?|months?)\\b`, 'gi');
const UNTIL_CANCEL_RE = /\buntil\s+(?:i|you)\s+(?:cancel|stop)\b|\bforever\b|\bindefinitely\b|\bongoing\b/i;

/** Finds the first "for N …" phrase whose N parses as a positive integer. */
function findCount(re: RegExp, text: string, parseInt: (s: string) => number | null): RegExpExecArray | null {
  re.lastIndex = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1] !== undefined && parseInt(m[1]) !== null) return m;
    re.lastIndex = m.index + 1;
  }
  return null;
}

/**
 * §10.6 end from the payment's clause text: "for N payments/times" → after_count, "for N weeks/months/days" → duration,
 * "until I cancel/stop", "forever", "indefinitely", "ongoing" → until_cancelled. "until <date>" comes from chrono
 * (`untilDate`). Returns null when nothing is stated (→ Q_AUTOPAY_END).
 */
export function parseEnd(
  text: string,
  untilDate: string | null,
  parseInt: (s: string) => number | null,
): ParsedEnd | null {
  const c = findCount(COUNT_RE, text, parseInt);
  if (c?.[1] !== undefined) return { type: 'for_count', n: parseInt(c[1]) as number };
  const u = findCount(UNITS_RE, text, parseInt);
  if (u?.[1] !== undefined && u[2] !== undefined) {
    const w = u[2].toLowerCase();
    const unit = w.startsWith('day') ? 'days' : w.startsWith('week') ? 'weeks' : 'months';
    return { type: 'for_units', n: parseInt(u[1]) as number, unit };
  }
  if (untilDate !== null) return { type: 'on_date', date: untilDate };
  if (UNTIL_CANCEL_RE.test(text)) return { type: 'until_cancelled' };
  return null;
}
