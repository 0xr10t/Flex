// Implements: §8.3 rule 8 — `chrono.parse(typed_text, now_in_session_tz, { forwardDate: true })` → spans with
// kind (time, date, start, end) and offsets. §5: chrono-node with the reference date = now in the session
// timezone; luxon for timezone math. §10.6 "start" markers ("starting", "from", "beginning"), end markers
// ("until <date>", "for N payments/weeks/…").
// Owner: Lane B.

import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import type { ChronoKind } from '../contracts/types.js';

export interface RawChronoSpan {
  text: string;
  start: number;
  end: number;
  kind: ChronoKind;
  date: string | null;
  time: string | null;
}

const START_WORDS = new Set(['starting', 'from', 'beginning']);
const END_WORDS = new Set(['until', 'till']);
const DATE_COMPONENTS = ['year', 'month', 'day'] as const;

function calendarKey(c: chrono.ParsedComponents): string {
  return DATE_COMPONENTS.map((key) => c.get(key)).join('/');
}

/** A whole, explicitly dated endpoint; abbreviated ranges keep chrono's shared-field/year inference. */
function explicitDate(text: string, reference: chrono.ParsingReference): string | null {
  const trimmed = text.trim();
  const results = chrono.parse(trimmed, reference, { forwardDate: true });
  const r = results[0];
  if (
    results.length !== 1 ||
    !r ||
    r.end ||
    r.index !== 0 ||
    r.text.length !== trimmed.length ||
    !DATE_COMPONENTS.every((key) => r.start.isCertain(key))
  )
    return null;
  return calendarKey(r.start);
}

/** Chrono sorts fully dated ranges. Recover their typed direction before labelling start/end for S9. */
function rangeWasReversed(r: chrono.ParsedResult, reference: chrono.ParsingReference): boolean {
  if (!r.end) return false;
  const start = calendarKey(r.start);
  const end = calendarKey(r.end);
  if (start === end) return false;
  for (const separator of r.text.matchAll(/\b(?:to|until|through|till)\b|[-–]/gi)) {
    if (explicitDate(r.text.slice(0, separator.index), reference) !== end) continue;
    if (explicitDate(r.text.slice(separator.index + separator[0].length), reference) === start) return true;
  }
  return false;
}

function parts(
  c: chrono.ParsedComponents,
  zone: string,
  useParsedInstant: boolean,
): { date: string | null; time: string | null } {
  // Chrono's numeric reference offset describes now, not the offset on a future date. Without a typed
  // timezone, its calendar components are session-local fields; converting c.date() would shift them at DST.
  // A certain timezone (explicit, shared by a range, or from an elapsed-hour duration) describes an instant.
  const dt = useParsedInstant
    ? DateTime.fromJSDate(c.date(), { zone })
    : DateTime.fromObject(
        {
          year: c.get('year') as number,
          month: c.get('month') as number,
          day: c.get('day') as number,
          hour: c.get('hour') ?? 0,
          minute: c.get('minute') ?? 0,
        },
        { zone },
      );
  const hasTime = c.isCertain('hour');
  const hasDate =
    c.isCertain('day') || c.isCertain('weekday') || c.isCertain('month') || c.isCertain('year') || !hasTime;
  return {
    date: hasDate ? dt.toISODate() : null,
    time: hasTime ? dt.toFormat('HH:mm') : null,
  };
}

function kindOf(text: string, before: string | null, c: chrono.ParsedComponents): ChronoKind {
  const first = /^([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase() ?? '';
  if (START_WORDS.has(first) || (before !== null && START_WORDS.has(before))) return 'start';
  if (END_WORDS.has(first) || first === 'for' || (before !== null && END_WORDS.has(before))) return 'end';
  const timeOnly = c.isCertain('hour') && !c.isCertain('day') && !c.isCertain('weekday') && !c.isCertain('month');
  return timeOnly ? 'time' : 'date';
}

/** Runs chrono with the session-local reference instant. */
export function chronoSpans(text: string, now: DateTime): RawChronoSpan[] {
  const zone = now.zoneName ?? 'utc';
  const reference = { instant: now.toJSDate(), timezone: now.offset };
  const results = chrono.parse(text, reference, { forwardDate: true });
  const out: RawChronoSpan[] = [];
  for (const r of results) {
    const start = r.index;
    const end = r.index + r.text.length;
    const prefix = text.slice(0, start);
    const startMarker = /\b(starting|from|beginning)(?:\s+on)?\s*$/i.exec(prefix)?.[1];
    const before = startMarker?.toLowerCase() ?? /([A-Za-z]+)\W*$/.exec(prefix)?.[1]?.toLowerCase() ?? null;
    const kind = kindOf(r.text, before, r.start);
    // Swap the original components back, retaining their inferred fields (including a shared timezone).
    let first = r.start;
    let last = r.end;
    if (kind === 'start' && last && rangeWasReversed(r, reference)) [first, last] = [last, first];
    const useParsedInstant = first.isCertain('timezoneOffset') || (last?.isCertain('timezoneOffset') ?? false);
    out.push({ text: r.text, start, end, kind, ...parts(first, zone, useParsedInstant) });
    if (last) {
      out.push({ text: r.text, start, end, kind: 'end', ...parts(last, zone, useParsedInstant) });
    }
  }
  return out;
}
