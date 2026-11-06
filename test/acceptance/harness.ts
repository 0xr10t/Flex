// Acceptance harness (ORCHESTRATOR_PROMPT §3.1). Starts the agent in-process: temp SQLCipher DB, in-memory fake
// keychain, mocked RPC / ENS / indexer / fetcher / execution layer, the LLM fixture client instead of Ollama, the
// real allowlist logger writing to a suite-wide log directory (A-60), and the step registry imported from
// src/pipeline/registry.ts (so the suite works unchanged once the Orchestrator wires the real steps).
// Everything is driven through the HTTP API (spec §14.1) with Fastify `inject`; no sockets.
//
// Owned by the Acceptance Tester. Does not modify src/**.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { getAddress } from 'viem';
import { expect } from 'vitest';
import { LOG_ALLOWED_FIELDS } from '../../src/contracts/io.js';
import type { LlmCallArgs, LlmClient } from '../../src/contracts/llm.js';
import type { Repos } from '../../src/contracts/repos.js';
import { toBaseUnits } from '../../src/contracts/money.js';
import type {
  AgentResponse,
  Chip,
  ChainId,
  Config,
  ExecutionReport,
  Question,
  QuestionCode,
  Token,
} from '../../src/contracts/types.js';
import { chainNames } from '../../src/config/load.js';
import { getOrCreateDbKey, type KeyStore } from '../../src/db/keychain.js';
import type { Database } from '../../src/db/database.js';
import { openDatabase } from '../../src/db/open.js';
import { createRepos } from '../../src/db/repos/index.js';
import { registry } from '../../src/pipeline/registry.js';
import { createApp } from '../../src/server/app.js';
import { createLogger, type Logger } from '../../src/util/logger.js';
import { testConfig, TEST_WALLET } from '../fakes/context.js';
import { CapturingLogger, FakeEns, FakeExecution, FakeFetcher, FakeRpc, FakeSubnames } from '../fakes/io.js';
import { FixtureLlmClient, type FixtureCall, type FixtureFile, type RecordedCall } from '../fakes/llm.js';

export const UI_TOKEN = 'ui-token-acceptance-0000000000000000000000000000000000000000000000';
export const REPORT_TOKEN = 'report-token-acceptance-00000000000000000000000000000000000000000';
export const NOW_ISO = '2026-11-05T17:30:00.000Z'; // Thu 2026-11-05 23:00 Asia/Kolkata (E6)
export const TZ = 'Asia/Kolkata';

// ───────────────────────────── constants shared by tests ─────────────────────────────

export const WALLET = TEST_WALLET;
export const ARADHYA = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E' as const;
export const MIHIR = '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0' as const;
export const SEPOLIA = 11155111 as const;
export const BASE = 84532 as const;
export const ARB = 421614 as const;
export const USDC_ADDR: Record<ChainId, string> = {
  11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  421614: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
};
export const CHAIN_NAME: Record<ChainId, string> = {
  11155111: 'Sepolia',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
};
/** Deterministic, valid EIP-55 test address #n. */
export const addr = (n: number): `0x${string}` => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
/** ENS coin type for a chain (§9.3 step 3): 60 for Sepolia, 0x80000000 | chainId for L2s. */
export const coinType = (c: ChainId): bigint => (c === SEPOLIA ? 60n : 0x80000000n | BigInt(c));
export const DEFAULT_COIN_TYPE = 0x80000000n;
export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export type Balances = Partial<Record<ChainId, Partial<Record<Token, string>>>>;
/** SQ-20: the E1 balances. */
export const E1_BALANCES: Balances = {
  11155111: { USDC: '0', ETH: '0.1' },
  84532: { USDC: '80', ETH: '0.1' },
  421614: { USDC: '60', ETH: '0.1' },
};

// ───────────────────────────── suite-wide sensitive-value registry (A-60) ─────────────────────────────

const SUITE_LOG_DIR = mkdtempSync(join(tmpdir(), 'agent-acceptance-logs-'));
export const suiteLogDir = (): string => SUITE_LOG_DIR;

