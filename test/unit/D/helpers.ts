// Lane D test helpers: scenario builders that fill an AgentRequest the way Lanes B/C would (S3–S7 outputs),
// plus hand-built internal plans for S10–S12. Spec refs: §8.0, §8.9, §12.3, §19 setup.

import { DateTime } from 'luxon';
import { getAddress } from 'viem';
import { expect } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import type { Db6Insert } from '../../../src/contracts/repos.js';
import type { StepResult } from '../../../src/contracts/step.js';
import type {
  ActionKind,
  Address,
  AddressPh,
  AmountPh,
  AutopayId,
  ChainId,
  ChronoSpan,
  ErrorCode,
  Frequency,
  GroupPh,
  Payment,
  PlanI,
  PlanJ,
  PlanK,
  PlanL,
  RecipientPh,
  RecipientSource,
  Schedule,
  Token,
  Weekday,
} from '../../../src/contracts/types.js';
import { ARADHYA, MIHIR, TEST_WALLET, makeTestContext, type TestContext } from '../../fakes/context.js';
import type { FixtureCall } from '../../fakes/llm.js';
import { seedBalances, seedContact } from '../../fakes/repos.js';

export const ARADHYA_CS = getAddress(ARADHYA) as Address;
export const MIHIR_CS = getAddress(MIHIR) as Address;
export const WALLET_CS = getAddress(TEST_WALLET) as Address;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;
export const RIYA_CS = getAddress('0x5c7e2a41b2c3d4e5f60718293a4b5c6d7e8f9011') as Address;
export const ALICE_CS = getAddress('0xa11ce00000000000000000000000000000000001') as Address;
export const BOB_CS = getAddress('0xb0b0000000000000000000000000000000000002') as Address;
export const CAROL_CS = getAddress('0xca201000000000000000000000000000000000c3') as Address;
export const DOC_ADDR_CS = getAddress('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111') as Address;
export const STRANGER_CS = getAddress('0x1234567890abcdef1234567890abcdef12345678') as Address;
export const DELEGATE_CS = getAddress('0xde1e9a7e00000000000000000000000000000d01') as Address;

export const SEPOLIA: ChainId = 11155111;
export const BASE: ChainId = 84532;
export const ARB: ChainId = 421614;

export const USDC_ADDR: Record<ChainId, Address> = {
  11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
};

export type Bal = Partial<Record<ChainId, Partial<Record<Token, string>>>>;

export interface CtxOptions {
  /** USDC/ETH balances; every chain defaults to ETH 0.1 and USDC 0 (§19 setup "ETH ≥ 0.1 on every chain"). */
  balances?: Bal;
  now?: string;
  timezone?: string;
  /** §19 contacts with EIP-55 checksummed addresses. Default true. */
  contacts?: boolean;
  actions?: ActionKind[];
}

/** §19 setup: Aradhya on Base+Arbitrum, Mihir on all three, ETH 0.1 everywhere, DB6 empty, default DB5. */
export function ctxD(o: CtxOptions = {}): TestContext {
  const ctx = makeTestContext({
    seedExampleContacts: false,
    ...(o.now !== undefined ? { now: o.now } : {}),
    ...(o.timezone !== undefined ? { timezone: o.timezone } : {}),
  });
  if (o.contacts !== false) {
    seedContact(ctx.repos, 'Aradhya', ARADHYA_CS, [BASE, ARB]);
    seedContact(ctx.repos, 'Mihir', MIHIR_CS, [SEPOLIA, BASE, ARB]);
  }
  const bal: Bal = {};
  for (const c of [SEPOLIA, BASE, ARB]) {
    bal[c] = { ETH: '0.1', USDC: '0', ...(o.balances?.[c] ?? {}) };
  }
  seedBalances(ctx.repos, bal);
  ctx.req.actions = o.actions ?? ['i'];
  ctx.req.request_type = 'actions';
  ctx.req.state = 'RECIPIENTS_MASKED';
  return ctx;
}

