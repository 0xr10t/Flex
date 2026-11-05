// Implements: §7.3 steps 1–2, 4, 7 (formats; randomness from node:crypto randomBytes only).
// Owner: Lane A. contracts-v1 skeleton; collision retry (§7.3 step 3) lives in the repositories' mint().

import { randomBytes } from 'node:crypto';
import type { IdKind, NewId, NewPlaceholder, PlaceholderKind } from '../contracts/step.js';

const ID_PREFIX: Record<IdKind, string> = { request: 'req_', autopay: 'ap_', session: 'ses_', question: 'q_' };
const PH_PREFIX: Record<PlaceholderKind, string> = { amount: 'amount_', address: 'address_', group: 'group_' };

export const newId: NewId = (kind) => ID_PREFIX[kind] + randomBytes(6).toString('hex');
export const newPlaceholder: NewPlaceholder = (kind) => PH_PREFIX[kind] + randomBytes(4).toString('hex');
