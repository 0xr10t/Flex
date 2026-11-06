// Implements: §13.1 summary built by code from real DB1/DB3/DB7 values: every line template ({Name}, {cadence},
// {end text}, group collapse, " After step {n}."), the notes S11 emits ("You wrote …", "From attached content …"),
// the footer per token and the "Please confirm:" / "Confirm?" frame. UI only (§16.2).

import { DateTime } from 'luxon';
import { NOTES, SUMMARY_FRAME } from '../contracts/catalog.js';
import { normalizeDecimal, shortAddress } from '../contracts/money.js';
import type { StepContext } from '../contracts/step.js';
import type {
  AddressPh,
  AmountPh,
  GroupPh,
  InternalIntent,
  PlanI,
  PlanJ,
  PlanK,
  PlanL,
  Schedule,
  Summary,
  Weekday,
} from '../contracts/types.js';
import {
  chainName,
  db1BaseUnits,
  decimalsOf,
  fmt,
  joinAnd,
  pushNote,
  recipientName,
  recipientNameOf,
} from '../plan/common.js';
import { spentToday, thisRequest, tokensUsed } from '../plan/limits.js';
import { CADENCE, END_TEXT, SUMMARY_LINE } from './templates.js';

const DAY_NAME: Record<Weekday, string> = {
  MON: 'Mon',
  TUE: 'Tue',
  WED: 'Wed',
  THU: 'Thu',
  FRI: 'Fri',
  SAT: 'Sat',
  SUN: 'Sun',
};

/** SQ-D-04: 1st, 2nd, 3rd, 4th … 28th. */
function ordinal(d: number): string {
  if (d >= 11 && d <= 13) return `${d}th`;
  const suffix = d % 10 === 1 ? 'st' : d % 10 === 2 ? 'nd' : d % 10 === 3 ? 'rd' : 'th';
  return `${d}${suffix}`;
}

/** §13.1 {cadence}. */
export function cadenceText(s: Schedule): string {
  const n = String(s.interval);
  if (s.frequency === 'daily') return s.interval === 1 ? CADENCE.DAILY() : CADENCE.DAILY_N({ n });
  if (s.frequency === 'weekly') {
    const days = joinAnd((s.days_of_week ?? []).map((d) => DAY_NAME[d]));
    return s.interval === 1 ? CADENCE.WEEKLY({ days }) : CADENCE.WEEKLY_N({ n, days });
  }
  const d = ordinal(s.day_of_month ?? 1);
  return s.interval === 1 ? CADENCE.MONTHLY({ d }) : CADENCE.MONTHLY_N({ n, d });
}

function displayDate(dt: DateTime): string {
  return dt.setLocale('en-GB').toFormat('d MMM yyyy');
}

/** §13.1 {end text}. */
function endText(ctx: StepContext, s: Schedule): string {
  const end = s.end;
  if (end.type === 'after_count') return END_TEXT.COUNT({ n: String(end.count) });
  if (end.type === 'on_date') return END_TEXT.DATE({ date: displayDate(DateTime.fromISO(end.date)) });
  return END_TEXT.CANCEL({ weeks: String(ctx.limits.autopay_max_weeks) });
}

function address(ctx: StepContext, ph: AddressPh): string {
  const a = ctx.repos.db3.get(ph)?.address;
  if (!a) throw new Error('db3 address missing');
  return shortAddress(a);
}

function displayAmount(ctx: StepContext, ph: AmountPh): string {
  const { units, token } = db1BaseUnits(ctx, ph);
  return fmt(units, token);
}

function lineJ(ctx: StepContext, it: PlanJ): string {
  return SUMMARY_LINE.J({
    padded: displayAmount(ctx, it.amount),
    token: it.token,
    source: chainName(ctx, it.source_chain_id),
    dest: chainName(ctx, it.dest_chain_id),
    b: ctx.limits.bridge_buffer_pct,
  });
}

function lineI(ctx: StepContext, it: PlanI): string {
  const base = SUMMARY_LINE.I({
    amount: displayAmount(ctx, it.amount),
    token: it.token,
    name: recipientNameOf(ctx, it.recipient),
    addr: address(ctx, it.recipient),
    chain: chainName(ctx, it.chain_id),
  });
  if (it.depends_on.length === 0) return base;
  // Bridges come first and are never collapsed, so step s is line s + 1 (SQ-D-03 for several steps).
  return base + SUMMARY_LINE.AFTER_STEP({ n: joinAnd(it.depends_on.map((s) => String(s + 1))) });
}

function lineGroup(ctx: StepContext, group: GroupPh, members: PlanI[]): string {
  const first = members[0] as PlanI;
  return SUMMARY_LINE.I_GROUP({
    amount: displayAmount(ctx, first.amount),
    token: first.token,
    count: String(members.length),
    parent: ctx.repos.db3.get(group)?.name ?? '',
    chain: chainName(ctx, first.chain_id),
    names: members.map((m) => ctx.repos.db3.get(m.recipient)?.name ?? '').join(', '),
  });
}