/** Changes DB5 and the per-request snapshot together. */
export function setLimits(ctx: TestContext, patch: Partial<TestContext['limits']>): void {
  const next = { ...ctx.repos.db5.getAll(), ...patch };
  ctx.repos.db5.putAll(next, '2026-11-05T00:00:00Z');
  Object.assign(ctx.limits, patch);
}

// ───────────────────────────── S2 scan helpers ─────────────────────────────

/** Sets req.typed_text and req.scan.clauses from clause texts joined by ", ". */
export function setClauses(ctx: TestContext, texts: string[]): void {
  let pos = 0;
  ctx.req.scan.clauses = texts.map((text, index) => {
    const c = { index, start: pos, end: pos + text.length, text };
    pos += text.length + 2;
    return c;
  });
  ctx.req.typed_text = texts.join(', ');
}

export function addChainMention(ctx: TestContext, word: string, chain_id: ChainId, clause_index = 0): void {
  ctx.req.scan.chains.push({ word, chain_id, text: word, start: 0, end: word.length, clause_index });
}

export function addChrono(
  ctx: TestContext,
  kind: ChronoSpan['kind'],
  v: { date?: string; time?: string },
  clause_index = 0,
): void {
  ctx.req.scan.dates.push({
    kind,
    date: v.date ?? null,
    time: v.time ?? null,
    text: v.date ?? v.time ?? '',
    start: 0,
    end: 1,
    clause_index,
  });
}

export function addWord(ctx: TestContext, list: 'distributive' | 'split' | 'back_reference', word: string): void {
  ctx.req.scan[list].push({ word, text: word, start: 0, end: word.length, clause_index: 0 });
}

// ───────────────────────────── S3 amounts ─────────────────────────────

export interface AmountOpts {
  token?: Token;
  clause?: number;
  phrase?: string | null;
  source?: 'user' | 'untrusted';
  confirmed?: boolean;
  relative?: 'all' | 'half' | 'max' | null;
  fiat?: 'USD' | 'OTHER' | null;
  pinned_chain_id?: ChainId | null;
  code_verified?: boolean;
  untrusted_item_index?: number | null;
}

/** Mints a DB1 row and pushes the matching AmountItem (Lane B S3 output). */
export function addAmount(ctx: TestContext, amount: string, o: AmountOpts = {}): AmountPh {
  const token = o.token ?? 'USDC';
  const source = o.source ?? 'user';
  const origin = o.relative ? 'relative' : source === 'untrusted' ? 'document' : 'phrase';
  const confirmed = o.confirmed ?? true;
  const ph = ctx.repos.db1.mint({
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
    amount,
    token,
    source,
    origin,
    confirmed,
  });
  const phrase = o.phrase !== undefined ? o.phrase : source === 'untrusted' ? null : `${amount} ${token.toLowerCase()}`;
  const clause = o.clause ?? 0;
  ctx.req.amounts.push({
    placeholder: ph,
    phrase,
    span: phrase === null ? null : { text: phrase, start: 0, end: phrase.length, clause_index: clause },
    amount,
    token,
    source,
    origin,
    confirmed,
    relative: o.relative ?? null,
    fiat: o.fiat ?? null,
    pinned_chain_id: o.pinned_chain_id ?? null,
    code_verified: o.code_verified ?? true,
    untrusted_item_index: o.untrusted_item_index ?? null,
  });
  return ph;
}

/** A DB1 row only (derived / plan amounts for hand-built plans). */
export function mintAmount(
  ctx: TestContext,
  amount: string,
  token: Token = 'USDC',
  o: { source?: 'user' | 'derived' | 'untrusted'; origin?: Parameters<TestContext['repos']['db1']['mint']>[0]['origin']; confirmed?: boolean; session_id?: string } = {},
): AmountPh {
  return ctx.repos.db1.mint({
    session_id: o.session_id ?? ctx.req.session_id,
    request_id: ctx.req.request_id,
    amount,
    token,
    source: o.source ?? 'user',
    origin: o.origin ?? 'phrase',
    confirmed: o.confirmed ?? true,
  });
}

// ───────────────────────────── S5–S7 recipients ─────────────────────────────