export type SensitiveKind = 'address' | 'name' | 'ens' | 'prompt' | 'amount';
const sensitive = new Map<string, SensitiveKind>();
export function registerSensitive(kind: SensitiveKind, ...values: string[]): void {
  for (const v of values) if (v.trim() !== '') sensitive.set(v, kind);
}
export const sensitiveValues = (): Array<[string, SensitiveKind]> => [...sensitive.entries()];
/** Prompt fragments: the whole text and every window of three words. */
function registerPrompt(text: string): void {
  registerSensitive('prompt', text);
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i + 3 <= words.length; i++) registerSensitive('prompt', words.slice(i, i + 3).join(' '));
}

export interface LogHit {
  file: string;
  kind: SensitiveKind | 'field';
  value: string;
}

/** Scans every log file in `dir`. A hit is any sensitive value in a line, or any non-allowlisted field. */
export function scanLogs(dir: string, values: Array<[string, SensitiveKind]>): { lines: number; hits: LogHit[] } {
  const hits: LogHit[] = [];
  let lines = 0;
  if (!existsSync(dir)) return { lines, hits };
  for (const file of readdirSync(dir)) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      lines++;
      const lower = line.toLowerCase();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        hits.push({ file, kind: 'field', value: '<unparseable line>' });
        continue;
      }
      for (const key of Object.keys(parsed)) {
        if (!LOG_ALLOWED_FIELDS.includes(key)) hits.push({ file, kind: 'field', value: key });
      }
      const strings = Object.entries(parsed)
        .filter(([k, v]) => k !== 'ts' && typeof v === 'string')
        .map(([, v]) => v as string);
      for (const [value, kind] of values) {
        if (kind === 'amount') {
          const re = new RegExp(`(?<![\\w.])${value.replace(/\./g, '\\.')}(?![\\w.])`);
          if (strings.some((s) => re.test(s))) hits.push({ file, kind, value });
        } else if (lower.includes(value.toLowerCase())) {
          hits.push({ file, kind, value });
        }
      }
    }
  }
  return { lines, hits };
}

// ───────────────────────────── LLM fixture client with symbolic placeholders ─────────────────────────────

/**
 * Wraps the frozen FixtureLlmClient. Placeholders are random at run time, so a `payments` fixture refers to them
 * as "$amount:N" / "$recipient:N" (N-th entry of the AMOUNTS / RECIPIENTS list in the prompt the pipeline built);
 * they are replaced before the output is validated against the per-request schema.
 */
export class AcceptanceLlm implements LlmClient {
  readonly recorded: RecordedCall[] = [];
  private entries: FixtureCall[];
  available = true;
  constructor(fixture: FixtureFile) {
    this.entries = [...fixture.calls];
  }
  async modelAvailable(): Promise<boolean> {
    return this.available;
  }
  remaining(): FixtureCall[] {
    return [...this.entries];
  }
  names(): string[] {
    return this.recorded.map((r) => r.name);
  }
  private resolve(value: unknown, user: string): unknown {
    const list = (label: string): string[] => {
      const m = new RegExp(`^${label}: (\\[.*\\])`, 'm').exec(user);
      if (!m?.[1]) return [];
      return (JSON.parse(m[1]) as Array<{ placeholder: string }>).map((x) => x.placeholder);
    };
    const amounts = list('AMOUNTS');
    const recipients = list('RECIPIENTS');
    const walk = (v: unknown): unknown => {
      if (typeof v === 'string') {
        const m = /^\$(amount|recipient):(\d+)$/.exec(v);
        if (m) {
          const pick = (m[1] === 'amount' ? amounts : recipients)[Number(m[2])];
          if (pick === undefined) throw new Error(`fixture reference ${v} not present in the prompt`);
          return pick;
        }
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      return v;
    };
    return walk(value);
  }
  async call<T>(args: LlmCallArgs): Promise<T> {
    const group: FixtureCall[] = [];
    if (this.entries[0]) group.push(this.entries[0]);
    while (this.entries[group.length] && this.entries[group.length]!.attempt === 2)
      group.push(this.entries[group.length]!);
    const resolved = group.map((e) => ({ ...e, output: this.resolve(e.output, args.user) }));
    const inner = new FixtureLlmClient({ calls: resolved });
    try {
      return await inner.call<T>(args);
    } finally {
      this.recorded.push(...inner.recorded);
      this.entries.splice(0, group.length - inner.remaining().length);
    }
  }
}

// ───────────────────────────── harness ─────────────────────────────

export type Answer = { chip: string } | { text: string } | { selected: string[] };

/** One scripted answer for `drive`. Labels are matched against chip labels (exact, then substring). */
export interface Step {
  code: QuestionCode;
  chip?: string;
  text?: string;
  selected?: string[];
}

export interface Resp {
  http: number;
  body: AgentResponse;
}

export interface HarnessOptions {
  balances?: Balances | null;
  contacts?: boolean;
  clock?: string;
}

let harnessCounter = 0;

export class Harness {
  readonly repos: Repos;
  readonly db: Database;
  readonly app: FastifyInstance;
  readonly llm: AcceptanceLlm;
  readonly rpc = new FakeRpc();
  readonly ens = new FakeEns();
  readonly subnames = new FakeSubnames();
  readonly exec = new FakeExecution();
  readonly fetcher = new FakeFetcher();
  readonly config: Config = testConfig();
  readonly capture = new CapturingLogger();
  readonly logger: Logger;
  readonly logFile: string;
  clock: DateTime;
  sessionId = '';
  /** Question codes seen by `say`/`answer`, in order. */
  readonly asked: QuestionCode[] = [];

