// Implements: §8.11 / §10 S9 — Plan: §10.1 spendable, §10.2 expansion (groups → one `i` per selected member in
// alphabetical order of subname, `k` schedule and caps first, `l` from DB7), §10.3 chain selection incl. silent reuse
// marking (§9.5), §10.4 bridges with bigint padding/rounding, LIMIT_BRIDGES (left to S10's Q_LIMIT_OVERRIDE when it
// can be lifted, SQ-D-16; likewise the autopay limits) and the gas check, §10.5 step numbering
// and dependencies, §10.6 autopay schedule (questions Q_AUTOPAY_FREQUENCY / _START / _END / _COUNT / _DATE),
// §10.7 cancel (Q_AUTOPAY_PICK, AUTOPAY_NOT_READY, NO_ACTIVE_AUTOPAY), §17.2 step 4 (follow-up chain reuse) and
// step 7 note, §12.4 fill rules. Re-entrant: answers are kept in req.step_state.s9 and every derived DB1 row and
// autopay_id is minted only in the final phase, which asks no question.
// SQ-S-01: an amount correction keeps the failed request's chain and uses its own summary note.

import { DateTime } from 'luxon';
import { CHIPS, NOTES, buildQuestion, joinList, matchChip, reask } from '../contracts/catalog.js';
import type { Db7Row } from '../contracts/repos.js';
import type { AnswerHandler, StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type {
  AddressPh,
  AmountPh,
  ChainId,
  Frequency,
  GroupPh,
  InternalIntent,
  Payment,
  PlanJ,
  QuestionCode,
  Schedule,
  ScheduleEnd,
  Token,
  Weekday,
} from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { newId } from '../util/ids.js';
import { answerText, parseCount, parseDateAnswer } from '../plan/answers.js';
import { neededWithPadding, planBridges, type PlannedBridge } from '../plan/bridges.js';
import { chainName, qid } from '../lexical/step-util.js';
import { decimalsOf, fmt, internalError, isGroupPh, pushNote, recipientNameOf, unsupported } from '../plan/common.js';
import {
  clampDayOfMonth,
  cronFor,
  daysForTimesPerWeek,
  enumerateOccurrences,
  expiresAt,
  firstOccurrence,
  mostInAnyWeek,
  onDateForDuration,
  parseEnd,
  sortDays,
  weekdayOf,
  type ScheduleCore,
} from '../plan/schedule.js';
import {
  balanceOf,
  checkChain,
  checkGas,
  insufficientParams,
  readBalances,
  TOKENS_ORDER,
  type ChainBalance,
} from '../plan/spendable.js';
import {
  autopayDurationBreach,
  autopayPeriodBreach,
  bridgeBreach,
  limitsCanBeLifted,
  perTxBreach,
} from '../plan/limits.js';

/** Bound on a schedule's length once the duration limit is lifted (SQ-D-16): about 57 years. */
const LIFTED_MAX_WEEKS = 3000;
import { AUTOPAY_PICK_LABEL } from '../messages/templates.js';

// ───────────────────────────── re-entrant state ─────────────────────────────

interface S9State {
  freq: Record<string, Frequency>;
  start: Record<string, string>;
  end: Record<string, ScheduleEnd>;
  pick: Record<string, string>;
  pending?: { code: QuestionCode; index: number; first_date?: string };
  /** SQ-R-05: further `k` payments (indexes) whose start date must be asked again after the pending one. */
  late?: number[];
}

/** SQ-R-05: the answers of a finished S9 run, kept so a re-plan at confirm time does not ask them again. */
const ANSWERS_KEY = 's9_answers';

function stateOf(ctx: StepContext): S9State {
  const existing = ctx.req.step_state.s9 as S9State | undefined;
  if (existing) return existing;
  const kept = ctx.req.step_state[ANSWERS_KEY] as Omit<S9State, 'pending' | 'late'> | undefined;
  const st: S9State = kept
    ? { freq: { ...kept.freq }, start: { ...kept.start }, end: { ...kept.end }, pick: { ...kept.pick } }
    : { freq: {}, start: {}, end: {}, pick: {} };
  ctx.req.step_state.s9 = st;
  return st;
}

function ask(
  ctx: StepContext,
  st: S9State,
  code: QuestionCode,
  index: number,
  extra: Partial<Parameters<typeof buildQuestion>[0]> = {},
  first_date?: string,
): StepResult {
  st.pending = first_date === undefined ? { code, index } : { code, index, first_date };
  ctx.log.info({ event: 'question', request_id: ctx.req.request_id, step: 's9', question_code: code, attempt: 1 });
  return { kind: 'question', question: buildQuestion({ question_id: qid(), code, ...extra }) };
}

// ───────────────────────────── phase 1: schedules and cancels ─────────────────────────────

interface KDraft {
  schedule: Schedule;
  amount: bigint;
  token: Token;
  perPeriod: bigint;
  total: bigint;
  day28: boolean;
  last: DateTime;
}

type Phase1 = { kind: 'ok'; k: Map<number, KDraft>; l: Map<number, Db7Row> } | { kind: 'result'; result: StepResult };

function paymentClauses(ctx: StepContext, p: Payment): Set<number> {
  const out = new Set<number>();
  const a = ctx.req.amounts.find((x) => x.placeholder === p.amount)?.span?.clause_index;
  if (a !== undefined) out.add(a);
  const ref = ctx.req.recipients.find((r) => r.placeholder === p.recipient);
  const rc = ref ? ctx.req.spans[ref.span_index]?.span?.clause_index : undefined;
  if (rc !== undefined) out.add(rc);
  return out;
}

function resolveK(
  ctx: StepContext,
  st: S9State,
  p: Payment,
  i: number,
): { kind: 'ok'; draft: KDraft } | { kind: 'result'; result: StepResult } {
  const { req, limits } = ctx;
  const key = String(i);
  const today: DateTime = ctx.now().startOf('day');
  const clauses = paymentClauses(ctx, p);
  const inClause = (ci: number): boolean => clauses.size === 0 || clauses.has(ci);
  const clauseTexts = req.scan.clauses.filter((c) => inClause(c.index)).map((c) => c.text);
  const clauseText = clauseTexts.length > 0 ? clauseTexts.join(' ') : req.typed_text;
  const dates = req.scan.dates.filter((d) => inClause(d.clause_index));

  // frequency
  const frequency: Frequency | null = p.times_per_week === 7 ? 'daily' : (p.frequency ?? st.freq[key] ?? null);
  if (frequency === null) {
    return {
      kind: 'result',
      result: ask(ctx, st, 'Q_AUTOPAY_FREQUENCY', i, { chips: [CHIPS.DAILY, CHIPS.WEEKLY, CHIPS.MONTHLY] }),
    };
  }
  const interval = p.interval ?? 1;
  let days_of_week: Weekday[] | null = null;
  let day_of_month: number | null = null;
  let day28 = false;
  if (frequency === 'weekly') {
    if (p.days_of_week !== null && p.days_of_week.length > 0) days_of_week = sortDays(p.days_of_week);
    else if (p.times_per_week !== null) days_of_week = sortDays(daysForTimesPerWeek(p.times_per_week, today));
    else days_of_week = [weekdayOf(today)];
  } else if (frequency === 'monthly') {
    const c = clampDayOfMonth(p.day_of_month ?? today.day);
    day_of_month = c.day;
    day28 = c.clamped;
  }
  const time_of_day =
    dates.find((d) => d.kind !== 'end' && d.time !== null)?.time ?? ctx.config.defaults.autopay_time_of_day;
  const todayIso = today.toISODate() as string;
  let start_date = st.start[key];
  if (start_date === undefined) {
    start_date = dates.find((d) => d.kind === 'start' && d.date !== null)?.date ?? todayIso;
    if (start_date < todayIso) return { kind: 'result', result: ask(ctx, st, 'Q_AUTOPAY_START', i) };
  }
  const core: ScheduleCore = {
    frequency,
    interval,
    days_of_week,
    day_of_month,
    time_of_day,
    timezone: ctx.timezone,
    start_date,
  };
  const first = firstOccurrence(core, ctx.now());
  const firstDate = first.toISODate() as string;

  let end: ScheduleEnd | undefined = st.end[key];
  if (end === undefined) {
    const untilDate = dates.find((d) => d.kind === 'end' && d.date !== null)?.date ?? null;
    const parsed = parseEnd(clauseText, untilDate, parseCount);
    if (parsed === null) {
      return {
        kind: 'result',
        result: ask(
          ctx,
          st,
          'Q_AUTOPAY_END',
          i,
          { chips: [CHIPS.END_COUNT, CHIPS.END_DATE, CHIPS.END_CANCEL] },
          firstDate,
        ),
      };
    }
    if (parsed.type === 'for_count') {
      end = { type: 'after_count', count: parsed.n };
    } else if (parsed.type === 'for_units') {
      end = { type: 'on_date', date: onDateForDuration(first, parsed.n, parsed.unit) };
    } else {
      end = parsed;
    }
  }
  const schedule: Schedule = { ...core, first_occurrence: first.toISO({ suppressMilliseconds: true }) as string, end };

  // Derived values (§10.6): 2 zero occurrences, 3 duration, 4 per-period cap, 5 per-payment limit.
  // A broken limit that can be lifted is left to S10, which asks Q_LIMIT_OVERRIDE once for all of them (SQ-D-16).
  const liftable = limitsCanBeLifted(ctx);
  let occ = enumerateOccurrences(schedule, limits.autopay_max_weeks);
  if (occ.exceedsMaxWeeks) {
    if (!liftable) return { kind: 'result', result: autopayDurationBreach(ctx).error };
    occ = enumerateOccurrences(schedule, LIFTED_MAX_WEEKS);
    if (occ.exceedsMaxWeeks) return { kind: 'result', result: unsupported(ctx, 's9', 'S9_AUTOPAY_BEYOND_LIFTED_MAX') };
  }
  if (occ.occurrences.length === 0)
    return { kind: 'result', result: { kind: 'error', code: 'AUTOPAY_NO_OCCURRENCES' } };
  // §12.5 caps after_count at 520 and the spec has no reply for a longer count within the duration limit (SQ-D-06).
  if (end.type === 'after_count' && end.count > 520) {
    return { kind: 'result', result: unsupported(ctx, 's9', 'S9_AUTOPAY_COUNT_OVER_520') };
  }
  const row = p.amount === null ? undefined : ctx.repos.db1.get(p.amount);
  if (!row) return { kind: 'result', result: internalError(ctx, 's9', 'S9_K_AMOUNT_MISSING') };
  const token = row.token;
  const amount = toBaseUnits(row.amount, decimalsOf(token));
  const count = BigInt(occ.occurrences.length);
  const total = amount * count;
  // SQ-R-03: per_period_cap = min(amount × most payments in any 7-day window, total_cap).
  const inWeek = amount * BigInt(mostInAnyWeek(occ.occurrences));
  const perPeriod = inWeek < total ? inWeek : total;
  const overLimit = autopayPeriodBreach(ctx, perPeriod, token) ?? perTxBreach(ctx, amount, token, true);
  if (overLimit && !liftable) return { kind: 'result', result: overLimit.error };
  const last = occ.occurrences[occ.occurrences.length - 1] as DateTime;
  return { kind: 'ok', draft: { schedule, amount, token, perPeriod, total, day28, last } };
}

function scheduleLabel(s: Schedule): string {
  if (s.frequency === 'weekly') return `weekly on ${(s.days_of_week ?? []).join(', ')}`;
  if (s.frequency === 'monthly') return `monthly on day ${String(s.day_of_month ?? '')}`;
  return 'daily';
}

function resolveL(
  ctx: StepContext,
  st: S9State,
  p: Payment,
  i: number,
): { kind: 'ok'; row: Db7Row } | { kind: 'result'; result: StepResult } {
  const r = ctx.repos.db3.get(p.recipient);
  if (!r || r.address === null) return { kind: 'result', result: internalError(ctx, 's9', 'S9_L_RECIPIENT_MISSING') };
  const active = ctx.repos.db7.findByRecipient(r.address, 'active');
  if (active.length === 0) {
    if (ctx.repos.db7.findByRecipient(r.address, 'pending').length > 0) {
      return { kind: 'result', result: { kind: 'error', code: 'AUTOPAY_NOT_READY' } };
    }
    return {
      kind: 'result',
      result: { kind: 'error', code: 'NO_ACTIVE_AUTOPAY', params: { name: recipientNameOf(ctx, p.recipient) } },
    };
  }
  if (active.length === 1) return { kind: 'ok', row: active[0] as Db7Row };
  const picked = active.find((a) => a.autopay_id === st.pick[String(i)]);
  if (picked) return { kind: 'ok', row: picked };
  const chips = active.map((a) => {
    let since = '';
    let label = '';
    try {
      const s = JSON.parse(a.schedule_json) as Schedule;
      since = s.start_date;
      label = scheduleLabel(s);
    } catch {
      label = '';
    }
    return {
      id: a.autopay_id,
      label: AUTOPAY_PICK_LABEL({
        amount: a.amount_per_payment,
        token: a.token,
        schedule: label,
        chain: chainName(ctx.config, a.chain_id),
        since,
      }),
      disabled: false,
      detail: '',
    };
  });
  return { kind: 'result', result: ask(ctx, st, 'Q_AUTOPAY_PICK', i, { chips }) };
}

function phase1(ctx: StepContext, st: S9State, payments: Payment[]): Phase1 {
  const k = new Map<number, KDraft>();
  const l = new Map<number, Db7Row>();
  for (let i = 0; i < payments.length; i++) {
    const p = payments[i] as Payment;
    if (p.kind === 'k') {
      const r = resolveK(ctx, st, p, i);
      if (r.kind === 'result') return r;
      k.set(i, r.draft);
    } else if (p.kind === 'l') {
      const r = resolveL(ctx, st, p, i);
      if (r.kind === 'result') return r;
      l.set(i, r.row);
    }
  }
  return { kind: 'ok', k, l };
}

// ───────────────────────────── phase 2: expansion, chains, bridges, steps ─────────────────────────────

interface Item {
  pay: number;
  kind: 'i' | 'k' | 'l';
  amount: AmountPh | null;
  recipient: AddressPh;
  token: Token | null;
  need: bigint;
  chain: ChainId;
  reused: ChainId | null;
  k?: KDraft;
  l?: Db7Row;
}

type ChainPick = { kind: 'ok'; chain: ChainId; reused: ChainId | null } | { kind: 'result'; result: StepResult };

function pickChain(
  ctx: StepContext,
  balances: ChainBalance[],
  assigned: Map<string, bigint>,
  p: Payment,
  recipient: AddressPh,
  token: Token,
  need: bigint,
  groupChain: ChainId | null,
): ChainPick {
  const { req, limits } = ctx;
  const row = ctx.repos.db3.get(recipient);
  if (!row || row.address === null) return { kind: 'result', result: internalError(ctx, 's9', 'S9_RECIPIENT_MISSING') };
  const avail = (c: ChainId): bigint =>
    (balanceOf(balances, c)?.spendable[token] ?? 0n) - (assigned.get(`${c}:${token}`) ?? 0n);
  const okAllowed = limits.allowed_chain_ids.filter((c) => balanceOf(balances, c)?.ok);
  const contactRows = row.kind === 'single' ? ctx.repos.db2.findByAddress(row.address) : [];
  // §10.3 rule 4 is about contacts that existed before this request (source='contact'): an address saved during this
  // request keeps its 'user' / 'untrusted' / 'ens' candidates. reuseFrom is §9.5: any payment on a chain without a DB2
  // row for this address.
  const isContact = row.source === 'contact';
  const contactChains = limits.allowed_chain_ids.filter((c) => contactRows.some((r) => r.chain_id === c));
  // R3-2, §10.3 rule 3: a payee resolved through ENS in this request (source 'ens', or 'untrusted' / 'user' with an ENS
  // record) is paid only on chains whose record returned its address, and never by silent reuse.
  const ref = req.recipients.find((r) => r.placeholder === p.recipient);
  const resolved = ref ? req.resolved[ref.span_index] : undefined;
  const ensChains = !isContact && row.kind === 'single' ? (resolved?.ens_chain_ids ?? []) : [];
  const ensLimited = ensChains.length > 0;
  const reuseFrom = (c: ChainId): ChainId | null =>
    !ensLimited && contactRows.length > 0 && !contactRows.some((r) => r.chain_id === c)
      ? (contactChains[0] ?? contactRows[0]?.chain_id ?? null)
      : null;

  // Pins (§10.3 rule 1): ENS chain choice (DB3 chain_id of a single row, §8.8) or a relative amount.
  const amountPin =
    p.amount === null ? null : (req.amounts.find((a) => a.placeholder === p.amount)?.pinned_chain_id ?? null);
  const recipientPin = row.kind === 'single' ? row.chain_id : null;
  if (amountPin !== null && recipientPin !== null && amountPin !== recipientPin) {
    return { kind: 'result', result: unsupported(ctx, 's9', 'S9_TWO_PINS') };
  }
  const pin = amountPin ?? recipientPin;

  // §17.2 step 4: a follow-up payee with "unstated" chain uses its previous chain as if stated.
  let stated = p.chain;
  if (stated === 'unstated' && ref?.followup && ref.last_chain_id !== null) stated = ref.last_chain_id;

  if (pin !== null) {
    if (stated !== 'unstated' && stated !== pin) {
      // P9 catches a chain the user typed; this is the follow-up's previous chain, used "as if stated".
      return {
        kind: 'result',
        result: {
          kind: 'error',
          code: 'CHAIN_CONFLICT',
          params: {
            name: recipientNameOf(ctx, recipient),
            chain: chainName(ctx.config, pin),
            other: chainName(ctx.config, stated),
          },
        },
      };
    }
    if (ensLimited && !ensChains.includes(pin)) {
      return { kind: 'result', result: unsupported(ctx, 's9', 'S9_PIN_NOT_IN_ENS') };
    }
    const bad = checkChain(ctx, balances, pin);
    if (bad) return { kind: 'result', result: bad };
    // §9.5: a recipient pinned by ENS (§9.3 step 6) is never reused; its ENS record returned this address on `pin`.
    return { kind: 'ok', chain: pin, reused: recipientPin !== null ? null : reuseFrom(pin) };
  }
  if (groupChain !== null) {
    if (stated !== 'unstated' && stated !== groupChain)
      return { kind: 'result', result: unsupported(ctx, 's9', 'S9_GROUP_CHAIN_VS_STATED') };
    const bad = checkChain(ctx, balances, groupChain);
    if (bad) return { kind: 'result', result: bad };
    return { kind: 'ok', chain: groupChain, reused: null };
  }
  if (stated !== 'unstated') {
    // R3-2: never pay an ENS payee on a chain its record did not return the address for.
    if (ensLimited && !ensChains.includes(stated)) {
      return { kind: 'result', result: unsupported(ctx, 's9', 'S9_STATED_CHAIN_NOT_IN_ENS') };
    }
    const bad = checkChain(ctx, balances, stated);
    if (bad) return { kind: 'result', result: bad };
    return { kind: 'ok', chain: stated, reused: reuseFrom(stated) };
  }

  // §10.3 rule 3: candidates by recipient source.
  let base: ChainId[];
  if (ensLimited) base = limits.allowed_chain_ids.filter((c) => ensChains.includes(c));
  else if (row.source === 'user' || row.source === 'untrusted') base = [...limits.allowed_chain_ids];
  else if (isContact) base = contactChains;
  else if (row.source === 'ens') {
    base = contactChains; // a follow-up has no ENS lookup; add_contact saved the same chains
  } else base = [...limits.allowed_chain_ids];
  const cands = base.filter((c) => okAllowed.includes(c));
  const best = (set: ChainId[], requireNeed: boolean): ChainId | null => {
    let out: ChainId | null = null;
    for (const c of set) {
      const v = avail(c);
      if (requireNeed && v < need) continue;
      if (out === null || v > avail(out)) out = c;
    }
    return out;
  };
  let chain = best(cands, true);
  let pool = cands;
  if (chain === null && isContact) {
    pool = okAllowed; // rule 4: silent reuse on every allowed ok chain
    chain = best(pool, true);
  }
  if (chain === null) chain = best(pool, false); // rule 5: shortfall bridged
  if (chain === null) {
    const names = base.map((c) => chainName(ctx.config, c));
    if (names.length === 0) return { kind: 'result', result: unsupported(ctx, 's9', 'S9_NO_CANDIDATE_CHAIN') };
    return {
      kind: 'result',
      result: { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: joinList(names) } },
    };
  }
  return { kind: 'ok', chain, reused: reuseFrom(chain) };
}

