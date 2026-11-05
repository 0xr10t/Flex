// Implements: §14.2 agent → execution layer: POST {execution.url}/v1/intents with the bearer token, Idempotency-Key and
// JSON body; 2xx accepted, 4xx rejected with the body's `message` (SQ-D-09 when absent), 5xx / timeout / network failure
// unavailable. Redirects are refused so the token and the envelope go only to the configured URL.

import type { ExecutionClient, SubmitResult } from '../contracts/io.js';
import type { Config } from '../contracts/types.js';

async function rejectedMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown } | null;
    if (typeof body?.message === 'string' && body.message.length > 0) return body.message;
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
        return { status: 'unavailable' };
      }
      if (res.ok) return { status: 'accepted' };
      if (res.status >= 400 && res.status < 500) return { status: 'rejected', message: await rejectedMessage(res) };
      return { status: 'unavailable' };
    },
  };
}
