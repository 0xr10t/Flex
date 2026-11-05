// Lane C test helpers: a context builder for S6/S7 and a driver that answers S6 questions the way the runner does
// (src/contracts/step.ts: an AnswerHandler returning `continue` re-enters the same step).

import { getAddress } from 'viem';
import { expect } from 'vitest';
import type { StepResult } from '../../../src/contracts/step.js';
import type {
  Address,
  AddressPh,
  Answer,
  ChainId,
  ChainMention,
  GroupCandidate,
  Question,
  RecipientSpan,
  SpanKind,
} from '../../../src/contracts/types.js';
import { s6 } from '../../../src/pipeline/s6-resolve.js';
import { makeTestContext, TEST_WALLET, type TestContext } from '../../fakes/context.js';
import { CHAIN_NAMES, seedBalances, seedContact } from '../../fakes/repos.js';

export const SEPOLIA: ChainId = 11155111;
export const BASE: ChainId = 84532;
export const ARB: ChainId = 421614;

/** Coin types per §9.3 step 3. */
export const COIN = {
  [SEPOLIA]: 60n,
  [BASE]: 0x80000000n | 84532n,
  [ARB]: 0x80000000n | 421614n,
  DEFAULT: 0x80000000n,
} as const;

/** EIP-55 form of a hex address. */
export const cs = (hex: string): Address => getAddress(hex.toLowerCase()) as Address;