function lineK(ctx: StepContext, it: PlanK): string {
  const s = it.schedule;
  const first = DateTime.fromISO(s.first_occurrence, { setZone: true }).setZone(s.timezone);
  return SUMMARY_LINE.K({
    name: recipientNameOf(ctx, it.recipient),
    addr: address(ctx, it.recipient),
    amount: displayAmount(ctx, it.amount_per_payment),
    token: it.token,
    cadence: cadenceText(s),
    time: s.time_of_day,
    timezone: s.timezone,
    chain: chainName(ctx, it.chain_id),
    first: displayDate(first),
    end: endText(ctx, s),
    total_cap: displayAmount(ctx, it.limits.total_cap),
  });
}

function lineL(ctx: StepContext, it: PlanL): string {
  const row = ctx.repos.db7.get(it.autopay_id);
  if (!row) throw new Error('db7 row missing');
  return SUMMARY_LINE.L({
    name: recipientName(ctx, ctx.repos.db3.get(it.recipient)) || row.recipient_name,
    amount: normalizeDecimal(row.amount_per_payment, decimalsOf(row.token)),
    token: row.token,
    cadence: cadenceText(JSON.parse(row.schedule_json) as Schedule),
    chain: chainName(ctx, it.chain_id),
  });
}

function groupOf(ctx: StepContext, it: PlanI): GroupPh | null {
  const row = ctx.repos.db3.get(it.recipient);
  return row?.kind === 'member' ? row.group_placeholder : null;
}

/** One numbered line per intent in step order; a group's expanded `i` intents collapse into one line. */
function buildLines(ctx: StepContext, plan: InternalIntent[]): string[] {
  const texts: string[] = [];
  for (let n = 0; n < plan.length; n++) {
    const it = plan[n] as InternalIntent;
    if (it.intent_id === 'j') texts.push(lineJ(ctx, it));
    else if (it.intent_id === 'k') texts.push(lineK(ctx, it));
    else if (it.intent_id === 'l') texts.push(lineL(ctx, it));
    else {
      const group = groupOf(ctx, it);
      if (group === null) {
        texts.push(lineI(ctx, it));
        continue;
      }
      const members = [it];
      for (let next = plan[n + 1]; next?.intent_id === 'i' && groupOf(ctx, next) === group; next = plan[n + 1]) {
        members.push(next);
        n++;
      }
      texts.push(lineGroup(ctx, group, members));
    }
  }
  return texts.map((t, i) => `${i + 1}. ${t}`);
}

/** The §13.1 notes that depend on what the plan finally uses; the other steps collected theirs in req.notes. */
function addPlanNotes(ctx: StepContext, plan: InternalIntent[]): void {
  const { req, repos } = ctx;
  const paid = plan.flatMap((it) =>
    it.intent_id === 'i'
      ? [{ amount: it.amount, recipient: it.recipient }]
      : it.intent_id === 'k'
        ? [{ amount: it.amount_per_payment, recipient: it.recipient }]
        : [],
  );
  const used = new Set(paid.map((p) => p.amount));
  for (const a of req.amounts) {
    if (!used.has(a.placeholder)) continue;
    const unverified = !a.code_verified || a.relative !== null || a.fiat === 'USD';
    if (!unverified || a.phrase === null) continue;
    const { token } = db1BaseUnits(ctx, a.placeholder);
    pushNote(ctx, NOTES.YOU_WROTE({ phrase: a.phrase, amount: displayAmount(ctx, a.placeholder), token }));
  }
  // SQ-D-10, worded as §19 E9: one note per payment that uses an untrusted amount or recipient,
  // "From attached content: 120 USDC to 0xAAAA…1111. You confirmed it."
  for (const p of paid) {
    if (repos.db1.get(p.amount)?.source !== 'untrusted' && repos.db3.get(p.recipient)?.source !== 'untrusted') continue;
    const { token } = db1BaseUnits(ctx, p.amount);
    const what = `${displayAmount(ctx, p.amount)} ${token} to ${address(ctx, p.recipient)}`;
    pushNote(ctx, NOTES.FROM_CONTENT({ what }));
  }
}

function buildFooter(ctx: StepContext, plan: InternalIntent[]): string[] {
  return tokensUsed(plan).map((token) =>
    SUMMARY_FRAME.FOOTER_SPENT({
      spent: fmt(spentToday(ctx, token) + thisRequest(ctx, plan, token), token),
      daily_max: normalizeDecimal(ctx.limits.daily_max[token], decimalsOf(token)),
      token,
    }),
  );
}

export function buildSummary(ctx: StepContext, plan: InternalIntent[]): Summary {
  addPlanNotes(ctx, plan);
  const lines = buildLines(ctx, plan);
  const notes = [...ctx.req.notes];
  const footer = buildFooter(ctx, plan);
  const text = [
    SUMMARY_FRAME.HEADER(),
    ...lines,
    ...notes.map((n) => `- ${n}`),
    ...footer,
    SUMMARY_FRAME.CONFIRM(),
  ].join('\n');
  return { text, lines, notes, footer };
}
