// Real agent pipeline, wallet HTTP intake, both SQLCipher stores and wallet report sender. No sockets or signing.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DateTime } from 'luxon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutopayK, AutopayPaymentReport, HandoffEnvelope, IntentResultReport } from '@flex/protocol';
import { checkEnvelope, placeholderHashes, validateExecutionReport } from '@flex/protocol';
import { createExecutionClient } from '../../src/handoff/execution-client.js';
import { buildApp } from '../../wallet/src/server/app.js';
import { openDatabase, Store } from '../../wallet/src/store/store.js';
import { ReportSender } from '../../wallet/src/runner/reports.js';
import { ARB, BASE, Harness, REPORT_TOKEN, SEPOLIA, WALLET, type Resp } from './harness.js';
import type { FixtureCall, FixtureFile } from '../fakes/llm.js';

const NOW = '2026-11-05T17:30:00Z';
const TX = `0x${'ab'.repeat(32)}` as const;
const EXECUTOR = '0x00000000000000000000000000000000000000cc' as const;
const planId = (step: number) => `0x${(step + 1).toString(16).padStart(64, '0')}` as const;
const call = (name: FixtureCall['name'], output: unknown): FixtureCall => ({ name, match: '', output });
function fixture(kind: 'i' | 'k' | 'l', schedule: Record<string, unknown> = {}): FixtureFile {
  return { calls: [
    call('amounts', { amounts: kind === 'l' ? [] : [{ phrase: '10 usdc', number: '10', relative: null, token: 'USDC', fiat: null, role: 'pay' }] }),
    call('request_type', { request_type: 'actions', actions: [kind], also_balance: false }),
    call('spans', { spans: [{ text: 'Mihir', kind: 'name', role: 'payee' }] }),
    call('payments', { payments: [{ kind, amount: kind === 'l' ? null : '$amount:0', recipient: '$recipient:0', chain: kind === 'l' ? 'unstated' : BASE,
      frequency: null, interval: null, times_per_week: null, days_of_week: null, day_of_month: null, ...schedule }] }),
  ] };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); vi.unstubAllGlobals(); });

async function connected(f: FixtureFile, baseBalance = '1000') {
  const h = new Harness('shared-v2', f, { clock: NOW, balances: {
    [BASE]: { USDC: baseBalance, ETH: '0.1' }, [ARB]: { USDC: '1000', ETH: '0.1' }, [SEPOLIA]: { USDC: '0', ETH: '0.1' },
  } });
  const dir = mkdtempSync(join(tmpdir(), 'flex-shared-wallet-'));
  const db = openDatabase(join(dir, 'wallet.db'), '12'.repeat(32));
  const store = new Store(db);
  const accepted = vi.fn();
  const app = buildApp({ store, walletAddress: WALLET, inboundToken: 'wallet-token', chainIds: [BASE, ARB, SEPOLIA],
    executorChainIds: [BASE, ARB, SEPOLIA], onAccepted: accepted, log: () => {}, now: () => h.clock.toJSDate() });
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe('127.0.0.1');
    expect(init?.redirect).toBe('error');
    const target = url.pathname === '/v1/intents' ? app : url.pathname === '/v1/execution/reports' ? h.app : null;
    if (!target) throw new Error('unexpected transport target');
    const reply = await target.inject({ method: 'POST', url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers)), payload: String(init?.body) });
    return new Response(reply.statusCode === 204 ? null : reply.body, { status: reply.statusCode });
  }));
  const client = createExecutionClient(h.config, 'wallet-token');
  h.exec.submit = async (envelope, key) => {
    h.exec.submissions.push({ envelope: structuredClone(envelope), idempotencyKey: key });
    return client.submit(envelope, key);
  };
  const sender = new ReportSender({ store, agentUrl: 'http://127.0.0.1:8787', reportToken: REPORT_TOKEN,
    log: () => {}, now: () => h.clock.toMillis() });
  cleanups.push(async () => { await sender.stop(); await app.close(); db.close(); rmSync(dir, { recursive: true, force: true }); await h.finish({ allowUnused: true }); });
  await h.open();
  return { h, app, store, accepted, client, sender };
}

