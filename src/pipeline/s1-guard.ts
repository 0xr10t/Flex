// Implements: §8.2 S1 — Guard (code + Q-LLM): step 1 collect untrusted content (pasted blocks; attachments
// text/plain, text/markdown, text/csv UTF-8 decoded, application/pdf via pdf-parse, anything else →
// ATTACHMENT_UNSUPPORTED naming the file; urls[] (https only, else URL_FETCH_FAILED); URLs in typed text become
// `[link N]` but are never fetched (privacy fix 5, note LINKS_NOT_OPENED); `fetch.enabled` false → LINKS_OFF), step 2
// secret scan over typed text, pasted blocks and attachment text (not fetched pages; I-15) and, per SQ-O-06, every link URL (the fetcher scans each redirect target too) → SECRET_DETECTED with nothing
// written to DB8/DB1/DB3/logs and buffers dropped, step 3 fetch URLs only after the scan passes
// (ContentFetcher: SSRF, redirects, size, types) → URL_FETCH_FAILED with the link number, step 4 20,000-character
// cap per item → DOCUMENT_TOO_LARGE, step 5 Q-LLM extraction per item (failure → note
// "Couldn't read anything usable from <item>."), step 6 persist typed text + pasted blocks to db8_prompts.
// ENS text records are never fetched (C-077: nothing here reads ENS). §3.2, §16.1, §16.3, FR-01, FR-03, I-13–I-17.
// S1 asks no questions, so it has no AnswerHandler.
// Owner: Lane B.

import { NOTES } from '../contracts/catalog.js';
import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { MessageInput, QItem } from '../contracts/types.js';
import { detectSecret } from '../guard/secrets.js';
import { extractUrls, isHttpsUrl, isSecretRefusal, urlHasSecret } from '../guard/urls.js';
import { nowUtcIso, unsupported } from '../lexical/step-util.js';
import { decodeUtf8, pdfToText } from '../quarantine/extract.js';
import { ITEM_LABEL } from '../quarantine/labels.js';
import { extractUntrusted } from '../quarantine/qllm.js';

/** §8.2 step 1 allowed attachment MIME types. */
const TEXT_MIMES = new Set(['text/plain', 'text/markdown', 'text/csv']);
const PDF_MIME = 'application/pdf';
/** §8.2 step 4 / I-16. */
const MAX_ITEM_CHARS = 20_000;

interface ContentItem {
  label: string;
  /** Secret-scanned (pasted blocks and attachments; not fetched pages, I-15). */
  scanned: boolean;
  text: string | null;
  link?: number;
  url?: string;
}

function charLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function dropBuffers(ctx: StepContext): void {
  // §8.2 step 2: "buffers are dropped".
  ctx.req.input = undefined;
  ctx.req.typed_text = '';
  ctx.req.untrusted = [];
}

async function s1Step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  const input: MessageInput = req.input ?? { text: req.typed_text, pasted_blocks: [], attachments: [], urls: [] };
  const items: ContentItem[] = [];

  // ── step 1: collect untrusted content ──
  input.pasted_blocks.forEach((text, i) => items.push({ label: ITEM_LABEL.pasted({ n: i + 1 }), scanned: true, text }));

  for (const a of input.attachments) {
    const mime = a.mime.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!TEXT_MIMES.has(mime) && mime !== PDF_MIME) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'ATTACHMENT_UNSUPPORTED', params: { filename: a.filename } };
    }
    const bytes = new Uint8Array(Buffer.from(a.base64, 'base64'));
    let text: string;
    if (mime === PDF_MIME) {
      try {
        text = await pdfToText(bytes);
      } catch {
        // An allowed PDF that cannot be read is not covered by the spec (SQB-08).
        dropBuffers(ctx);
        return unsupported(ctx, 's1', 'S1_PDF_UNREADABLE');
      }
    } else {
      text = decodeUtf8(bytes);
    }
    items.push({ label: ITEM_LABEL.attachment({ filename: a.filename }), scanned: true, text });
  }

  const { typed_text, links } = extractUrls(input.text, input.urls);
  // Privacy fix 5: a link typed in the message is never opened (it still becomes `[link N]`); only `urls[]` are read.
  if (links.some((l) => l.from_typed_text)) req.notes.push(NOTES.LINKS_NOT_OPENED());
  for (const l of links) {
    if (l.from_typed_text) continue;
    if (!isHttpsUrl(l.url)) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'URL_FETCH_FAILED', params: { n: String(l.n) } };
    }
    items.push({ label: ITEM_LABEL.url({ n: l.n }), scanned: false, text: null, link: l.n, url: l.url });
  }

  // ── step 2: secret scan (typed text — before and after URL removal — pasted blocks, attachment text, URLs) ──
  const toScan = [input.text, ...items.filter((i) => i.scanned).map((i) => i.text ?? '')];
  if (toScan.some((t) => detectSecret(t) !== null) || links.some((l) => urlHasSecret(l.url))) {
    dropBuffers(ctx);
    return { kind: 'error', code: 'SECRET_DETECTED' };
  }

  // ── step 3: fetch URLs (only after the scan passed) ──
  for (const it of items) {
    if (it.url === undefined) continue;
    // Privacy fix 5: a fetch goes straight from this machine, outside anon-rpc, so it happens only when enabled.
    if (!ctx.config.fetch.enabled) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'LINKS_OFF', params: { n: String(it.link) } };
    }
    const res = await ctx.fetcher.fetchUrl(it.url);
    if (isSecretRefusal(res)) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'SECRET_DETECTED' };
    }
    if (!res.ok) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'URL_FETCH_FAILED', params: { n: String(it.link) } };
    }
    it.text = res.text;
  }

  // ── step 4: size ──
  for (const it of items) {
    if (charLength(it.text ?? '') > MAX_ITEM_CHARS) {
      dropBuffers(ctx);
      return { kind: 'error', code: 'DOCUMENT_TOO_LARGE', params: { item: it.label } };
    }
  }

  // ── step 5: Q-LLM extraction, one call per content item ──
  const untrusted: QItem[] = [];
  for (const [index, it] of items.entries()) {
    const out = await extractUntrusted(ctx.llm, it.text ?? '', index);
    if (out === null) {
      req.notes.push(NOTES.CONTENT_UNREADABLE({ item: it.label }));
      continue;
    }
    untrusted.push(...out);
  }

  // ── step 6: persist typed text and pasted blocks (attachments and fetched pages are not stored) ──
  const created_at = nowUtcIso(ctx);
  ctx.repos.db8.insertPrompt({
    session_id: req.session_id,
    request_id: req.request_id,
    kind: 'typed',
    text: typed_text,
    created_at,
  });
  for (const text of input.pasted_blocks) {
    ctx.repos.db8.insertPrompt({
      session_id: req.session_id,
      request_id: req.request_id,
      kind: 'pasted',
      text,
      created_at,
    });
  }

  req.typed_text = typed_text;
  req.untrusted = untrusted;
  req.input = undefined;
  req.state = 'GUARDED';
  ctx.log.info({
    event: 'guard_passed',
    step: 's1',
    session_id: req.session_id,
    request_id: req.request_id,
    n_amounts: untrusted.filter((q) => q.amount !== null).length,
    n_payees: untrusted.filter((q) => q.address !== null || q.ens_name !== null).length,
  });
  return { kind: 'continue' };
}

export const s1: StepEntry = { step: s1Step };
