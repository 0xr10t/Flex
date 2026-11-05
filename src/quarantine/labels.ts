// Implements: the `{item}` slot of §15 DOCUMENT_TOO_LARGE ("{item} is too long for me to read safely.") and of the
// §13.1 note "Couldn't read anything usable from {item}.", and `{n}` of §15 URL_FETCH_FAILED ("link {n}").
// The spec does not word `{item}`. LOCAL STUB pending CCR B-1 (ccr/B-1.md: add ITEM_LABEL to
// src/contracts/catalog.ts) and spec question SQB-02; once the Orchestrator publishes it, this file re-exports it.
// Owner: Lane B.

export type ContentItemKind = 'pasted' | 'attachment' | 'url';

/**
 * Attachments are named by their filename (as §15 ATTACHMENT_UNSUPPORTED does); links by their number as in the
 * `[link N]` markers (§8.2 step 1) and URL_FETCH_FAILED; pasted blocks by their position.
 */
export const ITEM_LABEL = {
  attachment: (p: { filename: string }): string => p.filename,
  url: (p: { n: number }): string => `link ${p.n}`,
  pasted: (p: { n: number }): string => `pasted text ${p.n}`,
} as const;

/** §8.2 step 1: typed URLs are replaced by `[link N]`. */
export const LINK_MARKER = (n: number): string => `[link ${n}]`;