/**
 * SQ-O-10: the silent-reuse note names every chain whose DB2 row holds the reused address (one contact per address,
 * §7.1), the payment's own chain excluded, in configured chain order. `reused_from_chain_id` stays single-valued.
 */
function reusedOnChains(ctx: StepContext, recipient: AddressPh, own: ChainId): string {
  const address = ctx.repos.db3.get(recipient)?.address;
  const rows = address ? ctx.repos.db2.findByAddress(address) : [];
  const chains = ctx.config.chains
    .map((c) => c.chain_id)
    .filter((c) => c !== own && rows.some((r) => r.chain_id === c));
  return joinList(chains.map((c) => chainName(ctx.config, c)));
}

async function step(ctx: StepContext): Promise<StepResult> {
  const { req, limits } = ctx;
  const payments = req.payments;
  if (!payments || payments.length === 0) return internalError(ctx, 's9', 'S9_NO_PAYMENTS');
  const st = stateOf(ctx);
  const p1 = phase1(ctx, st, payments);
  if (p1.kind === 'result') return p1.result;

  const balances = readBalances(ctx);
  const assigned = new Map<string, bigint>();
  const items: Item[] = [];

  for (let i = 0; i < payments.length; i++) {
    const p = payments[i] as Payment;
    if (p.kind === 'l') {
      const row = p1.l.get(i) as Db7Row;
      const bad = checkChain(ctx, balances, row.chain_id);
      if (bad) return bad;
      items.push({
        pay: i,
        kind: 'l',
        amount: null,
        recipient: p.recipient as AddressPh,
        token: null,
        need: 0n,
        chain: row.chain_id,
        reused: null,
        l: row,
      });
      continue;
    }
    if (p.amount === null) return internalError(ctx, 's9', 'S9_AMOUNT_NULL');
    const db1 = ctx.repos.db1.get(p.amount);
    if (!db1) return internalError(ctx, 's9', 'S9_AMOUNT_MISSING');
    const token = db1.token;
    const draft = p1.k.get(i);
    const need = p.kind === 'k' && draft ? draft.total : toBaseUnits(db1.amount, decimalsOf(token));
    // §10.2 rule 1: a group expands into one `i` per selected member, alphabetical by subname, in place.
    let targets: Array<{ recipient: AddressPh; groupChain: ChainId | null }>;
    if (isGroupPh(p.recipient)) {
      const group = ctx.repos.db3.get(p.recipient);
      const members = ctx.repos.db3
        .listMembers(p.recipient as GroupPh)
        .sort((a, b) => ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0));
      if (!group || group.chain_id === null || members.length === 0) return internalError(ctx, 's9', 'S9_GROUP_EMPTY');
      targets = members.map((m) => ({ recipient: m.placeholder as AddressPh, groupChain: group.chain_id }));
    } else {
      targets = [{ recipient: p.recipient as AddressPh, groupChain: null }];
    }
    for (const t of targets) {
      const pick = pickChain(ctx, balances, assigned, p, t.recipient, token, need, t.groupChain);
      if (pick.kind === 'result') return pick.result;
      const key = `${pick.chain}:${token}`;
      assigned.set(key, (assigned.get(key) ?? 0n) + need);
      const item: Item = {
        pay: i,
        kind: p.kind,
        amount: p.amount,
        recipient: t.recipient,
        token,
        need,
        chain: pick.chain,
        reused: pick.reused,
      };
      if (draft) item.k = draft;
      items.push(item);
    }
  }

  // §10.4 bridges per token.
  const okChains = balances.filter((b) => b.ok).map((b) => b.chain_id);
  const bridges: PlannedBridge[] = [];
  for (const token of TOKENS_ORDER) {
    const need = new Map<ChainId, bigint>();
    let total = 0n;
    for (const c of okChains) {
      const v = assigned.get(`${c}:${token}`) ?? 0n;
      need.set(c, v);
      total += v;
    }
    if (total === 0n) continue;
    const spendable = new Map<ChainId, bigint>(
      okChains.map((c) => [c, balanceOf(balances, c)?.spendable[token] ?? 0n]),
    );
    const planned = planBridges(token, okChains, spendable, need, limits.bridge_buffer_pct);
    if (planned === null) {
      const needed = neededWithPadding(okChains, spendable, need, limits.bridge_buffer_pct);
      return { kind: 'error', code: 'INSUFFICIENT_FUNDS', params: insufficientParams(ctx, token, balances, needed) };
    }
    bridges.push(...planned);
  }
  // LIMIT_BRIDGES, then the gas check on every chain the plan touches.
  const touched = new Set<ChainId>([...bridges.map((b) => b.source), ...items.map((it) => it.chain)]);
  const tooMany = bridgeBreach(ctx, bridges.length, false);
  if (tooMany && !limitsCanBeLifted(ctx)) return tooMany.error;
  const noGas = checkGas(ctx, balances, touched);
  if (noGas) return noGas;

  // §10.5 ordering: all j first (by first payment needing the destination, then source in allowed order).
  const firstNeed = (b: PlannedBridge): number => {
    const idx = items.findIndex((it) => it.kind !== 'l' && it.chain === b.dest && it.token === b.token);
    return idx < 0 ? Number.MAX_SAFE_INTEGER : idx;
  };
  const orderedBridges = bridges
    .map((b, n) => ({ b, n }))
    .sort(
      (x, y) =>
        firstNeed(x.b) - firstNeed(y.b) ||
        limits.allowed_chain_ids.indexOf(x.b.source) - limits.allowed_chain_ids.indexOf(y.b.source) ||
        x.n - y.n,
    )
    .map((x) => x.b);

  // Final phase: mint derived DB1 rows and autopay ids, build the plan.
  const mint = (
    amount: bigint,
    token: Token,
    origin: 'bridge_padded' | 'autopay_per_period_cap' | 'autopay_total_cap',
  ): AmountPh =>
    ctx.repos.db1.mint({
      session_id: req.session_id,
      request_id: req.request_id,
      amount: fmt(amount, token),
      token,
      source: 'derived',
      origin,
      confirmed: true,
    });
  const plan: InternalIntent[] = [];
  const jSteps: PlanJ[] = [];
  for (const b of orderedBridges) {
    const j: PlanJ = {
      intent_id: 'j',
      step: plan.length,
      token: b.token,
      source_chain_id: b.source,
      dest_chain_id: b.dest,
      amount: mint(b.padded, b.token, 'bridge_padded'),
      deliverable_base_units: b.deliverable.toString(),
      receiver: 'self',
      funds_steps: [],
    };
    plan.push(j);
    jSteps.push(j);
  }
  for (const it of items) {
    const stepNo = plan.length;
    if (it.kind === 'l' && it.l) {
      plan.push({
        intent_id: 'l',
        step: stepNo,
        autopay_id: it.l.autopay_id,
        chain_id: it.l.chain_id,
        delegate_address: it.l.delegate_address ?? '',
        recipient: it.recipient,
        refund_remaining: true,
      });
      continue;
    }
    const token = it.token as Token;
    const depends_on = jSteps.filter((j) => j.dest_chain_id === it.chain && j.token === token).map((j) => j.step);
    for (const j of jSteps) if (depends_on.includes(j.step)) j.funds_steps.push(stepNo);
    if (it.reused !== null) {
      ctx.repos.db3.setReusedFromChain(it.recipient, it.reused);
      pushNote(ctx, NOTES.SILENT_REUSE({ chains: reusedOnChains(ctx, it.recipient, it.chain) }));
    }
    if (it.kind === 'i') {
      plan.push({
        intent_id: 'i',
        step: stepNo,
        depends_on,
        token,
        chain_id: it.chain,
        amount: it.amount as AmountPh,
        recipient: it.recipient,
        reused_from_chain_id: it.reused,
      });
    } else if (it.k) {
      const d = it.k;
      if (d.day28) pushNote(ctx, NOTES.DAY_28());
      plan.push({
        intent_id: 'k',
        step: stepNo,
        depends_on,
        autopay_id: newId('autopay'),
        token,
        chain_id: it.chain,
        recipient: it.recipient,
        amount_per_payment: it.amount as AmountPh,
        schedule: d.schedule,
        limits: {
          per_period_cap: mint(d.perPeriod, token, 'autopay_per_period_cap'),
          total_cap: mint(d.total, token, 'autopay_total_cap'),
          expires_at: expiresAt(d.last, d.schedule.timezone),
        },
        cre_job: {
          trigger: 'cron',
          cron: cronFor(d.schedule),
          timezone: d.schedule.timezone,
          interval: d.schedule.interval,
        },
      });
    }
  }
  // §17.2 step 7: every follow-up payee gets the note (SQ-D-07 for a follow-up with a typed chain).
  if (payments.some((p) => req.recipients.some((r) => r.placeholder === p.recipient && r.followup))) {
    pushNote(ctx, req.retry_context !== undefined ? NOTES.PAYMENT_CORRECTION() : NOTES.FOLLOWUP());
  }
  req.plan = plan;
  req.state = 'PLANNED';
  req.step_state[ANSWERS_KEY] = { freq: st.freq, start: st.start, end: st.end, pick: st.pick };
  delete req.step_state.s9;
  ctx.log.info({ event: 'planned', request_id: req.request_id, step: 's9', n_intents: plan.length });
  return { kind: 'continue' };
}

