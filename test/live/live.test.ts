// Live-model evaluation (spec §20.3). Runs the acceptance prompts and 100 paraphrases (test/live/prompts.json)
// through the real pipeline with the real local Ollama client (createOllamaClient). RPC / ENS / indexer / fetcher /
// execution stay the acceptance fakes. A simulated user answers scripted questions, rejects any summary that does
// not match the expected plan, and confirms the rest; the envelope handed to the execution fake is then compared
// with the expected plan (any difference = WRONG HAND-OFF, which must never happen).
//
// Env: LIVE_SET=acceptance|paraphrase|all (default all), LIVE_IDS (comma-separated IDs),
// LIVE_FROM / LIVE_TO (slice within the selected set), LIVE_TAG.
// Results: test/live/results/<tag>.json (all entries, incremental). Test data only, never user data.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import type { LlmCallArgs } from '../../src/contracts/llm.js';
import { LlmFailed } from '../../src/contracts/llm.js';
import type { ChainId, HandoffEnvelope, Question } from '../../src/contracts/types.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { ARB, BASE, Harness, SEPOLIA, WALLET, addr, coinType, lines, short, type Resp } from '../acceptance/harness.js';
import { seedAutopay, seedSpend, weeklySchedule } from '../acceptance/seed.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const CHAIN: Record<string, ChainId> = { sepolia: SEPOLIA, base: BASE, arb: ARB };
const CHAIN_NAME: Record<number, string> = { [SEPOLIA]: 'Sepolia', [BASE]: 'Base Sepolia', [ARB]: 'Arbitrum Sepolia' };
const DAY: Record<string, string> = {
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
};

const SET = process.env.LIVE_SET ?? 'all';
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

const norm = (v: string): string => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const sameAmt = (a: string, b: string): boolean => norm(String(a)) === norm(String(b));

function resolveAddr(to: string, setup: Json): string {
  if (to === 'wallet') return WALLET;
  if (to.startsWith('addr:')) return addr(Number(to.slice(5)));
  if (to.startsWith('hex:')) return getAddress(to.slice(4));
  if (to === 'Aradhya') return getAddress('0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E'.toLowerCase());
  if (to === 'Mihir') return getAddress('0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0'.toLowerCase());
  const c = (setup.contacts ?? []).find((x: Json) => x.name === to);
  if (c) return addr(c.addr);
  throw new Error(`cannot resolve ${to}`);
}

/** The simulated user's reading of the summary: does it show exactly the expected plan? */
function summaryOk(ls: string[], plan: Json[], setup: Json): { ok: boolean; why: string } {
  const body = ls.filter((l) => !l.startsWith('Move '));
  const ensName = new Map<string, string>((setup.ens ?? []).map((x: Json) => [addr(x.addr), x.name]));
  const group = body.find((l) => / members? of /.test(l));
  if (group) {
    const items = plan.filter((p) => p.t === 'i');
    const m = /^Send ([\d.]+) (USDC|ETH) each to (\d+) members? of /.exec(group);
    if (!m || body.length !== 1) return { ok: false, why: `group line ${group}` };
    const names = items.map((p) => ensName.get(resolveAddr(p.to, setup)) ?? '?');
    const ok =
      sameAmt(m[1]!, items[0]!.amt) &&
      m[2] === items[0]!.tok &&
      Number(m[3]) === items.length &&
      names.every((n) => group.includes(n));
    return { ok, why: ok ? '' : `group mismatch: ${group}` };
  }
  if (body.length !== plan.length) return { ok: false, why: `line count ${body.length} != ${plan.length}` };
  const used = new Set<number>();
  for (const p of plan) {
    const s = p.to ? short(resolveAddr(p.to, setup)) : '';
    const idx = body.findIndex((l, n) => {
      if (used.has(n)) return false;
      if (p.t === 'i') {
        const m = /^Send ([\d.]+) (USDC|ETH) to .*\((0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})\) on (.+?)\./.exec(l);
        return (
          !!m &&
          sameAmt(m[1]!, p.amt) &&
          m[2] === p.tok &&
          m[3] === s &&
          (!p.chain || m[4] === CHAIN_NAME[CHAIN[p.chain]!])
        );
      }
      if (p.t === 'k') {
        const m =
          /^Pay .*\((0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})\) ([\d.]+) (USDC|ETH) (.*) on ([A-Za-z ]+?), first on/.exec(l);
        if (!m || m[1] !== s || !sameAmt(m[2]!, p.amt) || m[3] !== p.tok) return false;
        if (p.chain && m[5] !== CHAIN_NAME[CHAIN[p.chain]!]) return false;
        const sc = p.sched;
        if (sc.days && !sc.days.every((d: string) => m[4]!.includes(DAY[d]!))) return false;
        if (sc.end?.type === 'after_count' && !l.includes(`for ${sc.end.count} payments`)) return false;
        if (sc.freq === 'daily' && !/every day|daily/i.test(m[4]!)) return false;
        // The reader also checks the repeat interval: "every 4 weeks" is not "every Monday".
        const iv = /every (\d+) (day|week|month)s?/.exec(m[4]!);
        if ((sc.interval ?? 1) === 1 ? iv !== null : !iv || Number(iv[1]) !== sc.interval) return false;
        return true;
      }
      return /^Stop paying /.test(l) && (!/^[A-Z]/.test(p.to) || l.includes(p.to));
    });
    if (idx < 0) return { ok: false, why: `no line for ${JSON.stringify(p)}` };
    used.add(idx);
  }
  return { ok: true, why: '' };
}

