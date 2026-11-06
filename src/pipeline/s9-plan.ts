// Implements: §8.11 / §10 S9 — Plan: §10.1 spendable, §10.2 expansion (groups → one `i` per selected member in
// alphabetical order of subname, `k` schedule and caps first, `l` from DB7), §10.3 chain selection incl. silent reuse
// marking (§9.5), §10.4 bridges with bigint padding/rounding, LIMIT_BRIDGES and the gas check, §10.5 step numbering
// and dependencies, §10.6 autopay schedule (questions Q_AUTOPAY_FREQUENCY / _START / _END / _COUNT / _DATE),
// §10.7 cancel (Q_AUTOPAY_PICK, AUTOPAY_NOT_READY, NO_ACTIVE_AUTOPAY), §17.2 step 4 (follow-up chain reuse) and
// step 7 note, §12.4 fill rules. Re-entrant: answers are kept in req.step_state.s9 and every derived DB1 row and
// autopay_id is minted only in the final phase, which asks no question.

import type { DateTime } from 'luxon';
import { CHIPS, NOTES, buildQuestion, matchChip, reask } from '../contracts/catalog.js';
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
  QuestionId,
  Schedule,
  ScheduleEnd,
  Token,
  Weekday,
} from '../contracts/types.js';
import { toBaseUnits } from '../contracts/money.js';
import { newId } from '../util/ids.js';
import { answerText, parseCount, parseDateAnswer } from '../plan/answers.js';
import { planBridges, type PlannedBridge } from '../plan/bridges.js';
import {
  chainName,
  decimalsOf,
  fmt,
  internalError,
  isGroupPh,
  joinAnd,
  pushNote,
  recipientNameOf,
  unsupported,
} from '../plan/common.js';
import {
  clampDayOfMonth,
  cronFor,
  daysForTimesPerWeek,
  enumerateOccurrences,
  expiresAt,
  firstOccurrence,
  onDateForDuration,
  parseEnd,
  paymentsPerWeek,
  sortDays,
  weekdayOf,
  type ScheduleCore,
} from '../plan/schedule.js';
import {
  balanceOf,
  hasGas,
  insufficientParams,
  readBalances,
  TOKENS_ORDER,
  type ChainBalance,
} from '../plan/spendable.js';
import { AUTOPAY_PICK_LABEL } from '../messages/templates.js';

// ───────────────────────────── re-entrant state ─────────────────────────────

interface S9State {
  freq: Record<string, Frequency>;
  start: Record<string, string>;
  end: Record<string, ScheduleEnd>;
  pick: Record<string, string>;
  pending?: { code: QuestionCode; index: number; first_date?: string };
}

function stateOf(ctx: StepContext): S9State {
  const existing = ctx.req.step_state.s9 as S9State | undefined;
  if (existing) return existing;
  const st: S9State = { freq: {}, start: {}, end: {}, pick: {} };
  ctx.req.step_state.s9 = st;
  return st;
}