  constructor(
    readonly id: string,
    fixture: FixtureFile,
    o: HarnessOptions,
  ) {
    const dir = mkdtempSync(join(tmpdir(), 'agent-acceptance-'));
    const store: KeyStore = (() => {
      let v: string | null = null;
      return { get: () => v, set: (x: string) => void (v = x) };
    })(); // fake keychain
    const key = getOrCreateDbKey(store);
    this.db = openDatabase(join(dir, 'agent.db'), key);
    this.clock = DateTime.fromISO(o.clock ?? NOW_ISO, { zone: 'utc' });
    const names = chainNames(this.config);
    this.repos = createRepos(this.db, {
      now: () => this.clock.toUTC().toISO() ?? NOW_ISO,
      chainName: (c) => names[c] ?? String(c),
    });
    this.repos.db5.insertDefaultsIfMissing(this.clock.toUTC().toISO() ?? NOW_ISO);
    mkdirSync(SUITE_LOG_DIR, { recursive: true });
    this.logFile = join(SUITE_LOG_DIR, `${id}-${++harnessCounter}.log`);
    this.logger = createLogger({ file: this.logFile });
    this.llm = new AcceptanceLlm(fixture);
    this.app = createApp({
      repos: this.repos,
      llm: this.llm,
      rpc: this.rpc,
      ens: this.ens,
      subnames: this.subnames,
      exec: this.exec,
      fetcher: this.fetcher,
      log: this.logger,
      config: this.config,
      registry, // src/pipeline/registry.ts
      tokens: { ui: UI_TOKEN, report: REPORT_TOKEN },
      clock: () => this.clock,
    });
    if (o.balances !== null) this.setBalances(o.balances ?? E1_BALANCES);
    if (o.contacts !== false) this.seedContacts();
  }

  /** Sets the balances the mocked RPC returns (decimal strings). Unlisted values stay as they were. */
  setBalances(b: Balances): void {
    for (const [cid, toks] of Object.entries(b)) {
      const c = Number(cid) as ChainId;
      if (toks?.USDC !== undefined) this.rpc.usdc.set(c, toBaseUnits(toks.USDC, 6));
      if (toks?.ETH !== undefined) this.rpc.eth.set(c, toBaseUnits(toks.ETH, 18));
    }
  }

  /** §19 setup: Aradhya on Base+Arbitrum, Mihir on all three chains. */
  seedContacts(): void {
    this.addContact('Aradhya', ARADHYA, [BASE, ARB]);
    this.addContact('Mihir', MIHIR, [SEPOLIA, BASE, ARB]);
  }

  addContact(name: string, address: `0x${string}`, chains: ChainId[], ens: string | null = null): void {
    const r = this.repos.db2.addContact({ name, address, chain_ids: chains, ens_name: ens });
    if (!r.ok) throw new Error(`addContact ${r.reason}`);
    registerSensitive('name', name);
    registerSensitive('address', address);
    if (ens) registerSensitive('ens', ens);
  }

