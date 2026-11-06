// Implements: the `{item}` slot of §15 DOCUMENT_TOO_LARGE / the §13.1 note (via the catalog's ITEM_LABEL, CCR B-1,
// contracts-v3; wording interim per SQ-22) and the §8.2 step 1 `[link N]` marker.
// Owner: Lane B.

export { ITEM_LABEL } from '../contracts/catalog.js';

/** §8.2 step 1: typed URLs are replaced by `[link N]`. */
export const LINK_MARKER = (n: number): string => `[link ${n}]`;
