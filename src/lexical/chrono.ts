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

function parts(c: chrono.ParsedComponents, zone: string): { date: string | null; time: string | null } {
  const dt = DateTime.fromJSDate(c.date(), { zone });
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
  const results = chrono.parse(text, { instant: now.toJSDate(), timezone: now.offset }, { forwardDate: true });
  const out: RawChronoSpan[] = [];
  for (const r of results) {
    const start = r.index;
    const end = r.index + r.text.length;
    const before = /([A-Za-z]+)\W*$/.exec(text.slice(0, start))?.[1]?.toLowerCase() ?? null;
    out.push({ text: r.text, start, end, kind: kindOf(r.text, before, r.start), ...parts(r.start, zone) });
    if (r.end) {
      out.push({ text: r.text, start, end, kind: 'end', ...parts(r.end, zone) });
    }
  }
  return out;
}
