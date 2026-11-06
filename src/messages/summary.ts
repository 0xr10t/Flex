// Implements: §13.1 summary built by code from real DB1/DB3/DB7 values: every line template ({Name}, {cadence},
// {end text}, group collapse, " After step {n}."), the notes S11 emits ("You wrote …", "From attached content …"),
// the footer per token and the "Please confirm:" / "Confirm?" frame. UI only (§16.2).

import { DateTime } from 'luxon';
import { NOTES, SUMMARY_FRAME, joinList } from '../contracts/catalog.js';
import { normalizeDecimal, shortAddress } from '../contracts/money.js';
import type { StepContext } from '../contracts/step.js';
import type {
  AddressPh,
  AmountPh,
  InternalIntent,
  PlanI,
  PlanJ,
  PlanK,
  PlanL,
  CalendarSchedule,
  EnvelopeK,
  Summary,
  Weekday,
} from '../contracts/types.js';
import { chainName } from '../pipeline/step-util.js';
import { db1BaseUnits, decimalsOf, fmt, pushNote, recipientName, recipientNameOf } from '../plan/common.js';
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
export function cadenceText(s: CalendarSchedule): string {
  const n = String(s.interval);
  if (s.frequency === 'daily') return s.interval === 1 ? CADENCE.DAILY() : CADENCE.DAILY_N({ n });
  if (s.frequency === 'weekly') {
    const days = joinList((s.days_of_week ?? []).map((d) => DAY_NAME[d]));
    return s.interval === 1 ? CADENCE.WEEKLY({ days }) : CADENCE.WEEKLY_N({ n, days });
  }
  const d = ordinal(s.day_of_month ?? 1);
  return s.interval === 1 ? CADENCE.MONTHLY({ d }) : CADENCE.MONTHLY_N({ n, d });
}

function displayDate(dt: DateTime): string {
  return dt.setLocale('en-GB').toFormat('d MMM yyyy');
}

/** §13.1 {end text}. */
function endText(ctx: StepContext, s: CalendarSchedule): string {
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
    source: chainName(ctx.config, it.source_chain_id),
    dest: chainName(ctx.config, it.dest_chain_id),
    b: ctx.limits.bridge_buffer_pct,
    fee: it.fee_max_eth,
  });
}

function lineI(ctx: StepContext, it: PlanI): string {
  const first = it.recipients[0]!;
  const group = ctx.repos.db3.get(first.recipient)?.group_placeholder;
  const sameGroup =
    group &&
    it.recipients.every(
      (p) => ctx.repos.db3.get(p.recipient)?.group_placeholder === group && p.amount === first.amount,
    );
  const base =
    it.recipients.length === 1
      ? SUMMARY_LINE.I({
          amount: displayAmount(ctx, first.amount),
          token: it.token,
          name: recipientNameOf(ctx, first.recipient),
          addr: address(ctx, first.recipient),
          chain: chainName(ctx.config, it.chain_id),
        })
      : sameGroup
        ? SUMMARY_LINE.I_GROUP({
            amount: displayAmount(ctx, first.amount),
            token: it.token,
            count: String(it.recipients.length),
            parent: ctx.repos.db3.get(group)?.name ?? '',
            chain: chainName(ctx.config, it.chain_id),
            names: it.recipients.map((p) => recipientNameOf(ctx, p.recipient)).join(', '),
          })
        : `Send ${joinList(it.recipients.map((p) => `${displayAmount(ctx, p.amount)} ${it.token} to ${recipientNameOf(ctx, p.recipient)} (${address(ctx, p.recipient)})`))} on ${chainName(ctx.config, it.chain_id)} in one atomic payment.`;
  if (it.depends_on.length === 0) return base;
  // Bridges come first and are never collapsed, so step s is line s + 1 (SQ-D-03 for several steps).
  return base + SUMMARY_LINE.AFTER_STEP({ n: joinList(it.depends_on.map((s) => String(s + 1))) });
}

function displayLeg(display: CalendarSchedule, schedule: PlanK['schedule']): CalendarSchedule {
  const first = DateTime.fromSeconds(schedule.start_at, { zone: display.timezone });
  return {
    ...display,
    days_of_week:
      display.frequency === 'weekly'
        ? [(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const)[first.weekday - 1]!]
        : null,
    end: { type: 'after_count', count: schedule.max_runs },
  };
}