// ───────────────────────────── answers ─────────────────────────────

const FREQ_BY_CHIP: Record<string, Frequency> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly' };

const onAnswer: AnswerHandler = async (ctx, q, answer) => {
  const st = stateOf(ctx);
  const pend = st.pending;
  if (!pend || pend.code !== q.code) return internalError(ctx, 's9', 'S9_STALE_ANSWER');
  const key = String(pend.index);
  const again = (): StepResult => ({ kind: 'question', question: reask(q, qid()) });
  const today = ctx.now().startOf('day').toISODate() as string;
  switch (q.code) {
    case 'Q_AUTOPAY_FREQUENCY': {
      const chip = matchChip(q, answer);
      const f = chip ? FREQ_BY_CHIP[chip.id] : undefined;
      if (!f) return again();
      st.freq[key] = f;
      break;
    }
    case 'Q_AUTOPAY_START': {
      const text = answerText(answer);
      const d = text === null ? null : parseDateAnswer(text, ctx.now());
      if (d === null || d < today) return again();
      st.start[key] = d;
      // SQ-R-05: one question per late autopay, in payment order.
      const next = st.late?.shift();
      if (next !== undefined) return ask(ctx, st, 'Q_AUTOPAY_START', next);
      break;
    }
    case 'Q_AUTOPAY_END': {
      const chip = matchChip(q, answer);
      if (!chip) return again();
      if (chip.id === CHIPS.END_COUNT.id) return ask(ctx, st, 'Q_AUTOPAY_COUNT', pend.index, {}, pend.first_date);
      if (chip.id === CHIPS.END_DATE.id) return ask(ctx, st, 'Q_AUTOPAY_DATE', pend.index, {}, pend.first_date);
      st.end[key] = { type: 'until_cancelled' };
      break;
    }
    case 'Q_AUTOPAY_COUNT': {
      const text = answerText(answer);
      const n = text === null ? null : parseCount(text);
      if (n === null || n < 1 || n > 520) return again();
      st.end[key] = { type: 'after_count', count: n };
      break;
    }
    case 'Q_AUTOPAY_DATE': {
      const text = answerText(answer);
      const d = text === null ? null : parseDateAnswer(text, ctx.now());
      // §13.4: "date after first occurrence".
      if (d === null || d <= (pend.first_date ?? today)) return again();
      st.end[key] = { type: 'on_date', date: d };
      break;
    }
    case 'Q_AUTOPAY_PICK': {
      const chip = matchChip(q, answer);
      if (!chip) return again();
      st.pick[key] = chip.id;
      break;
    }
    default:
      return internalError(ctx, 's9', 'S9_UNKNOWN_QUESTION');
  }
  delete st.pending;
  return { kind: 'continue' };
};