function qid(): QuestionId {
  return newId('question') as QuestionId;
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
  const schedule: Schedule = {
    frequency,
    interval,
    days_of_week,
    day_of_month,
    time_of_day,
    timezone: ctx.timezone,
    start_date,
    first_occurrence: first.toISO({ suppressMilliseconds: true }) as string,
    end,
  };

  // Derived values (§10.6): 2 zero occurrences, 3 duration, 4 per-period cap, 5 per-payment limit.
  const occ = enumerateOccurrences(schedule, limits.autopay_max_weeks);
  if (occ.exceedsMaxWeeks) {
    return {
      kind: 'result',
      result: { kind: 'error', code: 'LIMIT_AUTOPAY_DURATION', params: { weeks: String(limits.autopay_max_weeks) } },
    };
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
  const dec = decimalsOf(token);
  const amount = toBaseUnits(row.amount, dec);
  const perPeriod = amount * paymentsPerWeek(schedule);
  const maxPeriod = toBaseUnits(limits.autopay_max_per_period[token], dec);
  if (perPeriod > maxPeriod) {
    return {
      kind: 'result',
      result: {
        kind: 'error',
        code: 'LIMIT_AUTOPAY_PERIOD',
        params: { cap: fmt(perPeriod, token), token, max: limits.autopay_max_per_period[token] },
      },
    };
  }
  if (amount > toBaseUnits(limits.per_tx_max[token], dec)) {
    return {
      kind: 'result',
      result: {
        kind: 'error',
        code: 'LIMIT_PER_TX',
        params: { amount: fmt(amount, token), token, max: limits.per_tx_max[token] },
      },
    };
  }
  const count = BigInt(occ.occurrences.length);
  const last = occ.occurrences[occ.occurrences.length - 1] as DateTime;
  return { kind: 'ok', draft: { schedule, amount, token, perPeriod, total: amount * count, day28, last } };
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
        chain: chainName(ctx, a.chain_id),
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

function checkChain(ctx: StepContext, balances: ChainBalance[], c: ChainId): StepResult | null {
  if (!ctx.limits.allowed_chain_ids.includes(c)) {
    return { kind: 'error', code: 'CHAIN_NOT_ALLOWED', params: { chain: chainName(ctx, c) } };
  }
  if (!balanceOf(balances, c)?.ok) {
    return { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: chainName(ctx, c) } };
  }
  return null;
}

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
  const reuseFrom = (c: ChainId): ChainId | null =>
    contactRows.length > 0 && !contactRows.some((r) => r.chain_id === c)
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
  const ref = req.recipients.find((r) => r.placeholder === p.recipient);
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
            chain: chainName(ctx, pin),
            other: chainName(ctx, stated),
          },
        },
      };
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
    const bad = checkChain(ctx, balances, stated);
    if (bad) return { kind: 'result', result: bad };
    return { kind: 'ok', chain: stated, reused: reuseFrom(stated) };
  }

  // §10.3 rule 3: candidates by recipient source.
  let base: ChainId[];
  if (row.source === 'user' || row.source === 'untrusted') base = [...limits.allowed_chain_ids];
  else if (isContact) base = contactChains;
  else if (row.source === 'ens') {
    const resolved = ref ? req.resolved[ref.span_index] : undefined;
    base = limits.allowed_chain_ids.filter((c) => resolved?.ens_chain_ids.includes(c));
    if (base.length === 0) base = contactChains; // a follow-up has no ENS lookup; add_contact saved the same chains
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
    const names = base.map((c) => chainName(ctx, c));
    if (names.length === 0) return { kind: 'result', result: unsupported(ctx, 's9', 'S9_NO_CANDIDATE_CHAIN') };
    return {
      kind: 'result',
      result: { kind: 'error', code: 'BALANCES_UNAVAILABLE', params: { chains: joinAnd(names) } },
    };
  }
  return { kind: 'ok', chain, reused: reuseFrom(chain) };
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
      return { kind: 'error', code: 'INSUFFICIENT_FUNDS', params: insufficientParams(ctx, token, balances, total) };
    }
    bridges.push(...planned);
  }
  if (bridges.length > limits.max_bridges_per_request) {
    return {
      kind: 'error',
      code: 'LIMIT_BRIDGES',
      params: { n: String(bridges.length), max: String(limits.max_bridges_per_request) },
    };
  }
  // Gas check: every chain the plan touches.
  const touched = new Set<ChainId>([...bridges.map((b) => b.source), ...items.map((it) => it.chain)]);
  for (const c of limits.allowed_chain_ids) {
    if (!touched.has(c)) continue;
    const b = balanceOf(balances, c);
    if (!b || !hasGas(b)) {
      return {
        kind: 'error',
        code: 'NO_GAS',
        params: { reserve: limits.eth_gas_reserve[String(c)] ?? '0', chain: chainName(ctx, c) },
      };
    }
  }

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
      pushNote(ctx, NOTES.SILENT_REUSE({ chain: chainName(ctx, it.reused) }));
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
    pushNote(ctx, NOTES.FOLLOWUP());
  }
  req.plan = plan;
  req.state = 'PLANNED';
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

export const s9: StepEntry = { step, onAnswer };
