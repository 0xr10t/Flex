// Implements: §7.3 rule 3 (redraw on primary-key violation, max 5 tries, then internal error), §7 timestamps as
// ISO-8601 UTC strings. Shared helpers for the repositories. Owner: Lane A.

import type { NewPlaceholder } from '../../contracts/step.js';
import type { ChainId } from '../../contracts/types.js';

export interface RepoOptions {
  /** Placeholder generator (default: src/util/ids.ts). Injected by tests to force collisions. */
  newPlaceholder: NewPlaceholder;
  /** Current instant as an ISO-8601 UTC string. */
  now: () => string;
  /** Chain display name for DB2/DB4 `chain` columns (§6.1 `chains[].name`). */
  chainName: (chain_id: ChainId) => string;
}

/** §7.3 rule 3: maximum number of draws for one placeholder. */
export const MAX_PLACEHOLDER_DRAWS = 5;

export class PlaceholderCollisionError extends Error {
  constructor() {
    super('placeholder collision: 5 draws failed');
    this.name = 'PlaceholderCollisionError';
  }
}

function isPrimaryKeyViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    ((e as { code: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      (e as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE')
  );
}

/** Draws a value and inserts it; on a primary-key violation draws again, at most 5 times (§7.3 rule 3). */
export function mintWithRetry<T extends string>(draw: () => T, insert: (value: T) => void): T {
  for (let i = 0; i < MAX_PLACEHOLDER_DRAWS; i++) {
    const value = draw();
    try {
      insert(value);
      return value;
    } catch (e) {
      if (!isPrimaryKeyViolation(e)) throw e;
    }
  }
  throw new PlaceholderCollisionError();
}

export const toBool = (v: number | bigint): boolean => Number(v) === 1;
export const toInt = (b: boolean): number => (b ? 1 : 0);