export interface RecipientOpts {
  name: string | null;
  address: Address;
  source?: Exclude<RecipientSource, 'session'>;
  ens_name?: string | null;
  /** ENS pin (Q_ENS_CHAIN) → DB3 chain_id and resolved.pinned_chain_id. */
  pinned_chain_id?: ChainId | null;
  /** ENS-sourced: chains whose record returned the address. */
  ens_chain_ids?: ChainId[];
  clause?: number;
  untrusted_item_index?: number | null;
  /** Mint only DB3 (no span/ref), e.g. for hand-built plans. */
  dbOnly?: boolean;
}

/** Mints a DB3 single row and pushes span + RecipientRef + ResolvedRecipient (Lane C S5–S7 output). */
export function addRecipient(ctx: TestContext, o: RecipientOpts): AddressPh {
  const source = o.source ?? 'contact';
  const ph = ctx.repos.db3.mint({
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
    kind: 'single',
    name: o.name,
    address: o.address,
    ens_name: o.ens_name ?? null,
    chain_id: o.pinned_chain_id ?? null,
    group_placeholder: null,
    source,
  }) as AddressPh;
  if (o.dbOnly) return ph;
  const text = o.name ?? o.ens_name ?? o.address;
  const span_index = ctx.req.spans.length;
  const untrusted = source === 'untrusted';
  ctx.req.spans.push({
    text,
    kind: o.ens_name && !o.name ? 'ens' : o.name ? 'name' : 'address',
    role: 'payee',
    span: untrusted ? null : { text, start: 0, end: text.length, clause_index: o.clause ?? 0 },
    source: untrusted ? 'untrusted' : 'user',
    followup_placeholder: null,
    untrusted_item_index: o.untrusted_item_index ?? null,
  });
  const contactRows = ctx.repos.db2.findByAddress(o.address);
  ctx.req.resolved.push({
    span_index,
    kind: 'single',
    display_name: o.name ?? o.ens_name ?? o.address,
    address: o.address,
    ens_name: o.ens_name ?? null,
    source,
    is_contact: contactRows.length > 0,
    contact_chain_ids: contactRows.map((r) => r.chain_id),
    ens_chain_ids: o.ens_chain_ids ?? [],
    pinned_chain_id: o.pinned_chain_id ?? null,
  });
  ctx.req.recipients.push({ placeholder: ph, span_index, type: 'person', source, followup: false, last_chain_id: null });
  return ph;
}

export const addAradhya = (ctx: TestContext, clause = 0): AddressPh =>
  addRecipient(ctx, { name: 'Aradhya', address: ARADHYA_CS, source: 'contact', clause });
export const addMihir = (ctx: TestContext, clause = 0): AddressPh =>
  addRecipient(ctx, { name: 'Mihir', address: MIHIR_CS, source: 'contact', clause });

export interface GroupOpts {
  parent: string;
  chain_id: ChainId;
  /** In insertion order (S9 must sort by subname). */
  members: Array<{ subname: string; address: Address }>;
  clause?: number;
  dbOnly?: boolean;
}

