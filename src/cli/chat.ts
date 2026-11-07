// The conversation with the agent. It connects (starting the agent if needed), opens a session in the user's time
// zone, and turns what you type into the right API call: a new message, an answer to the pending question (a chip by
// its number, members by their numbers, or your own words), or a Yes/No on a summary. It renders every reply as lines
// for the conversation, and when a plan has gone to the wallet it opens the wallet's MetaMask approval page.

import { ContactsPanel } from './contacts.js';
import { copyText, readClipboard } from './open.js';
import { dataCatalog, parseGetter, renderData } from './data.js';
import { connect } from 'node:net';
import { homedir } from 'node:os';
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
import type { Command, CommandContext, CommandResult, Line, Segment } from './repl.js';

export interface ChatDeps {
  connect: () => Promise<AgentEndpoint>;
  client?: (endpoint: AgentEndpoint) => AgentApi;
  timezone: string;
  /** Opens a local page in the browser; returns false when it could not. */
  openPage: (url: string) => boolean;
  /** Puts text on the clipboard, for /copy. */
  copy?: (text: string) => Promise<boolean>;
  paste?: () => Promise<string | undefined>;
  /** flexx's version, for /version. */
  version?: string;
  /** How /doctor reaches Ollama and the wallet, and checks Tor's port (tests replace them). */
  probe?: { fetch?: typeof fetch; port?: (host: string, port: number) => Promise<boolean> };
}

/** True when something listens on `host:port` (Tor's SOCKS port). */
function portOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** Node versions the project supports: 22.12+ on the 22 line, or 24 and later. */
export function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return (major === 22 && minor >= 12) || major >= 24;
}

const t = (text: string, tone: Segment['tone'] = 0): Segment => ({ text, tone });
const line = (...segs: Segment[]): Line => segs;
const plain = (text: string, tone: Segment['tone'] = 0): Line => [t(text, tone)];

