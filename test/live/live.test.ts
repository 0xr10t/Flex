// Live-model evaluation (spec §20.3). Runs the acceptance prompts and 100 paraphrases (test/live/prompts.json)
// through the real pipeline with the real local Ollama client (createOllamaClient). RPC / ENS / indexer / fetcher /
// execution stay the acceptance fakes. A simulated user answers scripted questions, rejects any summary that does
// not match the expected plan, and confirms the rest; the envelope handed to the execution fake is then compared
// with the expected plan (any difference = WRONG HAND-OFF, which must never happen).
//
// Env: LIVE_SET=acceptance|paraphrase|all (default all), LIVE_IDS (comma-separated IDs),
// LIVE_FROM / LIVE_TO (slice within the selected set), LIVE_TAG, LIVE_MODEL, LIVE_THINK=true|false, LIVE_CHAT=true|false.
// Results: test/live/results/<tag>.json (all entries, incremental). Test data only, never user data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import { LlmFailed } from '../../src/contracts/llm.js';
import type { ChainId, Question } from '../../src/contracts/types.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { ARB, BASE, Harness, SEPOLIA, WALLET, addr, coinType, lines, type Resp } from '../acceptance/harness.js';
import { seedAutopay, seedSpend, weeklySchedule } from '../acceptance/seed.js';
import { testConfig } from '../fakes/context.js';
import { liveChatConfig, liveModelConfig } from './model-config.js';
import { summaryOk, envelopeDiff } from './intent-oracle.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const CHAIN: Record<string, ChainId> = { sepolia: SEPOLIA, base: BASE, arb: ARB };

const SET = process.env.LIVE_SET ?? 'all';
const MODEL_CONFIG = liveModelConfig(testConfig().llm);
const CHAT_CONFIG = liveChatConfig(testConfig().chat);
const ALL = JSON.parse(readFileSync(join(import.meta.dirname, 'prompts.json'), 'utf8')) as Json[];
let entries = ALL.filter((e) => SET === 'all' || e.source === SET);
if (process.env.LIVE_IDS !== undefined) {
  const ids = process.env.LIVE_IDS.split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  const missing = ids.filter((id) => !entries.some((entry) => entry.id === id));
  if (ids.length === 0 || missing.length > 0) throw new Error(`Invalid LIVE_IDS selection: ${missing.join(', ')}`);
  const selected = new Set(ids);
  entries = entries.filter((entry) => selected.has(String(entry.id)));
}
entries = entries.slice(
  Number(process.env.LIVE_FROM ?? 0),
  process.env.LIVE_TO ? Number(process.env.LIVE_TO) : undefined,
);
const TAG = process.env.LIVE_TAG ?? `${SET}-${process.env.LIVE_FROM ?? 0}`;
const RESULTS = join(import.meta.dirname, 'results');
mkdirSync(RESULTS, { recursive: true });
const done: Json[] = [];

interface Rec {
  name: string;
  think?: boolean;
  ms: number;
  user: string;
  output?: unknown;
  error?: string;
}