  advance(minutes: number): void {
    this.clock = this.clock.plus({ minutes });
  }
  get nowIso(): string {
    return this.clock.toUTC().toISO() ?? NOW_ISO;
  }

  // ── raw HTTP ──
  async http(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    opts: { token?: string | null; body?: unknown } = {},
  ): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
    const headers: Record<string, string> = {};
    if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? UI_TOKEN}`;
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.inject({ method, url, headers, ...(payload !== undefined ? { payload } : {}) });
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { status: res.statusCode, json, text: res.body };
  }

  // ── UI-like API ──
  async open(timezone = TZ): Promise<string> {
    const r = await this.http('POST', '/v1/sessions', { body: { timezone } });
    expect(r.status).toBe(200);
    this.sessionId = r.json.session_id as string;
    return this.sessionId;
  }
  async close(): Promise<number> {
    return (await this.http('DELETE', `/v1/sessions/${this.sessionId}`)).status;
  }
  private track(r: Resp): Resp {
    if (r.body.question) this.asked.push(r.body.question.code);
    return r;
  }
  /** POST /messages. Opens a session first when none is open. */
  async say(
    text: string,
    extra: {
      pasted_blocks?: string[];
      attachments?: Array<{ filename: string; mime: string; base64: string }>;
      urls?: string[];
    } = {},
  ): Promise<Resp> {
    if (this.sessionId === '') await this.open();
    registerPrompt(text);
    for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) registerSensitive('amount', m[0]);
    for (const p of extra.pasted_blocks ?? []) registerPrompt(p);
    const r = await this.http('POST', `/v1/sessions/${this.sessionId}/messages`, { body: { text, ...extra } });
    return this.track({ http: r.status, body: r.json as unknown as AgentResponse });
  }
  /** Finds a chip by label (exact, then case-insensitive substring). */
  chip(q: Question, label: string): Chip {
    const c =
      q.chips.find((x) => x.label === label) ??
      q.chips.find((x) => x.label.toLowerCase().includes(label.toLowerCase()));
    if (!c) throw new Error(`no chip "${label}" in ${q.code}: ${JSON.stringify(q.chips.map((x) => x.label))}`);
    return c;
  }
  async answer(
    r: Resp | AgentResponse,
    a: Answer | { chipLabel: string } | { selectedLabels: string[] },
  ): Promise<Resp> {
    const body = 'body' in r ? r.body : r;
    const q = body.question;
    if (!q) throw new Error('answer: no pending question');
    let payload: Record<string, unknown>;
    if ('chipLabel' in a) payload = { question_id: q.question_id, chip_id: this.chip(q, a.chipLabel).id };
    else if ('selectedLabels' in a)
      payload = { question_id: q.question_id, selected_ids: a.selectedLabels.map((l) => this.chip(q, l).id) };
    else if ('chip' in a) payload = { question_id: q.question_id, chip_id: a.chip };
    else if ('text' in a) {
      registerPrompt(a.text);
      payload = { question_id: q.question_id, text: a.text };
    } else payload = { question_id: q.question_id, selected_ids: a.selected };
    const res = await this.http('POST', `/v1/sessions/${this.sessionId}/answers`, { body: payload });
    return this.track({ http: res.status, body: res.json as unknown as AgentResponse });
  }
  async confirm(r: Resp | AgentResponse, decision: 'yes' | 'no'): Promise<Resp> {
    const body = 'body' in r ? r.body : r;
    const res = await this.http('POST', `/v1/sessions/${this.sessionId}/confirm`, {
      body: { request_id: body.request_id, decision },
    });
    return this.track({ http: res.status, body: res.json as unknown as AgentResponse });
  }
  async cancel(r: Resp | AgentResponse): Promise<Resp> {
    const body = 'body' in r ? r.body : r;
    const res = await this.http('POST', `/v1/sessions/${this.sessionId}/cancel`, {
      body: { request_id: body.request_id },
    });
    return this.track({ http: res.status, body: res.json as unknown as AgentResponse });
  }
  async report(body: ExecutionReport, token: string | null = REPORT_TOKEN): Promise<number> {
    return (await this.http('POST', '/v1/execution/reports', { token, body })).status;
  }

  /**
   * Answers questions from a script until a non-question response. Each scripted step must match the code of the
   * question actually asked, in order (this is how tests assert "question codes and order").
   */
  async drive(first: Resp, script: Step[]): Promise<Resp> {
    let r = first;
    for (const s of script) {
      expect(
        r.body.question?.code,
        `expected question ${s.code}, got ${r.body.question?.code ?? r.body.state} / ${r.body.error?.code ?? ''}`,
      ).toBe(s.code);
      if (s.chip !== undefined) r = await this.answer(r, { chipLabel: s.chip });
      else if (s.selected !== undefined) r = await this.answer(r, { selectedLabels: s.selected });
      else r = await this.answer(r, { text: s.text ?? '' });
    }
    return r;
  }

  /** Say + drive + confirm "yes". Returns the confirm response. */
  async sayAndConfirm(text: string, script: Step[] = []): Promise<Resp> {
    const r = await this.drive(await this.say(text), script);
    expect(r.body.state).toBe('awaiting_confirmation');
    return this.confirm(r, 'yes');
  }

  // ── DB inspection ──
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  /** All rows of every persistent table in a canonical form (A-53 "unchanged"). */
  snapshot(tables: string[]): string {
    return JSON.stringify(tables.map((t) => this.rows(`SELECT * FROM ${t} ORDER BY 1, 2`)));
  }

  /** The single envelope submitted so far (asserts exactly one). */
  get envelope(): import('../../src/contracts/types.js').HandoffEnvelope {
    expect(this.exec.submissions.length).toBeGreaterThanOrEqual(1);
    return this.exec.submissions[this.exec.submissions.length - 1]!.envelope;
  }

  /** Asserts every fixture entry was consumed, then closes DB and log. */
  async finish(opts: { allowUnused?: boolean } = {}): Promise<void> {
    try {
      if (!opts.allowUnused) expect(this.llm.remaining(), 'unused LLM fixture entries').toEqual([]);
    } finally {
      await this.app.close();
      this.db.close();
      this.logger.close();
    }
  }
}

export function loadFixture(id: string): FixtureFile {
  const p = join(import.meta.dirname, '..', 'fixtures', 'llm', `${id}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as FixtureFile) : { calls: [] };
}