/** DB3 group row + selected member rows; span/ref/resolved like Lane C §9.6. */
export function addGroup(ctx: TestContext, o: GroupOpts): { group: GroupPh; members: Record<string, AddressPh> } {
  const group = ctx.repos.db3.mint({
    session_id: ctx.req.session_id,
    request_id: ctx.req.request_id,
    kind: 'group',
    name: o.parent,
    address: null,
    ens_name: o.parent,
    chain_id: o.chain_id,
    group_placeholder: null,
    source: 'ens',
  }) as GroupPh;
  const members: Record<string, AddressPh> = {};
  for (const m of o.members) {
    members[m.subname] = ctx.repos.db3.mint({
      session_id: ctx.req.session_id,
      request_id: ctx.req.request_id,
      kind: 'member',
      name: m.subname,
      address: m.address,
      ens_name: m.subname,
      chain_id: o.chain_id,
      group_placeholder: group,
      source: 'ens',
    }) as AddressPh;
  }
  if (o.dbOnly) return { group, members };
  const span_index = ctx.req.spans.length;
  ctx.req.spans.push({
    text: o.parent,
    kind: 'group',
    role: 'payee',
    span: { text: o.parent, start: 0, end: o.parent.length, clause_index: o.clause ?? 0 },
    source: 'user',
    followup_placeholder: null,
    untrusted_item_index: null,
  });
  ctx.req.resolved.push({
    span_index,
    kind: 'group',
    display_name: o.parent,
    address: null,
    ens_name: o.parent,
    source: 'ens',
    is_contact: false,
    contact_chain_ids: [],
    ens_chain_ids: [],
    pinned_chain_id: null,
    group: {
      parent: o.parent,
      chain_id: o.chain_id,
      members: o.members.map((m) => ({ subname: m.subname, address: m.address, payable: true, selected: true })),
    },
  });
  ctx.req.recipients.push({
    placeholder: group,
    span_index,
    type: 'group',
    source: 'ens',
    followup: false,
    last_chain_id: null,
  });
  return { group, members };
}

/**
 * §17.2 follow-up: an earlier DB3 row of this session (previous request) reused under SESSION.
 * Returns the earlier placeholder.
 */
export function addFollowup(
  ctx: TestContext,
  o: { name: string; address: Address; last_chain_id: ChainId; source?: Exclude<RecipientSource, 'session'> },
): AddressPh {
  const ph = ctx.repos.db3.mint({
    session_id: ctx.req.session_id,
    request_id: 'req_0000000000a0',
    kind: 'single',
    name: o.name,
    address: o.address,
    ens_name: null,
    chain_id: null,
    group_placeholder: null,
    source: o.source ?? 'contact',
  }) as AddressPh;
  const span_index = ctx.req.spans.length;
  ctx.req.spans.push({
    text: o.name,
    kind: 'name',
    role: 'payee',
    span: null,
    source: 'user',
    followup_placeholder: ph,
    untrusted_item_index: null,
  });
  const contactRows = ctx.repos.db2.findByAddress(o.address);
  ctx.req.resolved.push({
    span_index,
    kind: 'single',
    display_name: o.name,
    address: o.address,
    ens_name: null,
    source: 'session',
    is_contact: contactRows.length > 0,
    contact_chain_ids: contactRows.map((r) => r.chain_id),
    ens_chain_ids: [],
    pinned_chain_id: null,
  });
  ctx.req.recipients.push({
    placeholder: ph,
    span_index,
    type: 'person',
    source: 'session',
    followup: true,
    last_chain_id: o.last_chain_id,
  });
  ctx.req.scan.back_reference.push({ word: 'more', text: 'more', start: 0, end: 4, clause_index: 0 });
  return ph;
}

// ───────────────────────────── S8 payments ─────────────────────────────

export interface SchedFields {
  frequency?: Frequency | null;
  interval?: number | null;
  times_per_week?: number | null;
  days_of_week?: Weekday[] | null;
  day_of_month?: number | null;
}

/** An S8 payment as LLM #4 returns it plus the DB1 token (I-06). */
export function pay(
  ctx: TestContext,
  kind: ActionKind,
  amount: AmountPh | null,
  recipient: RecipientPh,
  chain: ChainId | 'unstated' = 'unstated',
  s: SchedFields = {},
): Payment {
  return {
    kind,
    amount,
    recipient,
    chain,
    frequency: s.frequency ?? null,
    interval: s.interval ?? null,
    times_per_week: s.times_per_week ?? null,
    days_of_week: s.days_of_week ?? null,
    day_of_month: s.day_of_month ?? null,
    token: amount === null ? null : (ctx.repos.db1.get(amount)?.token ?? null),
  };
}

/** The raw LLM #4 item (no token). */
export function llmItem(
  kind: ActionKind,
  amount: AmountPh | null,
  recipient: RecipientPh,
  chain: ChainId | 'unstated' = 'unstated',
  s: SchedFields = {},
): Record<string, unknown> {
  return {
    kind,
    amount,
    recipient,
    chain,
    frequency: s.frequency ?? null,
    interval: s.interval ?? null,
    times_per_week: s.times_per_week ?? null,
    days_of_week: s.days_of_week ?? null,
    day_of_month: s.day_of_month ?? null,
  };
}