async function runEntry(e: Json): Promise<Json> {
  const setup: Json = e.setup ?? {};
  const t00 = Date.now();
  const h = new Harness(`live-${e.id}`, { calls: [] }, { balances: setup.balances });
  h.config.llm = { ...MODEL_CONFIG };
  if (CHAT_CONFIG !== undefined) h.config.chat = { ...CHAT_CONFIG };
  const recs: Rec[] = [];
  const logEvents: Json[] = [];
  const real = createOllamaClient(h.config, {
    info: (f) => void logEvents.push(f as Json),
    warn: (f) => void logEvents.push(f as Json),
    error: (f) => void logEvents.push(f as Json),
  });
  const llm = h.llm as unknown as { call: unknown; modelAvailable: unknown };
  llm.modelAvailable = async () => true;
  llm.call = async (args: LlmCallArgs) => {
    const t0 = Date.now();
    try {
      const out = await real.call(args);
      recs.push({
        name: args.name,
        think: args.think ?? h.config.llm.think,
        ms: Date.now() - t0,
        user: args.user,
        output: out,
      });
      return out;
    } catch (err) {
      recs.push({
        name: args.name,
        think: args.think ?? h.config.llm.think,
        ms: Date.now() - t0,
        user: args.user,
        error: err instanceof LlmFailed ? 'LlmFailed' : String(err),
      });
      throw err;
    }
  };
  const res: Json = {
    id: e.id,
    source: e.source,
    prompt: e.prompt,
    expected: e.expected,
    llm_config: h.config.llm,
    chat_config: h.config.chat,
  };
  const asked: string[] = [];
  let r: Resp | undefined;
  let targetTraceStart: number | null = null;
  let targetRpcStart: number | null = null;
  try {
    // setup
    for (const c of setup.contacts ?? [])
      h.addContact(
        c.name,
        addr(c.addr),
        c.chains.map((x: string) => CHAIN[x]!),
        c.ens ?? null,
      );
    for (const x of setup.ens ?? []) {
      if ((setup.noEnsFor ?? []).includes(x.name)) continue;
      for (const c of x.chains) h.ens.set(x.name, coinType(CHAIN[c]!), addr(x.addr));
    }
    for (const [p, kids] of Object.entries(setup.subnames ?? {})) h.subnames.children.set(p, kids as string[]);
    for (const s of setup.spend ?? []) {
      const pend = s.status === 'pending';
      if (s.minAgo) h.advance(-s.minAgo);
      seedSpend(
        h,
        pend ? { amount: s.amount, status: 'pending', executed_at: null, tx_hash: null } : { amount: s.amount },
      );
      if (s.minAgo) h.advance(s.minAgo);
    }
    for (const a of setup.autopays ?? []) {
      const first = a.first ?? '2026-11-06T04:30:00Z';
      const sch = a.daily
        ? { ...weeklySchedule(['MON'], first), frequency: 'daily', days_of_week: null }
        : weeklySchedule(a.days ?? ['FRI'], first);
      seedAutopay(h, { ...(a.id ? { id: a.id } : {}), amount: a.amount, chain: CHAIN[a.chain]!, schedule: sch });
    }
    for (const c of setup.rpcDown ?? []) h.rpc.down.add(CHAIN[c]!);
    await h.open();
    if (setup.raiseLimit) {
      const limits = (await h.http('GET', '/v1/settings/limits')).json;
      await h.http('PUT', '/v1/settings/limits', { body: { ...limits, per_tx_max: { USDC: '150', ETH: '0.05' } } });
    }
    for (const pr of setup.prior ?? []) {
      const pr1 = await h.say(pr.prompt);
      if (pr1.body.state !== 'awaiting_confirmation')
        throw new Error(`prior prompt did not reach a summary: ${pr1.body.state}`);
      await h.confirm(pr1, 'yes');
      const d = envelopeDiff(h.envelope, pr.expected.plan, setup, h);
      if (d.length) {
        res.outcome = 'wrong_handoff';
        res.diff = d.map((x) => `[prior] ${x}`);
        return res;
      }
    }
    if (setup.advanceMin) h.advance(setup.advanceMin);
    if (setup.balancesAfterPrior) h.setBalances(setup.balancesAfterPrior);
    const submittedBefore = h.exec.submissions.length;

    const text = (e.prompt as string).replace('{WALLET}', WALLET);
    const extra: Json = {};
    if (setup.pasted) extra.pasted_blocks = setup.pasted;
    if (setup.urls) extra.urls = setup.urls;
    if (setup.attachments) extra.attachments = setup.attachments;
    const t0 = Date.now();
    targetTraceStart = recs.length;
    targetRpcStart = h.rpc.calls.length;
    r = await h.say(text, extra);
    res.first_latency_ms = Date.now() - t0;
    const queue: Json[] = [...(e.answers ?? [])];
    let stopNote = '';
    while (r.body.question) {
      const q: Question = r.body.question;
      asked.push(q.code);
      const idx = queue.findIndex((a) => a.code === q.code);
      if (idx < 0) break;
      const a = queue.splice(idx, 1)[0]!;
      try {
        r = await h.answer(
          r,
          a.chip !== undefined
            ? { chipLabel: a.chip }
            : a.text !== undefined
              ? { text: a.text }
              : { selectedLabels: a.selected },
        );
      } catch (err) {
        stopNote = `scripted answer unusable: ${String(err).slice(0, 200)}`;
        break;
      }
    }
    if (stopNote) res.stop_note = stopNote;
    res.questions = asked;
    res.total_ms = Date.now() - t00;
    const exp = e.expected as Json;
    const code = r.body.question?.code ?? r.body.error?.code;
    const matchOutcome = (): boolean => {
      const o = exp.outcome;
      if (!o) return false;
      if (o.kind === 'stop') return h.exec.submissions.length === submittedBefore;
      if (o.kind === 'balance')
        return r!.body.state === 'done' && /^Your balances:/.test(r!.body.messages[0]?.text ?? '');
      return code !== undefined && (o.codes ?? [o.code]).includes(code);
    };
    res.final_state = r.body.state;
    res.final_code = code ?? null;
    if (r.body.state === 'awaiting_confirmation') {
      const ls = lines(r);
      res.summary = r.body.summary?.text;
      const j = exp.plan ? summaryOk(ls, exp.plan, setup) : { ok: false, why: 'no hand-off expected' };
      if (!j.ok) {
        await h.confirm(r, 'no');
        res.outcome = 'rejected_summary';
        res.why = j.why;
      } else {
        await h.confirm(r, 'yes');
        const diffs = envelopeDiff(h.exec.submissions[h.exec.submissions.length - 1]!.envelope, exp.plan, setup, h);
        res.outcome = diffs.length ? 'wrong_handoff' : 'exact';
        if (diffs.length) res.diff = diffs;
      }
    } else if (h.exec.submissions.length > submittedBefore) {
      res.outcome = 'wrong_handoff';
      res.diff = ['handed off without confirmation'];
    } else if (matchOutcome()) {
      res.outcome = 'exact';
      res.expected_outcome = true;
    } else {
      res.outcome = 'acceptable_stop';
      res.unexpected_stop = true;
    }
  } catch (err) {
    res.outcome = 'crash';
    res.error = String(err instanceof Error ? err.stack : err).slice(0, 800);
  } finally {
    const pay = recs.filter((x) => x.name === 'payments');
    res.pairing_reached = pay.length > 0;
    res.pairing_exact = pay.length > 0 && !pay.some((x) => x.user.includes('CORRECTION:')) && !pay.some((x) => x.error);
    res.target_trace_start = targetTraceStart;
    const targetPay =
      targetTraceStart === null ? null : recs.slice(targetTraceStart).filter((x) => x.name === 'payments');
    res.target_pairing_reached = targetPay === null ? null : targetPay.length > 0;
    res.target_pairing_exact =
      targetPay === null
        ? null
        : targetPay.length > 0 &&
          !targetPay.some((x) => x.user.includes('CORRECTION:')) &&
          !targetPay.some((x) => x.error);
    res.llm_calls = recs.length;
    // Additive evidence for chat routing and per-call thinking; the historical outcome oracle is unchanged.
    res.model_calls = recs.map((x) => ({
      name: x.name,
      think: x.think,
      ...(x.name === 'chat_route' || x.name === 'chat' || x.name === 'request_type' ? { output: x.output } : {}),
      error: x.error,
    }));
    res.final_response = r?.body;
    res.target_rpc_calls = targetRpcStart === null ? null : h.rpc.calls.slice(targetRpcStart);
    res.llm_ms = recs.map((x) => x.ms);
    res.llm_retries = logEvents.filter((x) => x.llm_retry === true).length;
    res.llm_failures = logEvents.filter((x) => x.event === 'llm_call_failed').length;
    res.model_failed = res.final_code === 'MODEL_FAILED';
    res.total_ms ??= Date.now() - t00;
    const bad = res.outcome !== 'exact' || (res.pairing_reached && !res.pairing_exact) || res.llm_retries > 0;
    if (bad || res.unexpected_stop)
      res.llm_trace = recs.map((x) => ({
        name: x.name,
        think: x.think,
        ms: x.ms,
        user: x.user,
        output: x.output,
        error: x.error,
      }));
    await h.finish({ allowUnused: true }).catch(() => undefined);
  }
  return res;
}

describe(`live model evaluation [${TAG}]`, () => {
  it('model is available', async () => {
    const r = await fetch(`${MODEL_CONFIG.ollama_url}/api/tags`);
    const j = (await r.json()) as { models: Array<{ name: string }> };
    expect(j.models.some((m) => m.name === MODEL_CONFIG.model)).toBe(true);
  });
  for (const e of entries) {
    it(`${e.id}: ${e.prompt}`, async () => {
      const res = await runEntry(e);
      done.push(res);
      writeFileSync(join(RESULTS, `${TAG}.json`), JSON.stringify(done, null, 1));
      // Hard invariant of §20.3: no wrong hand-off. Other outcomes are measured, not asserted.
      expect(res.outcome, JSON.stringify(res.diff ?? res.error ?? '')).not.toBe('wrong_handoff');
    });
  }
});
