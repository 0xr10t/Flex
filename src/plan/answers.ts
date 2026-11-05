// Implements: §13.4 answer parsing for Lane D questions — "Number answers go through the S3 code parser (no LLM).
// Date answers go through chrono in the session timezone."

import * as chrono from 'chrono-node';
import type { DateTime } from 'luxon';
import type { Answer } from '../contracts/types.js';
import { parseAmountText } from '../amounts/parse.js';

export function answerText(answer: Answer): string | null {
  return answer.kind === 'text' ? answer.text : null;
}

/** A positive whole number via the S3 code parser (digits, commas, number words). Null when not a whole number > 0. */
export function parseCount(text: string): number | null {
  const parsed = parseAmountText(text.trim(), null);
  if (!parsed.ok || !/^\d+$/.test(parsed.value)) return null;
  const n = Number(parsed.value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** A calendar date (yyyy-MM-dd) parsed by chrono relative to `now` in the session timezone; null when none. */
export function parseDateAnswer(text: string, now: DateTime): string | null {
  const results = chrono.parse(text, { instant: now.toJSDate(), timezone: now.offset }, { forwardDate: true });
  const r = results[0];
  if (!r) return null;
  const y = r.start.get('year');
  const m = r.start.get('month');
  const d = r.start.get('day');
  if (y === null || m === null || d === null) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
