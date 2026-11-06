// The conversation with the agent. It connects (starting the agent if needed), opens a session in the user's time
// zone, and turns what you type into the right API call: a new message, an answer to the pending question (a chip by
// its number, members by their numbers, or your own words), or a Yes/No on a summary. It renders every reply as lines
// for the conversation, and when a plan has gone to the wallet it opens the wallet's MetaMask approval page.

import type { Question } from '../contracts/types.js';
import {
  AgentClient,
  AgentHttpError,
  AgentUnreachableError,
  type AgentApi,
  type AgentResponse,
  type AnswerBody,
  type Limits,
} from './agent/client.js';
import { LaunchError, type AgentEndpoint } from './agent/launcher.js';
import type { Command, CommandResult, Line, Segment } from './repl.js';

export interface ChatDeps {
  connect: () => Promise<AgentEndpoint>;
  client?: (endpoint: AgentEndpoint) => AgentApi;
  timezone: string;
  /** Opens a local page in the browser; returns false when it could not. */
  openPage: (url: string) => boolean;
}

const t = (text: string, tone: Segment['tone'] = 0): Segment => ({ text, tone });
const line = (...segs: Segment[]): Line => segs;
const plain = (text: string, tone: Segment['tone'] = 0): Line => [t(text, tone)];

const YES = /^(y|yes)$/i;
const NO = /^(n|no)$/i;
/** Codes after which the same request can be confirmed again (§17.3 HANDOFF_FAILED). */
const RETRYABLE = new Set(['EXECUTION_UNAVAILABLE']);

const HINT: Record<Question['input'], string> = {
  chips: 'type a number, or answer in your own words',
  multiselect: 'type the numbers to keep (e.g. 1,3) or all',
  text: 'type your answer',
  address: 'paste an address or type an ENS name',
  number: 'type an amount',
  date: 'type a date, e.g. next friday or 2026-12-01',
};

export class Chat {
  private endpoint: AgentEndpoint | undefined;
  private api: AgentApi | undefined;
  private sessionId: string | undefined;
  private connecting: Promise<Line[]> | undefined;
  /** The last reply while it waits for you: a question or a summary to confirm. */
  private pending: AgentResponse | undefined;

  constructor(private readonly deps: ChatDeps) {}

  /** Connects and opens a session; returns lines saying how it went. Safe to call again after a failure. */
  connect(): Promise<Line[]> {
    this.connecting ??= this.doConnect().catch((err: unknown) => {
      this.connecting = undefined;
      return describeFailure(err);
    });
    return this.connecting;
  }

  private async doConnect(): Promise<Line[]> {
    this.endpoint ??= await this.deps.connect();
    this.api ??= (this.deps.client ?? ((e) => new AgentClient(e.baseUrl, e.token)))(this.endpoint);
    this.sessionId = await this.api.openSession(this.deps.timezone);
    const health = await this.api.health().catch(() => undefined);
    const lines: Line[] = [
      line(t('Connected to the agent', 0), t(this.endpoint.started ? ' (started it for you)' : '', 1)),
    ];
    if (health && !health.ollama)
      lines.push(plain('The local model is not ready, so requests will fail until Ollama has it.', 1));
    return lines;
  }

  /** True once a session is open. */
  get connected(): boolean {
    return this.sessionId !== undefined;
  }

  /** Sends what you typed: a new request, or an answer or decision on the pending one. */
  async send(text: string): Promise<Line[]> {
    const lines = await this.ensureSession();
    if (lines) return lines;
    try {
      return await this.dispatch(text);
    } catch (err) {
      return this.failure(err);
    }
  }

  private async ensureSession(): Promise<Line[] | undefined> {
    if (this.sessionId) return undefined;
    const status = await this.connect();
    return this.sessionId ? undefined : status;
  }

