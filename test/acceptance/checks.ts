// Shared assertions: hand-off envelope (validated against §12.5 and compared field by field), DB6/DB7 rows,
// terminal responses.
import { expect } from 'vitest';
import type { Db7Row } from '../../src/contracts/repos.js';
import { validators } from '../../src/schemas/index.js';
import { AUTOPAY_ID, REQUEST_ID, head, normalizeTimes, type Harness, type Resp } from './harness.js';

export const AP = '<autopay_id>';

/** The execution layer received exactly this envelope (idempotency key = request_id). */
export function expectEnvelope(h: Harness, request_id: string, intents: Array<Record<string, unknown>>): void {
  expect(request_id).toMatch(REQUEST_ID);
  const sub = h.exec.submissions[h.exec.submissions.length - 1];
  expect(sub, 'no envelope was handed off').toBeDefined();
  const env = sub!.envelope;
  expect(validators.handoffEnvelope(env), JSON.stringify(validators.handoffEnvelope.errors)).toBe(true);
  expect(sub!.idempotencyKey).toBe(request_id);
  const want = intents.map((i) => {
    if (i.autopay_id !== AP) return i;
    const actual = (env.intents.find((x) => x.step === i.step) as { autopay_id?: string } | undefined)?.autopay_id;
    expect(actual).toMatch(AUTOPAY_ID);
    return { ...i, autopay_id: actual };
  });
  expect(normalizeTimes(env)).toEqual(normalizeTimes({ ...head(h, request_id), intents: want }));
}

export function expectHandedOff(r: Resp): void {
  expect(r.http).toBe(200);
  expect(r.body.state).toBe('done');
  expect(r.body.messages.map((m) => m.text)).toEqual(['Sent to your wallet for signing.']);
}

export function expectError(r: Resp, code: string, message?: string | RegExp): void {
  expect(r.http).toBe(200);
  expect(r.body.state).toBe('error');
  expect(r.body.error?.code).toBe(code);
  if (typeof message === 'string') expect(r.body.error?.message).toBe(message);
  else if (message) expect(r.body.error?.message).toMatch(message);
}

export interface SpendRow {
  kind: string;
  counts: boolean;
  chain: number;
  token: string;
  amount: string;
  recipient: string | null;
  intent: string | null;
  step: number | null;
  status: string;
}

/** DB6 rows in a canonical order (kind, step, chain, amount). */
export function spend(h: Harness, request_id?: string): SpendRow[] {
  const rows = h.rows<Record<string, unknown>>(
    request_id ? 'SELECT * FROM db6_spend_log WHERE request_id = ?' : 'SELECT * FROM db6_spend_log',
    ...(request_id ? [request_id] : []),
  );
  return rows
    .map((r) => ({
      kind: r.kind as string,
      counts: r.counts_toward_limit === 1,
      chain: r.chain_id as number,
      token: r.token as string,
      amount: r.amount as string,
      recipient: r.recipient_address as string | null,
      intent: r.intent_id as string | null,
      step: r.step as number | null,
      status: r.status as string,
    }))
    .sort(
      (a, b) =>
        a.kind.localeCompare(b.kind) ||
        (a.step ?? -1) - (b.step ?? -1) ||
        a.chain - b.chain ||
        a.amount.localeCompare(b.amount),
    );
}

export const pending = (
  kind: string,
  chain: number,
  amount: string,
  step: number | null,
  intent: string | null,
  o: { recipient?: string | null; counts?: boolean; token?: string } = {},
): SpendRow => ({
  kind,
  counts: o.counts ?? ['payment', 'bridge_buffer', 'bridge_fee', 'autopay_payment', 'autopay_fee'].includes(kind),
  chain,
  token: o.token ?? 'USDC',
  amount,
  recipient: o.recipient ?? null,
  intent,
  step,
  status: 'pending',
});

export function autopays(h: Harness): Db7Row[] {
  return h.rows<Db7Row>('SELECT * FROM db7_autopays ORDER BY created_at, autopay_id');
}

/** db8_history payments of the most recent entry. */
export function lastHistory(h: Harness): Array<Record<string, unknown>> {
  const r = h.rows<{ payments_json: string }>('SELECT payments_json FROM db8_history ORDER BY id DESC LIMIT 1')[0];
  return r ? (JSON.parse(r.payments_json) as Array<Record<string, unknown>>) : [];
}

export const noSubmission = (h: Harness): void => {
  expect(h.exec.submissions).toEqual([]);
};

export const usdcIntent = (o: {
  step: number;
  chain: number;
  token_address: string;
  amount: unknown;
  recipient: string;
  depends_on?: number[];
}): Record<string, unknown> => ({
  intent_id: 'i',
  step: o.step,
  depends_on: o.depends_on ?? [],
  token: 'USDC',
  token_address: o.token_address,
  chain_id: o.chain,
  recipients: [{ amount: o.amount, recipient: o.recipient }],
});
