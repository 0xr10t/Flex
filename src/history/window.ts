import type { DateTime } from 'luxon';
import { HISTORY_LOOKBACK_MS } from './types.js';

export type HistoryPeriod =
  { kind: 'week' | 'today' | 'yesterday' | 'unsupported' } | { kind: 'rolling'; hours: number };

export function historyWindow(
  period: HistoryPeriod,
  now: DateTime,
): { fromMs: number; throughMs: number; label: string } | null {
  let from = now;
  let throughMs = now.toMillis();
  let label: string;
  switch (period.kind) {
    case 'week':
      from = now.startOf('week');
      label = `This week: Monday ${from.toFormat('d LLL yyyy, HH:mm')} onward`;
      break;
    case 'today':
      from = now.startOf('day');
      label = 'Today';
      break;
    case 'yesterday':
      from = now.startOf('day').minus({ days: 1 });
      throughMs = now.startOf('day').toMillis() - 1;
      label = 'Yesterday';
      break;
    case 'rolling':
      if (!Number.isSafeInteger(period.hours) || period.hours < 1 || period.hours > 168) return null;
      from = now.minus({ hours: period.hours });
      label = period.hours % 24 === 0 ? `Last ${period.hours / 24} days` : `Last ${period.hours} hours`;
      break;
    default:
      return null;
  }
  if (now.toMillis() - from.toMillis() > HISTORY_LOOKBACK_MS || throughMs < from.toMillis()) return null;
  return {
    fromMs: from.toMillis(),
    throughMs,
    label: `${label} (${now.zoneName}); ${from.toFormat('d LLL yyyy, HH:mm')} to ${now.minus({ milliseconds: now.toMillis() - throughMs }).toFormat('d LLL yyyy, HH:mm')}.`,
  };
}