/** Valid checksummed test addresses (mixed case). */
export const RIYA = cs('0x3fa94b8e2d1c7a6f5e4d3c2b1a0f9e8d7c6bc21f');
export const NEWADDR = cs('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
export const OTHER = cs('0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359');
export const EVIL_A = cs('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1111');
export const EVIL_B = cs('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2222');
/** Checksummed versions of the §19 contacts (the fixture constants are not valid EIP-55). */
export const ARADHYA_CS = cs('0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E');
export const MIHIR_CS = cs('0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0');
export const WALLET_CS = cs(TEST_WALLET);
export const ZERO = '0x0000000000000000000000000000000000000000';

/** Flips the case of the first letter in the hex part → a mixed-case address with a wrong checksum. */
export function typo(address: string): string {
  const hex = address.slice(2);
  const i = hex.search(/[a-fA-F]/);
  const c = hex[i] as string;
  const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase();
  return `0x${hex.slice(0, i)}${flipped}${hex.slice(i + 1)}`;
}

/** n-th deterministic checksummed address (n ≥ 1). */
export function nthAddress(n: number): Address {
  return cs(`0x${(0xabc000000 + n).toString(16).padStart(40, 'd')}`);
}

export interface SpanSpec {
  text: string;
  kind: SpanKind;
  source?: 'user' | 'untrusted';
  followup?: AddressPh;
  clause?: number;
  /** No offsets (document / follow-up payees). */
  noSpan?: boolean;
}

export interface CtxOptions {
  /** masked_text_s3 (and typed_text). */
  text?: string;
  spans?: SpanSpec[];
  /** Chain words in the scan. */
  chains?: Array<{ word: string; chain_id: ChainId; clause?: number }>;
  groups?: Array<{ text: string; parent: string; clause?: number }>;
  /** Chains with DB4 status ok (default all three). */
  ok?: ChainId[];
  /** Chains marked unavailable in DB4. */
  unavailable?: ChainId[];
  seedExampleContacts?: boolean;
}

export function makeCtx(o: CtxOptions = {}): TestContext {
  const text = o.text ?? '';
  const ctx = makeTestContext({
    req: { typed_text: text, masked_text_s3: text },
    seedExampleContacts: o.seedExampleContacts ?? true,
  });
  const ok = o.ok ?? [SEPOLIA, BASE, ARB];
  const bal: Partial<Record<ChainId, { USDC: string; ETH: string }>> = {};
  for (const c of ok) bal[c] = { USDC: '50', ETH: '0.1' };
  seedBalances(ctx.repos, bal);
  for (const c of o.unavailable ?? []) ctx.repos.db4.markUnavailable(c, CHAIN_NAMES[c], new Date().toISOString());

  let from = 0;
  const spans: RecipientSpan[] = [];
  for (const s of o.spans ?? []) {
    let span: RecipientSpan['span'] = null;
    if (!s.noSpan && s.followup === undefined) {
      const start = text.indexOf(s.text, from);
      if (start < 0) throw new Error(`span text not in masked text: ${s.text}`);
      from = start + s.text.length;
      span = { text: s.text, start, end: start + s.text.length, clause_index: s.clause ?? 0 };
    }
    spans.push({
      text: s.text,
      kind: s.kind,
      role: 'payee',
      span,
      source: s.source ?? 'user',
      followup_placeholder: s.followup ?? null,
      untrusted_item_index: s.source === 'untrusted' ? 0 : null,
    });
  }
  ctx.req.spans = spans;
  ctx.req.scan.chains = (o.chains ?? []).map((c): ChainMention => {
    const start = Math.max(0, text.indexOf(c.word));
    return {
      text: c.word,
      word: c.word,
      chain_id: c.chain_id,
      start,
      end: start + c.word.length,
      clause_index: c.clause ?? 0,
    };
  });
  ctx.req.scan.groups = (o.groups ?? []).map((g): GroupCandidate => {
    const start = Math.max(0, text.indexOf(g.text));
    return { text: g.text, parent: g.parent, start, end: start + g.text.length, clause_index: g.clause ?? 0 };
  });
  return ctx;
}

/** Adds a DB2 contact (checksummed address). */
export function contact(
  ctx: TestContext,
  name: string,
  address: Address,
  chains: ChainId[] = [SEPOLIA, BASE, ARB],
  ens: string | null = null,
): void {
  seedContact(ctx.repos, name, address, chains, ens);
}

/**
 * Drives S6 like the runner: `start()` calls the step; `answer()` calls onAnswer and, on `continue`, re-enters the
 * step. Every StepResult is recorded.
 */
export class Driver {
  results: StepResult[] = [];
  constructor(public ctx: TestContext) {}

  get last(): StepResult {
    const r = this.results[this.results.length - 1];
    if (r === undefined) throw new Error('nothing run yet');
    return r;
  }

  /** The pending question (fails the test when the last result is not a question). */
  get q(): Question {
    const r = this.last;
    if (r.kind !== 'question') throw new Error(`expected a question, got ${JSON.stringify(r)}`);
    return r.question;
  }

  async start(): Promise<StepResult> {
    const r = await s6.step(this.ctx);
    this.results.push(r);
    return r;
  }

  async answer(a: Answer): Promise<StepResult> {
    const handler = s6.onAnswer;
    if (handler === undefined) throw new Error('s6 has no onAnswer');
    const q = this.q;
    let r = await handler(this.ctx, q, a);
    if (r.kind === 'continue') r = await s6.step(this.ctx);
    this.results.push(r);
    return r;
  }

  chip(chip_id: string): Promise<StepResult> {
    return this.answer({ kind: 'chip', chip_id });
  }

  text(text: string): Promise<StepResult> {
    return this.answer({ kind: 'text', text });
  }

  select(selected_ids: string[]): Promise<StepResult> {
    return this.answer({ kind: 'selected', selected_ids });
  }
}

export async function start(o: CtxOptions = {}): Promise<{ ctx: TestContext; d: Driver }> {
  const ctx = makeCtx(o);
  const d = new Driver(ctx);
  await d.start();
  return { ctx, d };
}

/** Asserts the last result is a question with this code (and attempt, if given); returns it. */
export function expectQuestion(d: Driver, code: Question['code'], attempt?: number): Question {
  const q = d.q;
  expect(q.code).toBe(code);
  if (attempt !== undefined) expect(q.attempt).toBe(attempt);
  expect(q.max_attempts).toBe(4);
  expect(q.question_id).toMatch(/^q_[0-9a-f]{12}$/);
  return q;
}

export function expectError(d: Driver, code: string): void {
  expect(d.last).toMatchObject({ kind: 'error', code });
}

/** §18: log lines carry only allowlisted fields and never a name, address or ENS name. */
export function expectCleanLogs(ctx: TestContext, forbidden: string[]): void {
  const allowed = new Set([
    'ts',
    'level',
    'session_id',
    'request_id',
    'step',
    'state',
    'event',
    'error_code',
    'question_code',
    'attempt',
    'llm_call',
    'llm_retry',
    'duration_ms',
    'n_amounts',
    'n_payees',
    'n_intents',
    'rule_id',
    'chain_ids_unavailable',
    'http_status',
  ]);
  for (const line of ctx.log.lines) for (const k of Object.keys(line)) expect(allowed.has(k)).toBe(true);
  const dump = JSON.stringify(ctx.log.lines).toLowerCase();
  expect(dump).not.toMatch(/0x[0-9a-f]{6}/);
  for (const f of forbidden) expect(dump).not.toContain(f.toLowerCase());
}
