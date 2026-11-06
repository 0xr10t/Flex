// Implements: §8.3 S2 — Lexical scan (code) as a pipeline step: runs lexicalScan over `typed_text` with the
// configured chain aliases and "now" in the session timezone; rule 6 / rule 7 errors stop the request
// (MAINNET_NOT_SUPPORTED, UNSUPPORTED_CHAIN, UNSUPPORTED_TOKEN). S2 asks no questions (no AnswerHandler).
// SQ-S-02: back-references can use the immediately previous eligible failed payment as session context.
// Owner: Lane B.

import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import { lexicalScan } from '../lexical/scan.js';
import { selectFailedPaymentContext } from '../session/failed-payment.js';

async function s2Step(ctx: StepContext): Promise<StepResult> {
  const r = lexicalScan(ctx.req.typed_text, { chains: ctx.config.chains, now: ctx.now() });
  if (!r.ok) return r.params ? { kind: 'error', code: r.code, params: r.params } : { kind: 'error', code: r.code };
  ctx.req.scan = r.scan;
  selectFailedPaymentContext(ctx.req, ctx.config.chains);
  ctx.req.state = 'SCANNED';
  ctx.log.info({
    event: 'scanned',
    step: 's2',
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
    n_amounts: r.scan.numeric_candidates.length,
  });
  return { kind: 'continue' };
}

export const s2: StepEntry = { step: s2Step };