/** The words the agent accepts as yes and no to a summary, and as cancelling (§17.3). */
const YES = /^(y|yes|confirm|go ahead|ok|okay|do it|send it)$/i;
const NO = /^(n|no|don'?t|stop)$/i;
const CANCEL = /^(cancel|abort|never ?mind|forget it)$/i;
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

    if (p?.state === 'awaiting_confirmation') {
      const words = trimmed.toLowerCase().replace(/[.!]+$/, '');
      if (YES.test(words)) return this.show(await api.confirm(sid, p.request_id, 'yes'), true);
      if (NO.test(words)) return this.show(await api.confirm(sid, p.request_id, 'no'));
      if (CANCEL.test(words)) return this.show(await api.cancel(sid, p.request_id));
      // anything else would drop the plan and start a new request: keep the plan and ask again
      return confirmAgain();
    }
    if (p?.state === 'error' && RETRYABLE.has(p.error?.code ?? '') && YES.test(trimmed))
      return this.show(await api.confirm(sid, p.request_id, 'yes'), true);
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
      // the wallet's approval view for this request: its details filled in, MetaMask opening by itself
      const url = `${this.endpoint.walletUrl}#approve=${r.request_id}`;
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

  async getData(args: string[]): Promise<Line[]> {
    if (!args.length) return dataCatalog();
    const ready = await this.ensureSession();
    if (ready) return ready;
    const parsed = parseGetter(args, this.sessionId!);
    if (Array.isArray(parsed)) return parsed;
    if (!this.api?.readData) return [plain('This agent client does not support data getters yet.', 1)];
    try {
      return renderData(await this.api.readData(parsed.resource, parsed.query), parsed.json);
    } catch (e) {
      // Read failures must not clear the question/confirmation held by this client.
      if (e instanceof AgentHttpError && e.status === 404)
        return [
          plain('This getter is unavailable on the running agent.', 1),
          plain('Restart the updated agent and wallet services, or check /status.', 1),
        ];
      return [
        plain('Could not read this data. Your pending request is unchanged.', 1),
        plain('Check /status or /doctor.', 1),
      ];
    }
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

  /** `/config`: the setup flexx and the agent use, without RPC URLs (they carry provider keys) or tokens. */
  async config(): Promise<Line[]> {
    const status = await this.ensureSession();
    const info = this.endpoint?.info;
    if (!info) return status ?? [plain('No config details are available.', 1)];
    const home = homedir();
    const row = (k: string, v: string): Line => line(t(k.padEnd(12), 2), t(v));
    return [
      row('config', info.configFile.startsWith(home) ? '~' + info.configFile.slice(home.length) : info.configFile),
      row('wallet', info.wallet),
      row('networks', info.chains.join(', ')),
      row('model', `${info.model} (Ollama at ${info.ollamaUrl})`),
      row('traffic', info.proxy ? `through Tor (${info.proxy})` : 'direct, no Tor'),
      row('ENS groups', info.ensIndexer ? 'on' : 'off (no indexer configured)'),
      row('links', info.readLinks ? 'read links you paste' : 'links are not opened'),
      row('agent', this.endpoint!.baseUrl + (this.endpoint!.started ? ' (started by flexx)' : '')),
      row('approvals', this.endpoint!.walletUrl),
      ...(status ?? []),
    ];
  }

  /** `/doctor`: checks everything a payment needs, each with what to do when it fails. */
  async doctor(): Promise<Line[]> {
    const fetchImpl = this.deps.probe?.fetch ?? fetch;
    const port = this.deps.probe?.port ?? portOpen;
    const ok = (name: string, detail: string): Line => line(t('✓ ', 2), t(name.padEnd(10)), t(detail, 1));
    const bad = (name: string, detail: string): Line => line(t('✗ ', 0), t(name.padEnd(10)), t(detail, 2));
    const out: Line[] = [];
    out.push(
      nodeSupported(process.versions.node)
        ? ok('node', process.versions.node)
        : bad('node', `${process.versions.node} isn't supported; use 22.12+ or 24+ (nvm use)`),
    );

    const status = await this.ensureSession();
    if (status) {
      out.push(bad('agent', 'not connected:'), ...status.map((l) => [t('    '), ...l]));
      return out;
    }
    const info = this.endpoint!.info;
    const health = await this.api!.health().catch(() => undefined);
    out.push(
      health?.ok ? ok('agent', this.endpoint!.baseUrl) : bad('agent', 'not answering; try /new or restart flexx'),
    );
    out.push(health?.db ? ok('database', 'open') : bad('database', "can't be read; check the keychain prompt"));

    if (info) {
      const tags = await fetchImpl(`${info.ollamaUrl.replace(/\/+$/, '')}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      })
        .then((r) => r.json() as Promise<{ models?: Array<{ name: string }> }>)
        .catch(() => undefined);
      if (!tags) out.push(bad('ollama', `not running at ${info.ollamaUrl}; start it with: ollama serve`));
      else if (!tags.models?.some((m) => m.name === info.model || m.name === `${info.model}:latest`))
        out.push(bad('model', `${info.model} isn't pulled; run: ollama pull ${info.model}`));
      else out.push(ok('model', `${info.model} ready`));

      if (info.proxy) {
        const m = /^socks5h:\/\/([^:/]+):(\d+)/.exec(info.proxy);
        const up = m ? await port(m[1]!, Number(m[2])) : false;
        out.push(up ? ok('tor', info.proxy) : bad('tor', 'not running; start it with: brew services start tor'));
      } else out.push(ok('tor', 'off: connecting directly'));
    }

    const wallet = await fetchImpl(this.endpoint!.walletUrl, { signal: AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    );
    out.push(
      wallet
        ? ok('wallet', this.endpoint!.walletUrl)
        : bad('wallet', 'not running; start it with: node wallet/dist/src/main.js .local/wallet.config.json'),
    );
    return out;
  }

  /** `/copy`: puts the latest reply on the clipboard. */
  async copyLast(ctx: CommandContext): Promise<Line[]> {
    const text = ctx.selectedText ?? ctx.lastReply;
    if (!text) return [plain('There is no reply to copy yet.', 1)];
    const copied = await (this.deps.copy?.(text) ?? Promise.resolve(false));
    return copied
      ? [plain(ctx.selectedText ? 'Copied selection to the clipboard.' : 'Copied the last reply to the clipboard.', 1)]
      : [plain("Couldn't reach the clipboard.", 1)];
  }

  /** Closes the session (the agent clears its data) and stops an agent this CLI started. */
  async close(): Promise<void> {
    if (this.api && this.sessionId) await this.api.closeSession(this.sessionId).catch(() => undefined);
    this.sessionId = undefined;
    this.endpoint?.stop();
  }

  async contacts(): Promise<CommandResult> {
    const status = await this.ensureSession();
    if (status) return status;
    const api = this.api!;
    if (!api.listContacts || !api.updateContact)
      return [plain('Address-book editing is unavailable. Restart the agent after updating.')];
    try {
      const page = await api.listContacts();
      return {
        kind: 'panel',
        panel: new ContactsPanel(page, {
          list: (offset) => api.listContacts!(offset),
          save: (id, edit) => api.updateContact!(id, edit),
          copy: this.deps.copy ?? copyText,
          paste: this.deps.paste ?? readClipboard,
        }),
      };
    } catch {
      return [plain('Could not load contacts. Check /status and restart the agent after updating.')];
    }
  }

  /** The slash commands this conversation adds to the box. */
  commands(): Command[] {
    const wrap = (f: () => Promise<Line[]> | Line[]) => async (): Promise<CommandResult> => f();
    return [
      { name: 'db', summary: 'list the databases, caches and getter commands', run: () => dataCatalog() },
      {
        name: 'get',
        summary: 'read local records without changing the pending payment',
        args: '<resource> [filters] [--json]',
        run: (args) => this.getData(args),
      },
      { name: 'contacts', summary: 'read or edit saved contacts and their networks', run: () => this.contacts() },
      { name: 'balance', summary: 'show your balances', aliases: ['balances'], run: wrap(() => this.balance()) },
      {
        name: 'limits',
        summary: 'show your spending limits, or change one',
        args: '[name] [token] [value]',
        run: async (args) => this.limits(args),
      },
      { name: 'cancel', summary: 'drop the request waiting on you', run: wrap(() => this.cancel()) },
      {
        name: 'new',
        summary: 'start a new session (forgets this one)',
        aliases: ['reset'],
        run: wrap(() => this.newSession()),
      },
      { name: 'wallet', summary: 'open the wallet to approve in MetaMask', run: wrap(() => this.wallet()) },
      { name: 'status', summary: 'check the agent, model and wallet', run: wrap(() => this.status()) },
      {
        name: 'doctor',
        summary: 'diagnose the setup: node, config, model, Tor, wallet',
        run: wrap(() => this.doctor()),
      },
      { name: 'config', summary: 'show the setup flexx is using', run: wrap(() => this.config()) },
      { name: 'copy', summary: 'copy the last reply to the clipboard', run: async (_args, ctx) => this.copyLast(ctx) },
      {
        name: 'version',
        summary: 'show the flexx and Node versions',
        run: () => [line(t('flexx ', 1), t(this.deps.version ?? 'dev', 2), t(` · node ${process.versions.node}`, 1))],
      },
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

/** The reply to anything but yes or no while a summary waits: the plan stays, and the question is asked again. */
function confirmAgain(): Line[] {
  return [
    line(t('Please answer '), t('y', 2), t(' or '), t('n', 2), t('. The plan above is still waiting.')),
    plain('To ask for something else, answer n first, then send your new request.', 1),
  ];
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
    // question text can span lines (e.g. the address on its own line)
    const [first = '', ...more] = q.text.split('\n');
    out.push(line(t(first), t(q.attempt > 1 ? `  (try ${q.attempt} of ${q.max_attempts})` : '', 1)));
    for (const l of more) out.push(plain(l));
    q.chips.forEach((c, i) => {
      const mark = t(`[${i + 1}] `, c.disabled ? 1 : 2);
      out.push(line(mark, t(c.label, c.disabled ? 1 : 0), t(c.detail ? `  ${c.detail}` : '', 1)));
    });
    const hint = q.prefill ? `${HINT[q.input]}, e.g. ${q.prefill}` : HINT[q.input];
    out.push(plain(`${hint} · or cancel`, 1));
  }
  if (r.error) {
    for (const l of r.error.message.split('\n')) out.push(plain(l));
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
          'Run node scripts/setup-testnet.mjs to write .local/agent.config.json from .env, or set AGENT_CONFIG.',
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