  private async dispatch(text: string): Promise<Line[]> {
    const api = this.api!;
    const sid = this.sessionId!;
    const p = this.pending;
    const trimmed = text.trim();

    if (p && (p.state === 'awaiting_confirmation' || (p.state === 'error' && RETRYABLE.has(p.error?.code ?? '')))) {
      if (YES.test(trimmed)) return this.show(await api.confirm(sid, p.request_id, 'yes'), true);
      if (NO.test(trimmed) && p.state === 'awaiting_confirmation')
        return this.show(await api.confirm(sid, p.request_id, 'no'));
    }
    if (p?.state === 'awaiting_answer' && p.question) {
      const body = answerFor(p.question, trimmed);
      if (body) return this.show(await api.answer(sid, body));
    }
    return this.show(await api.message(sid, trimmed));
  }

  private show(r: AgentResponse, confirmed = false): Line[] {
    const waiting =
      r.state === 'awaiting_answer' ||
      r.state === 'awaiting_confirmation' ||
      (r.state === 'error' && RETRYABLE.has(r.error?.code ?? ''));
    this.pending = waiting ? r : undefined;
    const lines = render(r);
    if (confirmed && r.state === 'done' && !r.error && this.endpoint) {
      const url = this.endpoint.walletUrl;
      lines.push(
        this.deps.openPage(url)
          ? line(t('Opened your wallet to approve it in MetaMask: ', 1), t(url, 2))
          : line(t('Approve it in MetaMask: ', 1), t(url, 2)),
      );
    }
    return lines;
  }

  private failure(err: unknown): Line[] {
    if (err instanceof AgentHttpError && err.status === 404) {
      // the agent restarted and forgot the session: start a new one next time
      this.sessionId = undefined;
      this.pending = undefined;
      this.connecting = undefined;
      return [plain('The agent lost this session (it may have restarted). Send that again to start a new one.')];
    }
    if (err instanceof AgentHttpError && err.status === 409)
      return [plain('The agent is still working on the previous message, or that question has moved on.')];
    if (err instanceof AgentUnreachableError) {
      this.sessionId = undefined;
      this.connecting = undefined;
      return [plain('Lost the agent. Send that again to reconnect, or check /status.')];
    }
    return [plain('Something went wrong talking to the agent.')];
  }

  /** `/balance`: asks the agent for the balances. */
  balance(): Promise<Line[]> {
    return this.send('what is my balance');
  }

  /** `/new`: closes this session (clearing its data in the agent) and opens a fresh one. */
  async newSession(): Promise<Line[]> {
    const status = await this.ensureSession();
    if (status) return status;
    try {
      await this.api!.closeSession(this.sessionId!).catch(() => undefined);
      this.pending = undefined;
      this.sessionId = await this.api!.openSession(this.deps.timezone);
      return [plain('Started a new session. Earlier requests here are forgotten.')];
    } catch (err) {
      return this.failure(err);
    }
  }

  /** `/cancel`: drops the request waiting on a question or a confirmation. */
  async cancel(): Promise<Line[]> {
    if (!this.pending || !this.api || !this.sessionId) return [plain('Nothing is waiting to be cancelled.', 1)];
    try {
      return this.show(await this.api.cancel(this.sessionId, this.pending.request_id));
    } catch (err) {
      return this.failure(err);
    }
  }

  /**
   * `/limits` lists the spending limits; `/limits <name> <value>` changes one, and `/limits <name> <key> <value>` one
   * entry of a per-token or per-chain limit (e.g. `/limits daily_max USDC 250`).
   */
  async limits(args: string[]): Promise<Line[]> {
    const status = await this.ensureSession();
    if (status) return status;
    try {
      const current = await this.api!.getLimits();
      if (args.length === 0) return limitLines(current);
      const [name, ...rest] = args;
      if (!(name! in current)) return [plain(`There's no limit called ${name}. Type /limits to see them.`)];
      const value = parseLimitValue(rest, current[name!]);
      if (value === undefined) return [plain(limitUsage(name!, current[name!]), 1)];
      const updated = await this.api!.putLimits({ ...current, [name!]: value });
      return [line(t('Updated ', 1), t(name!, 2), t('.', 1)), ...limitLines(updated)];
    } catch (err) {
      if (err instanceof AgentHttpError && err.status === 400)
        return [plain("The agent didn't accept that value:"), ...err.fields.map((f) => plain(`- ${f}`, 1))];
      return this.failure(err);
    }
  }