async function confirm(h: Harness, response: Resp): Promise<HandoffEnvelope> {
  expect(response.body.state, JSON.stringify(response.body)).toBe('awaiting_confirmation');
  const count = h.exec.submissions.length;
  expect((await h.confirm(response, 'yes')).body.state).toBe('done');
  expect(h.exec.submissions).toHaveLength(count + 1);
  const envelope = h.envelope;
  expect(checkEnvelope(envelope, { nowMs: h.clock.toMillis(), delegationHashes: placeholderHashes(envelope) }).ok).toBe(true);
  return envelope;
}

describe('shared agent ↔ wallet intent contract', () => {
  it('hands off a real pipeline payment only after confirmation; retry is idempotent and altered content conflicts', async () => {
    const { h, store, accepted, client, app } = await connected(fixture('i'));
    const pending = await h.say('Send 10 usdc to Mihir on Base');
    expect(store.storedHash(pending.body.request_id)).toBeNull();
    expect(accepted).not.toHaveBeenCalled();
    const envelope = await confirm(h, pending);
    expect(envelope.version).toBe('2');
    expect(envelope.intents[0]).toMatchObject({ intent_id: 'i', recipients: [{ amount: { value: '10', base_units: '10000000', decimals: 6 } }] });
    expect(store.envelope(envelope.request_id)).toEqual(envelope);
    expect(await client.submit(envelope, envelope.request_id)).toEqual({ status: 'accepted' });
    expect(accepted).toHaveBeenCalledTimes(1);
    const changed = { ...envelope, created_at: '2026-11-05T17:31:00Z' };
    const r = await app.inject({ method: 'POST', url: '/v1/intents', headers: { authorization: 'Bearer wallet-token', 'idempotency-key': envelope.request_id }, payload: changed });
    expect(r.statusCode).toBe(409);
  });

  it('bridges USDC with an ETH fee cap and replaces its reservation with the actual fee reported by the wallet', async () => {
    const { h, store, sender } = await connected(fixture('i'), '4');
    const envelope = await confirm(h, await h.say('Send 10 usdc to Mihir on Base'));
    expect(envelope.intents.map((i) => i.intent_id)).toEqual(['j', 'i']);
    expect(envelope.intents[0]).toMatchObject({ token: 'USDC', fee_max_eth: '0.002', funds_steps: [1], amount: { value: '6' } });
    const reserved = h.repos.db6.listByRequest(envelope.request_id).find((r) => r.kind === 'bridge_fee');
    expect(reserved).toMatchObject({ token: 'ETH', amount: '0.002', counts_toward_limit: true });
    store.finishStep(envelope.request_id, 0, { status: 'executed', tx_hash: TX, executed_at: h.nowIso, report: { bridge_fee_eth: '0.0003' } }, h.nowIso, h.clock.toMillis());
    await sender.kick();
    expect(store.allReports()[0]?.status).toBe('delivered');
    expect(h.repos.db6.listByRequest(envelope.request_id).find((r) => r.kind === 'bridge_fee')).toMatchObject({ amount: '0.0003', status: 'executed' });
  });

  it('splits weekly dates into fixed UTC legs, registers each plan and cancels all legs using the reported IDs', async () => {
    const f = { calls: [...fixture('k', { frequency: 'weekly', days_of_week: ['MON', 'THU'] }).calls, ...fixture('l').calls] };
    const { h, store, sender } = await connected(f);
    const pending = await h.say('Pay Mihir 10 usdc every Monday and Thursday for 4 payments on Base');
    expect(pending.body.summary?.text).toContain('Money stays in your wallet');
    const envelope = await confirm(h, pending);
    const legs = envelope.intents as AutopayK[];
    expect(legs).toHaveLength(2);
    expect(legs.map((leg) => leg.schedule)).toEqual([
      { start_at: Date.parse('2026-11-09T04:30:00Z') / 1000, interval_seconds: 604800, max_runs: 2, late_window_seconds: 3600, end_at: Date.parse('2026-11-16T05:30:00Z') / 1000 },
      { start_at: Date.parse('2026-11-12T04:30:00Z') / 1000, interval_seconds: 604800, max_runs: 2, late_window_seconds: 3600, end_at: Date.parse('2026-11-19T05:30:00Z') / 1000 },
    ]);
    expect(h.repos.db6.listByRequest(envelope.request_id)).toEqual([]);
    for (const leg of legs) {
      expect(leg).toMatchObject({ executor: 'chainlink-cre', fee: { amount: { value: '0.05' } }, limits: { max_per_run: { value: '10.05' }, max_total: { value: '20.1' } } });
      store.finishStep(envelope.request_id, leg.step, { status: 'executed', tx_hash: TX, executed_at: h.nowIso,
        report: { autopay: { autopay_id: leg.autopay_id, plan_id: planId(leg.step), executor_address: EXECUTOR, chain_id: BASE, token: 'USDC' } } }, h.nowIso, h.clock.toMillis());
    }
    await sender.kick();
    expect(store.allReports().every((r) => r.status === 'delivered')).toBe(true);
    const cancel = await confirm(h, await h.say('Stop paying Mihir'));
    expect(cancel.intents).toEqual(legs.map((leg, step) => ({ intent_id: 'l', step, autopay_id: leg.autopay_id, chain_id: BASE, plan_id: planId(leg.step) })));
  });

  it('counts each autopay slot and fee once, accepts two plan events in one transaction, and rejects identity or amount substitution', async () => {
    const { h, store, sender } = await connected(fixture('k', { frequency: 'weekly', days_of_week: ['MON', 'THU'] }));
    const env = await confirm(h, await h.say('Pay Mihir 10 usdc every Monday and Thursday for 4 payments on Base'));
    const legs = env.intents as AutopayK[];
    for (const leg of legs) store.finishStep(env.request_id, leg.step, { status: 'executed', executed_at: h.nowIso,
      report: { autopay: { autopay_id: leg.autopay_id, plan_id: planId(leg.step), executor_address: EXECUTOR, chain_id: BASE, token: 'USDC' } } }, h.nowIso, h.clock.toMillis());
    await sender.kick();
    const report = (leg: AutopayK): AutopayPaymentReport => ({ kind: 'autopay_payment', request_id: env.request_id,
      status: 'executed', tx_hash: TX, executed_at: h.nowIso, autopay: { autopay_id: leg.autopay_id, plan_id: planId(leg.step), executor_address: EXECUTOR,
        chain_id: BASE, token: 'USDC', slot: 0, status: 'active', amount: '10', fee: '0.05' } });
    for (const leg of legs) {
      const r = report(leg);
      expect(validateExecutionReport(r)).toBe(true);
      expect(await h.report(r)).toBe(204);
      expect(await h.report(r)).toBe(204);
    }
    const first = report(legs[0]!);
    expect(await h.report({ ...first, autopay: { ...first.autopay, amount: '11' } })).toBe(400);
    expect(await h.report({ ...first, autopay: { ...first.autopay, plan_id: planId(9) } })).toBe(404);
    expect(await h.report({ ...first, autopay: { ...first.autopay, slot: 2 } })).toBe(400);
    expect(await h.report({ ...first, request_id: 'req_000000000000' })).toBe(404);
    const rows = h.repos.db6.listByRequest(env.request_id);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([['autopay_payment', '10'], ['autopay_fee', '0.05'], ['autopay_payment', '10'], ['autopay_fee', '0.05']]);
  });

  it.each([['four_weeks', 2419200], ['thirty_days', 2592000]] as const)('asks before interpreting monthly as %s', async (choice, interval) => {
    const { h } = await connected(fixture('k', { frequency: 'monthly', day_of_month: 31 }));
    const question = await h.say('Pay Mihir 10 usdc every month on the 31st for 3 payments on Base');
    expect(question.body.question?.code).toBe('Q_AUTOPAY_MONTHLY');
    expect(h.exec.submissions).toEqual([]);
    const pending = await h.answer(question, { chip: choice });
    const envelope = await confirm(h, pending);
    expect((envelope.intents[0] as AutopayK).schedule).toMatchObject({ interval_seconds: interval, max_runs: 3 });
  });

  it('keeps UTC intervals across DST and requires fresh confirmation if the first slot passed', async () => {
    const { h } = await connected(fixture('k', { frequency: 'daily' }));
    // A separate session supplies the timezone; the injected clock remains deterministic.
    await h.open('America/New_York');
    h.clock = DateTime.fromISO('2026-10-30T12:00:00Z');
    const pending = await h.say('Pay Mihir 10 usdc daily for 4 payments on Base');
    expect(pending.body.summary?.notes).toContain('Times are fixed in UTC, so the local time shifts by an hour when daylight saving changes.');
    h.clock = DateTime.fromISO('2026-10-30T15:00:00Z');
    const late = await h.confirm(pending, 'yes');
    expect(late.body.question?.code).toBe('Q_AUTOPAY_START');
    expect(h.exec.submissions).toEqual([]);
  });
});