function lineK(ctx: StepContext, it: PlanK): string {
  const first = DateTime.fromSeconds(it.schedule.start_at, { zone: it.display.schedule.timezone });
  const s = displayLeg(it.display.schedule, it.schedule);
  const payee = it.recipients[0]!;
  return SUMMARY_LINE.K({
    name: recipientNameOf(ctx, payee.recipient),
    addr: address(ctx, payee.recipient),
    amount: displayAmount(ctx, payee.amount),
    payments: joinList(
      it.recipients.map(
        (p) =>
          `${displayAmount(ctx, p.amount)} ${it.token} to ${recipientNameOf(ctx, p.recipient)} (${address(ctx, p.recipient)})`,
      ),
    ),
    token: it.token,
    cadence: cadenceText(s),
    time: first.toFormat('HH:mm'),
    timezone: s.timezone,
    chain: chainName(ctx.config, it.chain_id),
    first: displayDate(first),
    end: endText(ctx, s),
    total_cap: displayAmount(ctx, it.limits.max_total),
    fee: displayAmount(ctx, it.fee.amount),
    collector: it.fee.to,
    max_per_run: displayAmount(ctx, it.limits.max_per_run),
    late: String(it.schedule.late_window_seconds),
  });
}

function lineL(ctx: StepContext, it: PlanL): string {
  const row = ctx.repos.db7.get(it.autopay_id);
  if (!row) throw new Error('db7 row missing');
  const schedule = JSON.parse(row.schedule_json) as PlanK['schedule'];
  const display = JSON.parse(row.display_json ?? row.schedule_json) as CalendarSchedule;
  const cadence = cadenceText(row.display_json ? displayLeg(display, schedule) : display);
  const recipients = JSON.parse(row.recipients_json ?? '[]') as EnvelopeK['recipients'];
  if (recipients.length > 1) {
    const payments = joinList(recipients.map((p) => `${p.amount.value} ${row.token} to ${shortAddress(p.recipient)}`));
    return `Stop the repeating payment of ${payments} ${cadence} on ${chainName(ctx.config, it.chain_id)}. This cancels the whole plan for all its recipients. Money stays in your wallet; there is no refund transfer.`;
  }
  return SUMMARY_LINE.L({
    name: recipientName(ctx, ctx.repos.db3.get(it.recipient)) || row.recipient_name,
    amount: normalizeDecimal(row.amount_per_payment, decimalsOf(row.token)),
    token: row.token,
    cadence,
    chain: chainName(ctx.config, it.chain_id),
  });
}

/** One numbered line per shared intent, so bridge dependency numbers match the handoff exactly. */
function buildLines(ctx: StepContext, plan: InternalIntent[]): string[] {
  const texts: string[] = [];
  for (let n = 0; n < plan.length; n++) {
    const it = plan[n] as InternalIntent;
    if (it.intent_id === 'j') texts.push(lineJ(ctx, it));
    else if (it.intent_id === 'k') texts.push(lineK(ctx, it));
    else if (it.intent_id === 'l') texts.push(lineL(ctx, it));
    else texts.push(lineI(ctx, it));
  }
  return texts.map((t, i) => `${i + 1}. ${t}`);
}

/** The §13.1 notes that depend on what the plan finally uses; the other steps collected theirs in req.notes. */
function addPlanNotes(ctx: StepContext, plan: InternalIntent[]): void {
  const { req, repos } = ctx;
  const paid = plan.flatMap((it) => (it.intent_id === 'i' || it.intent_id === 'k' ? it.recipients : []));
  const used = new Set(paid.map((p) => p.amount));
  for (const it of plan)
    if (it.intent_id === 'k') {
      if (it.recipients.some((payee) => repos.db3.get(payee.recipient)?.group_placeholder)) {
        pushNote(
          ctx,
          'Each run pays all selected members together, with one operator fee. The listed addresses and amounts are fixed; later ENS group changes do not update this plan.',
        );
        pushNote(
          ctx,
          'Cancelling through any member cancels the whole group plan. Recipient addresses and amounts are visible on-chain.',
        );
      }
      const first = DateTime.fromSeconds(it.schedule.start_at, { zone: it.display.schedule.timezone });
      if (first.set({ month: 1 }).offset !== first.set({ month: 7 }).offset)
        pushNote(ctx, 'Times are fixed in UTC, so the local time shifts by an hour when daylight saving changes.');
    }
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