export function paymentsCall(match: string, items: Array<Record<string, unknown>>): FixtureCall {
  return { name: 'payments', match, output: { payments: items } };
}

// ───────────────────────────── DB7 / DB6 ─────────────────────────────

export function weekly(
  days: Weekday[],
  first: string,
  end: Schedule['end'],
  o: { time?: string; interval?: number; start?: string; tz?: string } = {},
): Schedule {
  return {
    frequency: 'weekly',
    interval: o.interval ?? 1,
    days_of_week: days,
    day_of_month: null,
    time_of_day: o.time ?? '10:00',
    timezone: o.tz ?? 'Asia/Kolkata',
    start_date: o.start ?? first.slice(0, 10),
    first_occurrence: first,
    end,
  };
}

export function sched(
  frequency: Frequency,
  first: string,
  end: Schedule['end'],
  o: { days?: Weekday[] | null; dom?: number | null; time?: string; interval?: number; tz?: string } = {},
): Schedule {
  return {
    frequency,
    interval: o.interval ?? 1,
    days_of_week: o.days ?? null,
    day_of_month: o.dom ?? null,
    time_of_day: o.time ?? '10:00',
    timezone: o.tz ?? 'Asia/Kolkata',
    start_date: first.slice(0, 10),
    first_occurrence: first,
    end,
  };
}

export const E6_SCHEDULE: Schedule = weekly(['FRI'], '2026-11-06T10:00:00.000+05:30', {
  type: 'on_date',
  date: '2026-12-31',
});

export function addAutopay(
  ctx: TestContext,
  o: {
    autopay_id: AutopayId;
    name?: string;
    address?: Address;
    chain_id?: ChainId;
    amount?: string;
    token?: Token;
    schedule?: Schedule;
    status?: 'active' | 'pending' | 'cancelled';
    delegate?: Address | null;
  },
): void {
  ctx.repos.db7.insertPending(
    {
      autopay_id: o.autopay_id,
      request_id: 'req_0000000000b0',
      recipient_name: o.name ?? 'Mihir',
      recipient_address: o.address ?? MIHIR_CS,
      chain_id: o.chain_id ?? BASE,
      token: o.token ?? 'USDC',
      amount_per_payment: o.amount ?? '10',
      schedule_json: JSON.stringify(o.schedule ?? E6_SCHEDULE),
    },
    '2026-11-01T00:00:00Z',
  );
  const status = o.status ?? 'active';
  if (status !== 'pending') {
    const delegate = o.delegate === undefined ? DELEGATE_CS : o.delegate;
    ctx.repos.db7.update(
      o.autopay_id,
      { status, ...(delegate !== null ? { delegate_address: delegate } : {}) },
      '2026-11-01T00:05:00Z',
    );
  }
}

export function db6Row(p: Partial<Db6Insert> & Pick<Db6Insert, 'kind' | 'amount'>): Db6Insert {
  return {
    request_id: 'req_0000000000c0',
    step: 0,
    counts_toward_limit: p.kind === 'payment' || p.kind === 'bridge_buffer' || p.kind === 'autopay_payment',
    chain_id: BASE,
    token: 'USDC',
    recipient_address: null,
    intent_id: 'i',
    autopay_id: null,
    status: 'pending',
    tx_hash: null,
    created_at: '2026-11-05T17:25:00.000Z',
    executed_at: null,
    ...p,
  };
}

// ───────────────────────────── hand-built plans (S10–S12) ─────────────────────────────

export function planI(
  step: number,
  amount: AmountPh,
  recipient: AddressPh,
  chain_id: ChainId,
  o: { token?: Token; depends_on?: number[]; reused?: ChainId | null } = {},
): PlanI {
  return {
    intent_id: 'i',
    step,
    depends_on: o.depends_on ?? [],
    token: o.token ?? 'USDC',
    chain_id,
    amount,
    recipient,
    reused_from_chain_id: o.reused ?? null,
  };
}

