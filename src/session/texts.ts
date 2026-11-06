// Implements: §17.3 text classification while a request awaits an answer or a confirmation (cancel texts, "yes"
// texts, "no" texts; case-insensitive, trimmed). SQ-18 interim: "stop" is in both the cancel and the "no" lists;
// the cancel row (listed first in §17.3) wins. Owner: Lane A.

import { CANCEL_TEXTS, CONFIRM_NO_TEXTS, CONFIRM_YES_TEXTS } from '../contracts/static-tables.js';

const norm = (text: string): string => text.trim().toLowerCase();

/** §17.3: `cancel`, `stop`, `abort`, `never mind`, `nevermind`, `forget it`. */
export function isCancelText(text: string): boolean {
  return CANCEL_TEXTS.includes(norm(text));
}

export type ConfirmationText = 'cancel' | 'yes' | 'no' | 'other';

/** Classifies text received while AWAITING_CONFIRMATION (§17.3 rows 3–6; cancel first, SQ-18). */
export function classifyConfirmationText(text: string): ConfirmationText {
  const t = norm(text);
  if (CANCEL_TEXTS.includes(t)) return 'cancel';
  if (CONFIRM_YES_TEXTS.includes(t)) return 'yes';
  if (CONFIRM_NO_TEXTS.includes(t)) return 'no';
  return 'other';
}