/** Creates a harness whose LLM fixtures are `test/fixtures/llm/<fixtureId>.json`. */
export async function harness(fixtureId: string, o: HarnessOptions = {}): Promise<Harness> {
  return new Harness(fixtureId, loadFixture(fixtureId), o);
}

// ───────────────────────────── assertion helpers ─────────────────────────────

export const stripNum = (l: string): string => l.replace(/^\d+\.\s+/, '');
export const lines = (r: Resp): string[] => (r.body.summary?.lines ?? []).map(stripNum);

export interface Amt {
  value: string;
  base_units: string;
  decimals: 6 | 18;
}
export const usdc = (v: string): Amt => ({ value: v, base_units: toBaseUnits(v, 6).toString(), decimals: 6 });
export const eth = (v: string): Amt => ({ value: v, base_units: toBaseUnits(v, 18).toString(), decimals: 18 });

/** Replaces date-time strings by epoch ms so formats ("Z" vs ".000Z" vs offsets) compare as instants. */
export function normalizeTimes<T>(v: T): T {
  const walk = (x: unknown, key = ''): unknown => {
    if (typeof x === 'string' && ['created_at', 'first_occurrence', 'expires_at'].includes(key)) return Date.parse(x);
    if (Array.isArray(x)) return x.map((i) => walk(i));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, i]) => [k, walk(i, k)]));
    return x;
  };
  return walk(v) as T;
}

export const AUTOPAY_ID = /^ap_[0-9a-f]{12}$/;
export const REQUEST_ID = /^req_[0-9a-f]{12}$/;

/** Expected envelope head, to be spread with `intents`. */
export function head(h: Harness, request_id: string): Record<string, unknown> {
  return { version: '1', request_id, wallet_address: WALLET, created_at: h.nowIso };
}