  /** `/wallet`: opens the wallet's approval page. */
  wallet(): Line[] {
    if (!this.endpoint) return [plain("Not connected yet, so I don't know where the wallet is.", 1)];
    const url = this.endpoint.walletUrl;
    return this.deps.openPage(url)
      ? [line(t('Opened your wallet: ', 1), t(url, 2))]
      : [line(t("Couldn't open a browser. The wallet is at ", 1), t(url, 2))];
  }

  /** `/status`: the agent, its model and database, and whether the wallet answers. */
  async status(): Promise<Line[]> {
    const status = await this.ensureSession();
    if (status) return status;
    const health = await this.api!.health().catch(() => undefined);
    const wallet = await fetch(this.endpoint!.walletUrl, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    );
    const row = (name: string, ok: boolean | undefined, okText: string, badText: string): Line =>
      line(t(name.padEnd(9), 1), ok ? t(okText, 0) : t(badText, 2));
    return [
      row('agent', health?.ok, `running at ${this.endpoint!.baseUrl}`, 'not answering'),
      row('model', health?.ollama, 'ready', 'not ready (is Ollama running with the configured model?)'),
      row('database', health?.db, 'open', 'not readable'),
      row('wallet', wallet, `answering at ${this.endpoint!.walletUrl}`, `not running at ${this.endpoint!.walletUrl}`),
    ];
  }

  /** Closes the session (the agent clears its data) and stops an agent this CLI started. */
  async close(): Promise<void> {
    if (this.api && this.sessionId) await this.api.closeSession(this.sessionId).catch(() => undefined);
    this.sessionId = undefined;
    this.endpoint?.stop();
  }

  /** The slash commands this conversation adds to the box. */
  commands(): Command[] {
    const wrap = (f: () => Promise<Line[]> | Line[]) => async (): Promise<CommandResult> => f();
    return [
      { name: 'balance', summary: 'show your balances', run: wrap(() => this.balance()) },
      {
        name: 'limits',
        summary: 'show your limits, or change one: /limits <name> <value>',
        run: async (args) => this.limits(args),
      },
      { name: 'cancel', summary: 'drop the request waiting on you', run: wrap(() => this.cancel()) },
      { name: 'new', summary: 'start a new session', run: wrap(() => this.newSession()) },
      { name: 'wallet', summary: 'open the wallet to approve in MetaMask', run: wrap(() => this.wallet()) },
      { name: 'status', summary: 'check the agent, model and wallet', run: wrap(() => this.status()) },
    ];
  }
}

/** The answer a typed reply gives to `q`, when it picks chips by number; undefined to send it as free text. */
export function answerFor(q: Question, typed: string): AnswerBody | undefined {
  const usable = (i: number) => i >= 1 && i <= q.chips.length && !q.chips[i - 1]!.disabled;
  if (q.input === 'multiselect') {
    if (/^all$/i.test(typed))
      return { question_id: q.question_id, selected_ids: q.chips.filter((c) => !c.disabled).map((c) => c.id) };
    if (/^\d+(\s*,\s*\d+|\s+\d+)*$/.test(typed)) {
      const picks = [...new Set(typed.split(/[\s,]+/).map(Number))];
      if (picks.every(usable))
        return { question_id: q.question_id, selected_ids: picks.map((i) => q.chips[i - 1]!.id) };
    }
    return undefined;
  }
  if (q.chips.length > 0 && /^\d+$/.test(typed) && usable(Number(typed)) && q.input === 'chips')
    return { question_id: q.question_id, chip_id: q.chips[Number(typed) - 1]!.id };
  return undefined;
}

