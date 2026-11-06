// Implements: §14.2 agent → execution layer: POST {execution.url}/v1/intents with the bearer token, Idempotency-Key and
// JSON body; 2xx accepted, 4xx rejected with the body's `message` (SQ-D-09 when absent), 5xx / timeout / network failure
// unavailable (SQ-A-06 / F-9 cause: 5xx → server_error, no answer → timeout). Redirects are refused so the token and
// the envelope go only to the configured URL.

import type { ExecutionClient, SubmitResult } from '../contracts/io.js';
import type { Config } from '../contracts/types.js';

/**
 * SQ-O-09: the execution layer's message shown to the user, at most 200 characters, no control characters. R6-3: Unicode
 * format characters (\p{Cf}: bidi overrides, zero-width marks, …) and the U+2028 / U+2029 separators are removed too.
 */
const REJECT_MESSAGE_MAX = 200;

export function rejectMessage(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, ''))
    .slice(0, REJECT_MESSAGE_MAX)
    .join('');
}

async function rejectedMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown } | null;
    const message = typeof body?.message === 'string' ? rejectMessage(body.message) : '';
    if (message.trim().length > 0) return message;
  } catch {
    // Not JSON, or the timeout hit while reading: fall through to the status.
  }
  return `HTTP ${res.status}`;
}

export function createExecutionClient(config: Config, outboundToken: string): ExecutionClient {
  const url = `${config.execution.url.replace(/\/+$/, '')}/v1/intents`;
  return {
    async submit(envelope, idempotencyKey): Promise<SubmitResult> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${outboundToken}`,
            'Idempotency-Key': idempotencyKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(envelope),
          redirect: 'error',
          signal: AbortSignal.timeout(config.execution.timeout_ms),
        });
      } catch {
        // Timeout or network failure: no answer, so delivery is unknown.
        return { status: 'unavailable', cause: 'timeout' };
      }
      if (res.ok) return { status: 'accepted' };
      if (res.status >= 400 && res.status < 500) return { status: 'rejected', message: await rejectedMessage(res) };
      return { status: 'unavailable', cause: 'server_error' };
    },
  };
}