// ───────────────────────────── SQ-R-05: late confirmation ─────────────────────────────

/** The S8 payment a planned `k` comes from (same amount placeholder and recipient). */
function paymentOfK(ctx: StepContext, payments: Payment[], it: Extract<InternalIntent, { intent_id: 'k' }>): number {
  return payments.findIndex(
    (p) =>
      p.kind === 'k' &&
      p.amount === it.amount_per_payment &&
      (p.recipient === it.recipient || ctx.repos.db3.get(it.recipient)?.group_placeholder === p.recipient),
  );
}

/**
 * SQ-R-05: on "yes", a planned autopay whose first occurrence is no longer after now is never handed off. Asks
 * Q_AUTOPAY_START for each such `k` (in payment order); the answers re-plan from S9, and S10/S11 show a new summary.
 */
function beforeHandoff(ctx: StepContext): StepResult | null {
  const { req } = ctx;
  const payments = req.payments ?? [];
  const now = ctx.now();
  const late: number[] = [];
  for (const it of req.plan ?? []) {
    if (it.intent_id !== 'k') continue;
    const occurrence = DateTime.fromISO(it.schedule.first_occurrence, { setZone: true });
    if (occurrence.isValid && occurrence > now) continue;
    const i = paymentOfK(ctx, payments, it);
    if (i < 0) return internalError(ctx, 's9', 'S9_LATE_K_UNMATCHED');
    if (!late.includes(i)) late.push(i);
  }
  const first = late.shift();
  if (first === undefined) return null;
  const st = stateOf(ctx);
  for (const i of [first, ...late]) delete st.start[String(i)];
  st.late = late;
  return ask(ctx, st, 'Q_AUTOPAY_START', first);
}

export const s9: StepEntry = { step, onAnswer, beforeHandoff };
