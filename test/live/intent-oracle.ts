// Pure v2 expectations shared by the opt-in live evaluator and offline regression tests.
import { getAddress } from 'viem';
import { DateTime } from 'luxon';
import type { ChainId, HandoffEnvelope } from '../../src/contracts/types.js';
import { ARB, BASE, SEPOLIA, WALLET, addr, short, type Harness } from '../acceptance/harness.js';
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
export function summaryOk(ls: string[], plan: Json[], setup: Json): { ok: boolean; why: string } {
  const body = ls
    .filter((l) => !l.startsWith('Move '))
    .flatMap((line) => {
      if (!line.includes('in one atomic payment')) return [line];
      const chain = / on (.+?) in one atomic payment/.exec(line)?.[1];
      return [...line.matchAll(/([\d.]+) (USDC|ETH) to .*?\((0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})\)/g)].map(
        (m) => `Send ${m[1]} ${m[2]} to (${m[3]}) on ${chain}.`,
      );
    });
  const logical = plan;
  plan = plan.flatMap((p) =>
    p.t === 'k' && p.sched.days?.length > 1
      ? p.sched.days.map((day: string) => ({
          ...p,
          sched: { ...p.sched, days: [day], end: { ...p.sched.end, count: undefined } },
        }))
      : [p],
  );
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
          /^Pay ([\d.]+) (USDC|ETH) to .*\((0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4})\) (.*) on ([A-Za-z ]+?), first on/.exec(l);
        if (!m || m[3] !== s || !sameAmt(m[1]!, p.amt) || m[2] !== p.tok) return false;
        if (p.chain && m[5] !== CHAIN_NAME[CHAIN[p.chain]!]) return false;
        const sc = p.sched;
        if (sc.days && !sc.days.every((d: string) => m[4]!.includes(DAY[d]!))) return false;
        if (sc.end?.count !== undefined && !l.includes(`for ${sc.end.count} payments`)) return false;
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
  for (const p of logical.filter((p) => p.t === 'k' && p.sched.end?.count !== undefined)) {
    const matching = body.filter((line) => line.startsWith('Pay ') && line.includes(short(resolveAddr(p.to, setup))));
    const count = matching.reduce((sum, line) => sum + Number(/for (\d+) payments/.exec(line)?.[1] ?? 0), 0);
    if (count !== p.sched.end.count) return { ok: false, why: 'autopay run count mismatch' };
  }
  return { ok: true, why: '' };
}

/** Compares the handed-off envelope with the expected plan (j intents are not compared). */
export function envelopeDiff(env: HandoffEnvelope, plan: Json[], setup: Json, h: Harness): string[] {
  const diffs: string[] = [];
  // Flatten an atomic payment to logical payees; retain the full schedule on each recurring leg.
  const acts: Json[] = env.intents.flatMap<Json>((x) => {
    if (x.intent_id === 'j') return [];
    if (x.intent_id === 'l') {
      const row = h.repos.db7.get(x.autopay_id as `ap_${string}`);
      if (!row || row.plan_id !== x.plan_id) diffs.push('cancel plan identity mismatch');
      return [{ ...x, recipient: row?.recipient_address }];
    }
    return x.recipients.map((p) => ({ ...x, recipient: p.recipient, amount: p.amount }));
  });
  const used = new Set<number>();
  for (const p of plan) {
    const rec = resolveAddr(p.to, setup).toLowerCase();
    const candidates = acts
      .map((a, index) => ({ a, index }))
      .filter(
        ({ a, index }) =>
          !used.has(index) &&
          a.intent_id === p.t &&
          String(a.recipient).toLowerCase() === rec &&
          (!p.chain || a.chain_id === CHAIN[p.chain]) &&
          (p.t === 'l' || (a.token === p.tok && sameAmt(a.amount.value, p.amt))),
      );
    const matched = p.t === 'k' ? candidates : candidates.slice(0, 1);
    if (!matched.length) {
      diffs.push(`missing ${JSON.stringify(p)}`);
      continue;
    }
    matched.forEach(({ index }) => used.add(index));
    if (p.t !== 'k') continue;
    const sc = p.sched;
    const interval = (sc.freq === 'daily' ? 86400 : 604800) * sc.interval;
    if (matched.length !== (sc.days?.length ?? 1)) diffs.push('autopay leg count mismatch');
    const days = matched
      .map(({ a }) => DateTime.fromSeconds(a.schedule.start_at, { zone: 'Asia/Kolkata' }).toFormat('ccc').toUpperCase())
      .sort();
    if (sc.days && JSON.stringify(days) !== JSON.stringify([...sc.days].sort()))
      diffs.push('autopay weekdays mismatch');
    if (sc.end?.count !== undefined && matched.reduce((sum, { a }) => sum + a.schedule.max_runs, 0) !== sc.end.count)
      diffs.push('autopay run count mismatch');
    for (const { a } of matched) {
      const s = a.schedule;
      if (s.interval_seconds !== interval) diffs.push('autopay interval mismatch');
      if (sc.end?.date) {
        const end = DateTime.fromISO(sc.end.date, { zone: 'Asia/Kolkata' }).endOf('day').toSeconds();
        const expectedRuns = Math.floor((end - s.start_at) / interval) + 1;
        if (s.max_runs !== expectedRuns) diffs.push('autopay end date mismatch');
      }
      const perRun = a.recipients.reduce(
        (sum: bigint, r: Json) => sum + BigInt(r.amount.base_units),
        BigInt(a.fee.amount.base_units),
      );
      if (
        BigInt(a.limits.max_per_run.base_units) !== perRun ||
        BigInt(a.limits.max_total.base_units) !== perRun * BigInt(s.max_runs)
      )
        diffs.push('autopay caps omit recipients or fees');
    }
  }
  acts.forEach((a, n) => {
    if (!used.has(n)) diffs.push(`unexpected ${JSON.stringify(a)}`);
  });
  return diffs;
}