export function planJ(
  ctx: TestContext,
  step: number,
  source: ChainId,
  dest: ChainId,
  padded: string,
  deliverable: string,
  funds_steps: number[],
  token: Token = 'USDC',
): PlanJ {
  const decimals = token === 'USDC' ? 6 : 18;
  const amount = mintAmount(ctx, padded, token, { source: 'derived', origin: 'bridge_padded' });
  const [i = '0', f = ''] = deliverable.split('.');
  const base = (BigInt(i) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
  return {
    intent_id: 'j',
    step,
    token,
    source_chain_id: source,
    dest_chain_id: dest,
    amount,
    deliverable_base_units: base,
    receiver: 'self',
    funds_steps,
  };
}

export function planK(
  ctx: TestContext,
  step: number,
  recipient: AddressPh,
  chain_id: ChainId,
  o: {
    amount?: string;
    per_period?: string;
    total?: string;
    token?: Token;
    schedule?: Schedule;
    expires_at?: string;
    cron?: string;
    depends_on?: number[];
    autopay_id?: string;
    amountPh?: AmountPh;
  } = {},
): PlanK {
  const token = o.token ?? 'USDC';
  const schedule = o.schedule ?? E6_SCHEDULE;
  return {
    intent_id: 'k',
    step,
    depends_on: o.depends_on ?? [],
    autopay_id: o.autopay_id ?? 'ap_00000000000e',
    token,
    chain_id,
    recipient,
    amount_per_payment: o.amountPh ?? mintAmount(ctx, o.amount ?? '10', token),
    schedule,
    limits: {
      per_period_cap: mintAmount(ctx, o.per_period ?? '10', token, {
        source: 'derived',
        origin: 'autopay_per_period_cap',
      }),
      total_cap: mintAmount(ctx, o.total ?? '80', token, { source: 'derived', origin: 'autopay_total_cap' }),
      expires_at: o.expires_at ?? '2026-12-31T18:29:59Z',
    },
    cre_job: { trigger: 'cron', cron: o.cron ?? '0 10 * * 5', timezone: schedule.timezone, interval: schedule.interval },
  };
}

export function planL(step: number, recipient: AddressPh, autopay_id = 'ap_0000000000f7', chain_id: ChainId = BASE): PlanL {
  return {
    intent_id: 'l',
    step,
    autopay_id,
    chain_id,
    delegate_address: DELEGATE_CS,
    recipient,
    refund_remaining: true,
  };
}

// ───────────────────────────── assertions ─────────────────────────────

/** Asserts an error result with code (and params subset), and that the §15 catalog message renders. */
export function expectError(r: StepResult, code: ErrorCode, params?: Record<string, string>): string {
  expect(r.kind).toBe('error');
  if (r.kind !== 'error') return '';
  expect(r.code).toBe(code);
  if (params) expect(r.params ?? {}).toMatchObject(params);
  const msg = ERROR_MESSAGE[code](r.params ?? {});
  expect(typeof msg).toBe('string');
  return msg;
}

export function expectQuestion(r: StepResult, code: string): NonNullable<Extract<StepResult, { kind: 'question' }>['question']> {
  expect(r.kind).toBe('question');
  if (r.kind !== 'question') throw new Error(`expected question ${code}, got ${JSON.stringify(r)}`);
  expect(r.question.code).toBe(code);
  return r.question;
}

/** Log line assertion for INTERNAL_ERROR rule IDs (§11.1). */
export function expectRuleLogged(ctx: TestContext, rule_id: string): void {
  expect(ctx.log.lines.some((l) => l.rule_id === rule_id)).toBe(true);
}

export function instant(iso: string): number {
  return DateTime.fromISO(iso, { setZone: true }).toMillis();
}

export function db1Amount(ctx: TestContext, ph: string): string | undefined {
  return ctx.repos.db1.get(ph as AmountPh)?.amount;
}