/** Compares the handed-off envelope with the expected plan (j intents are not compared). */
function envelopeDiff(env: HandoffEnvelope, plan: Json[], setup: Json): string[] {
  const diffs: string[] = [];
  const acts = (env.intents as Json[]).filter((x) => x.intent_id !== 'j');
  const used = new Set<number>();
  for (const p of plan) {
    const rec = resolveAddr(p.to, setup).toLowerCase();
    const idx = acts.findIndex((a, n) => {
      if (used.has(n) || a.intent_id !== p.t || String(a.recipient).toLowerCase() !== rec) return false;
      if (
        p.t !== 'l' &&
        (a.token !== p.tok || !sameAmt(p.t === 'i' ? a.amount.value : a.amount_per_payment.value, p.amt))
      )
        return false;
      if (p.chain && a.chain_id !== CHAIN[p.chain]) return false;
      if (p.t === 'k') {
        const sc = p.sched,
          s = a.schedule;
        if (s.frequency !== sc.freq || s.interval !== sc.interval) return false;
        if (sc.days && JSON.stringify([...(s.days_of_week ?? [])].sort()) !== JSON.stringify([...sc.days].sort()))
          return false;
        if (sc.dom !== undefined && s.day_of_month !== sc.dom) return false;
        if (s.end.type !== sc.end.type) return false;
        if (sc.end.count !== undefined && s.end.count !== sc.end.count) return false;
        if (sc.end.date !== undefined && s.end.date !== sc.end.date) return false;
      }
      return true;
    });
    if (idx < 0) diffs.push(`missing ${JSON.stringify(p)}`);
    else used.add(idx);
  }
  acts.forEach((a, n) => {
    if (!used.has(n))
      diffs.push(
        `unexpected ${JSON.stringify({ i: a.intent_id, tok: a.token, to: a.recipient, chain: a.chain_id, amt: a.amount?.value ?? a.amount_per_payment?.value })}`,
      );
  });
  return diffs;
}

interface Rec {
  name: string;
  ms: number;
  user: string;
  output?: unknown;
  error?: string;
}

async function runEntry(e: Json): Promise<Json> {
  const setup: Json = e.setup ?? {};
  const t00 = Date.now();
  const h = new Harness(`live-${e.id}`, { calls: [] }, { balances: setup.balances });
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
      recs.push({ name: args.name, ms: Date.now() - t0, user: args.user, output: out });
      return out;
    } catch (err) {
      recs.push({
        name: args.name,
        ms: Date.now() - t0,
        user: args.user,
        error: err instanceof LlmFailed ? 'LlmFailed' : String(err),
      });
      throw err;
    }
  };
  const res: Json = { id: e.id, source: e.source, prompt: e.prompt, expected: e.expected };
  const asked: string[] = [];
  let r: Resp | undefined;
  let targetTraceStart: number | null = null;
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
      const d = envelopeDiff(h.envelope, pr.expected.plan, setup);
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
        const diffs = envelopeDiff(h.exec.submissions[h.exec.submissions.length - 1]!.envelope, exp.plan, setup);
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
    res.llm_ms = recs.map((x) => x.ms);
    res.llm_retries = logEvents.filter((x) => x.llm_retry === true).length;
    res.llm_failures = logEvents.filter((x) => x.event === 'llm_call_failed').length;
    res.model_failed = res.final_code === 'MODEL_FAILED';
    res.total_ms ??= Date.now() - t00;
    const bad = res.outcome !== 'exact' || (res.pairing_reached && !res.pairing_exact) || res.llm_retries > 0;
    if (bad || res.unexpected_stop)
      res.llm_trace = recs.map((x) => ({ name: x.name, ms: x.ms, user: x.user, output: x.output, error: x.error }));
    await h.finish({ allowUnused: true }).catch(() => undefined);
  }
  return res;
}

describe(`live model evaluation [${TAG}]`, () => {
  it('model is available', async () => {
    const r = await fetch('http://127.0.0.1:11434/api/tags');
    const j = (await r.json()) as { models: Array<{ name: string }> };
    expect(j.models.some((m) => m.name === 'qwen2.5:7b-instruct')).toBe(true);
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
