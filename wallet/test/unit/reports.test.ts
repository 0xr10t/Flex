import { validateExecutionReport } from '@flex/protocol';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { silentLogger } from '../../src/log.js';
import { ReportSender } from '../../src/runner/reports.js';
import { Store } from '../../src/store/store.js';
import { tempDb } from '../support/temp-db.js';
import { ALEX, envelope, payEth } from '../support/envelopes.js';

beforeEach(() => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))));
const senders: ReportSender[] = [];
afterEach(async () => {
  await Promise.all(senders.splice(0).map((s) => s.stop()));
  vi.unstubAllGlobals();
});

interface Received {
  auth: string | undefined;
  body: unknown;
}

/** A stand-in for the agent's report route. */
const agent = async (statusFor: (attempt: number) => number) => {
  const received: Received[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe('http://agent.local/v1/execution/reports');
    const body: unknown = await request.json();
    expect(validateExecutionReport(body)).toBe(true);
    received.push({ auth: request.headers.get('authorization') ?? undefined, body });
    return new Response(null, { status: statusFor(received.length) });
  });
  return { received, url: 'http://agent.local' };
};

const storeWithReport = () => {
  const store = new Store(tempDb());
  const e = envelope([payEth(0, [[ALEX, '0.01']])]);
  store.insertRequest(e, '2026-11-06T10:00:00.000Z');
  store.finishStep(e.request_id, 0, { status: 'failed', error_code: 'USER_REJECTED' }, '2026-11-06T10:00:00.000Z', 0);
  return { store, e };
};

const sender = (store: Store, agentUrl: string) => {
  const s = new ReportSender({ store, agentUrl, reportToken: 'report-token', log: silentLogger, baseDelayMs: 5 });
  senders.push(s);
  return s;
};

describe('reports to the agent (§14.3)', () => {
  it('sends the report once, with the token, and stops on 204', async () => {
    const { store, e } = storeWithReport();
    const a = await agent(() => 204);
    await sender(store, a.url).kick();
    expect(a.received).toEqual([
      {
        auth: 'Bearer report-token',
        body: { kind: 'intent_result', request_id: e.request_id, step: 0, status: 'failed' },
      },
    ]);
    expect(store.allReports()[0]?.status).toBe('delivered');
  });

  it.each([400, 404])('gives up on %i, which a retry would not change', async (status) => {
    const { store } = storeWithReport();
    const a = await agent(() => status);
    await sender(store, a.url).kick();
    await new Promise((r) => setTimeout(r, 30));
    expect(a.received).toHaveLength(1);
    expect(store.allReports()[0]?.status).toBe('abandoned');
  });

  it('retries a 500 until the agent accepts', async () => {
    const { store } = storeWithReport();
    const a = await agent((n) => (n < 3 ? 500 : 204));
    await sender(store, a.url).kick();
    await vi.waitFor(() => expect(store.allReports()[0]?.status).toBe('delivered'));
    expect(a.received).toHaveLength(3);
  });

  it('keeps a report while the agent is down, and delivers it once it is back', async () => {
    const { store } = storeWithReport();
    const before = sender(store, 'http://127.0.0.1:9');
    await before.kick();
    await before.stop();
    expect(store.allReports()[0]?.status).toBe('pending');
    expect(store.allReports()[0]?.attempts).toBe(1);

    // A new sender stands in for a restart: the report comes from the store.
    const a = await agent(() => 204);
    await new Promise((r) => setTimeout(r, 15));
    await sender(store, a.url).kick();
    expect(a.received).toHaveLength(1);
    expect(store.allReports()[0]?.status).toBe('delivered');
  });

  it('waits longer after each failure', async () => {
    const { store } = storeWithReport();
    const now = 1_000_000;
    const s = new ReportSender({
      store,
      agentUrl: 'http://127.0.0.1:9',
      reportToken: 't',
      log: silentLogger,
      now: () => now,
      baseDelayMs: 1000,
      maxDelayMs: 3000,
    });
    senders.push(s);
    await s.kick();
    expect(store.allReports()[0]?.next_attempt_at).toBe(now + 1000);
    store.retryReport(store.allReports()[0]!.id, now);
    await s.kick();
    expect(store.allReports()[0]?.next_attempt_at).toBe(now + 3000);
    store.retryReport(store.allReports()[0]!.id, now);
    await s.kick();
    expect(store.allReports()[0]?.next_attempt_at).toBe(now + 3000);
  });
});