/** An agent reply as conversation lines. */
export function render(r: AgentResponse): Line[] {
  const out: Line[] = [];
  for (const m of r.messages) for (const l of m.text.split('\n')) out.push(plain(l));
  if (r.state === 'awaiting_confirmation' && r.summary) {
    out.push(plain(r.summary.text.split('\n')[0] ?? 'Please confirm:'));
    for (const l of r.summary.lines) out.push(plain(l));
    for (const n of r.summary.notes) out.push(plain(`- ${n}`, 1));
    for (const f of r.summary.footer) out.push(plain(f, 1));
    out.push(line(t('Confirm?  '), t('[y]', 2), t(' Yes  '), t('[n]', 2), t(' No')));
  }
  if (r.state === 'awaiting_answer' && r.question) {
    const q = r.question;
    out.push(line(t(q.text), t(q.attempt > 1 ? `  (try ${q.attempt} of ${q.max_attempts})` : '', 1)));
    q.chips.forEach((c, i) => {
      const mark = t(`[${i + 1}] `, c.disabled ? 1 : 2);
      out.push(line(mark, t(c.label, c.disabled ? 1 : 0), t(c.detail ? `  ${c.detail}` : '', 1)));
    });
    const hint = q.prefill ? `${HINT[q.input]}, e.g. ${q.prefill}` : HINT[q.input];
    out.push(plain(`${hint} · or cancel`, 1));
  }
  if (r.error) {
    out.push(plain(r.error.message));
    if (RETRYABLE.has(r.error.code)) out.push(line(t('Type '), t('y', 2), t(' to try again.')));
  }
  if (out.length === 0) out.push(plain('Done.', 1));
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A limit's value for display: `USDC 300 · ETH 0.15` for per-token ones, the list or value otherwise. */
function showLimit(v: unknown): string {
  if (isRecord(v))
    return Object.entries(v)
      .map(([k, x]) => `${k} ${String(x)}`)
      .join(' · ');
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function limitLines(limits: Limits): Line[] {
  const width = Math.max(...Object.keys(limits).map((k) => k.length)) + 2;
  return Object.entries(limits).map(([k, v]) => line(t(k.padEnd(width), 2), t(showLimit(v))));
}

function limitUsage(name: string, current: unknown): string {
  if (isRecord(current))
    return `Give an entry and a value: /limits ${name} ${Object.keys(current)[0] ?? '<key>'} <value>`;
  return `Give a value: /limits ${name} <value>`;
}

/**
 * The new value of a limit from the typed words, in the shape of the current one: one entry of a per-token or
 * per-chain object (amounts stay strings, as the API keeps them), numbers as numbers, lists split on commas.
 */
function parseLimitValue(words: string[], current: unknown): unknown {
  if (isRecord(current)) {
    const [key, value] = words;
    if (key === undefined || value === undefined || words.length !== 2) return undefined;
    const match = Object.keys(current).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
    return { ...current, [match]: value };
  }
  const s = words.join(' ').trim();
  if (s === '') return undefined;
  if (Array.isArray(current))
    return s
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  if (typeof current === 'number') return Number.isFinite(Number(s)) ? Number(s) : s;
  return s;
}

/** Why connecting failed, as lines to show. */
function describeFailure(err: unknown): Line[] {
  if (err instanceof LaunchError) {
    if (err.stage === 'config')
      return [
        plain("The agent's config isn't usable yet, so I can't start it:"),
        ...(err.details.length ? err.details : ['the config file could not be read'])
          .slice(0, 8)
          .map((d) => plain(`- ${d}`, 1)),
        plain(
          'It is ~/.agent-layer/config.json (or the file AGENT_CONFIG names); config.example.json shows every field.',
          1,
        ),
      ];
    if (err.stage === 'start')
      return [
        plain("The agent didn't start."),
        plain('Run npm start in the Flex folder to see why, then send your message again.', 1),
      ];
    return [plain("I couldn't read the agent's UI token file."), ...err.details.map((d) => plain(`- ${d}`, 1))];
  }
  if (err instanceof AgentHttpError && err.status === 401)
    return [plain("The agent didn't accept the UI token. Is another agent with a different config on this port?")];
  return [plain("I couldn't reach the agent."), plain('Check /status, or start it with npm start.', 1)];
}
