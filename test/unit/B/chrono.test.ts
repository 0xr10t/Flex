import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { chronoSpans } from '../../../src/lexical/chrono.js';

describe('schedule date parsing', () => {
  it.each([
    ['2026-01-15T15:00:00Z', 'July 1 2026 at 10am', '2026-07-01', '10:00'],
    ['2026-07-15T14:00:00Z', 'December 1 2026 at 00:30', '2026-12-01', '00:30'],
    ['2026-03-07T15:00:00Z', 'tomorrow at 10am', '2026-03-08', '10:00'],
    ['2026-10-31T14:00:00Z', 'tomorrow at 00:30', '2026-11-01', '00:30'],
  ])('B16: retains the local calendar fields in %s → %s', (clock, phrase, date, time) => {
    const now = DateTime.fromISO(clock, { zone: 'America/New_York' });
    const text = `starting ${phrase}`;
    const spans = chronoSpans(text, now);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: 'start', date, time });
    expect(text.slice(spans[0]!.start, spans[0]!.end)).toBe(spans[0]!.text);
  });

  it('B16: date-only inputs remain calendar dates without acquiring a time', () => {
    const now = DateTime.fromISO('2026-07-15T14:00:00Z', { zone: 'America/New_York' });
    expect(chronoSpans('starting December 1 2026', now)[0]).toMatchObject({
      kind: 'start',
      date: '2026-12-01',
      time: null,
    });
  });

  it('B16: an explicit input timezone still converts its instant to the session timezone', () => {
    const now = DateTime.fromISO('2026-01-15T15:00:00Z', { zone: 'America/New_York' });
    expect(chronoSpans('starting July 1 2026 at 00:30 UTC', now)[0]).toMatchObject({
      kind: 'start',
      date: '2026-06-30',
      time: '20:30',
    });
  });

  it('B16: relative dates use the session calendar day when UTC is on the previous day', () => {
    const now = DateTime.fromISO('2026-11-05T20:00:00Z', { zone: 'Asia/Kolkata' });
    expect(chronoSpans('starting tomorrow at 10am', now)[0]).toMatchObject({
      kind: 'start',
      date: '2026-11-07',
      time: '10:00',
    });
  });
});
