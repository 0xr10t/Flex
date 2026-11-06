import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { chronoSpans } from '../../../src/lexical/chrono.js';

describe('schedule date parsing', () => {
  it.each([
    ['2026-01-15T15:00:00Z', 'July 1 2026 at 10am', '2026-07-01', '10:00'],
    ['2026-07-15T14:00:00Z', 'December 1 2026 at 00:30', '2026-12-01', '00:30'],
    ['2026-03-07T15:00:00Z', 'tomorrow at 10am', '2026-03-08', '10:00'],
    ['2026-10-31T14:00:00Z', 'tomorrow at 00:30', '2026-11-01', '00:30'],
    ['2026-03-07T15:00:00Z', 'in 2 days at 10am', '2026-03-09', '10:00'],
    ['2026-10-31T14:00:00Z', 'in 2 days at 00:30', '2026-11-02', '00:30'],
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

  it.each([
    ['2026-03-07T15:00:00Z', '2026-03-08', '11:00'],
    ['2026-10-31T14:00:00Z', '2026-11-01', '09:00'],
  ])('B16: retains elapsed-hour semantics across DST from %s', (clock, date, time) => {
    const now = DateTime.fromISO(clock, { zone: 'America/New_York' });
    expect(chronoSpans('starting in 24 hours', now)[0]).toMatchObject({ kind: 'start', date, time });
  });

  it('B16: an explicit input timezone still converts its instant to the session timezone', () => {
    const now = DateTime.fromISO('2026-01-15T15:00:00Z', { zone: 'America/New_York' });
    expect(chronoSpans('starting July 1 2026 at 00:30 UTC', now)[0]).toMatchObject({
      kind: 'start',
      date: '2026-06-30',
      time: '20:30',
    });
  });

  it('B16: a timezone supplied on one range endpoint still applies to both endpoints', () => {
    const now = DateTime.fromISO('2026-01-15T15:00:00Z', { zone: 'America/New_York' });
    const spans = chronoSpans('from July 1 2026 at 10am until July 2 2026 at 11am UTC', now);
    expect(spans.map(({ kind, date, time }) => ({ kind, date, time }))).toEqual([
      { kind: 'start', date: '2026-07-01', time: '06:00' },
      { kind: 'end', date: '2026-07-02', time: '07:00' },
    ]);
  });

  it('B16: relative dates use the session calendar day when UTC is on the previous day', () => {
    const now = DateTime.fromISO('2026-11-05T20:00:00Z', { zone: 'Asia/Kolkata' });
    expect(chronoSpans('starting tomorrow at 10am', now)[0]).toMatchObject({
      kind: 'start',
      date: '2026-11-07',
      time: '10:00',
    });
  });

  it.each([
    'starting November 20 2026 until November 10 2026',
    'beginning 20 November 2026 till 10 November 2026',
    'from 2026-11-20 to 2026-11-10',
    'from November 20 2026 - November 10 2026',
    'starting November 20 2026 at 11am until November 10 2026 at 9am',
  ])('B17: preserves the typed start/end order in %s', (phrase) => {
    const now = DateTime.fromISO('2026-11-05T17:30:00Z', { zone: 'Asia/Kolkata' });
    const spans = chronoSpans(`pay daily ${phrase}`, now);
    expect(spans.map(({ kind, date }) => ({ kind, date }))).toEqual([
      { kind: 'start', date: '2026-11-20' },
      { kind: 'end', date: '2026-11-10' },
    ]);
    for (const span of spans) expect(`pay daily ${phrase}`.slice(span.start, span.end)).toBe(span.text);
  });

  it.each([
    ['from November 10 2026 until November 20 2026', '2026-11-10', '2026-11-20'],
    ['starting 12 nov until 31 dec 2026', '2026-11-12', '2026-12-31'],
    ['from December 20 until January 10', '2026-12-20', '2027-01-10'],
    ['from November 10 until November 20 2027', '2027-11-10', '2027-11-20'],
    ['from 10 to 20 November 2026', '2026-11-10', '2026-11-20'],
    ['from November 10-20 2026', '2026-11-10', '2026-11-20'],
  ])('B17: retains valid full and abbreviated ranges in %s', (phrase, start, end) => {
    const now = DateTime.fromISO('2026-11-05T17:30:00Z', { zone: 'Asia/Kolkata' });
    expect(chronoSpans(phrase, now).map(({ kind, date }) => ({ kind, date }))).toEqual([
      { kind: 'start', date: start },
      { kind: 'end', date: end },
    ]);
  });

  it('B17: preserves a valid same-day time range', () => {
    const now = DateTime.fromISO('2026-11-05T17:30:00Z', { zone: 'Asia/Kolkata' });
    const spans = chronoSpans('from November 10 2026 at 9am until November 10 2026 at 11am', now);
    expect(spans.map(({ kind, date, time }) => ({ kind, date, time }))).toEqual([
      { kind: 'start', date: '2026-11-10', time: '09:00' },
      { kind: 'end', date: '2026-11-10', time: '11:00' },
    ]);
  });

  it('B17: restores endpoint times and a shared explicit timezone along with their dates', () => {
    const now = DateTime.fromISO('2026-01-15T15:00:00Z', { zone: 'America/New_York' });
    const spans = chronoSpans('from July 2 2026 at 10am until July 1 2026 at 11am UTC', now);
    expect(spans.map(({ kind, date, time }) => ({ kind, date, time }))).toEqual([
      { kind: 'start', date: '2026-07-02', time: '06:00' },
      { kind: 'end', date: '2026-07-01', time: '07:00' },
    ]);
  });
});
