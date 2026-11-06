import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { Question } from '../../../src/contracts/types.js';
import {
  AgentClient,
  AgentHttpError,
  AgentUnreachableError,
  type AgentApi,
  type AgentResponse,
} from '../../../src/cli/agent/client.js';
import { agentConfigFile, connectAgent, LaunchError, type AgentEndpoint } from '../../../src/cli/agent/launcher.js';
import { answerFor, Chat, render } from '../../../src/cli/chat.js';
import { openCommand, openLocalPage } from '../../../src/cli/open.js';
import { testConfig } from '../../fakes/context.js';
import type { Line } from '../../../src/cli/repl.js';

const text = (lines: Line[]): string[] => lines.map((l) => l.map((s) => s.text).join(''));
const TOKEN = 'a'.repeat(64);

const question = (input: Question['input'], labels: string[], disabled: number[] = []): Question => ({
  question_id: 'q_000000000001',
  code: 'Q_TOKEN',
  text: 'Is 5 in USDC or ETH?',
  input,
  chips: labels.map((label, i) => ({ id: `c${i}`, label, disabled: disabled.includes(i), detail: '' })),
  attempt: 1,
  max_attempts: 4,
});

const response = (over: Partial<AgentResponse>): AgentResponse => ({
  session_id: 'ses_000000000001',
  request_id: 'req_000000000001',
  state: 'done',
  messages: [],
  ...over,
});

describe('answers typed in the box', () => {
  it('picks a chip by its number, skipping disabled ones', () => {
    const q = question('chips', ['USDC', 'ETH'], [1]);
    expect(answerFor(q, '1')).toEqual({ question_id: q.question_id, chip_id: 'c0' });
    expect(answerFor(q, '2')).toBeUndefined();
    expect(answerFor(q, '3')).toBeUndefined();
    expect(answerFor(q, 'usdc')).toBeUndefined();
  });

  it('picks members by numbers, or all of them', () => {
    const q = question('multiselect', ['a.iitr.eth', 'b.iitr.eth', 'c.iitr.eth'], [1]);
    expect(answerFor(q, '1,3')).toEqual({ question_id: q.question_id, selected_ids: ['c0', 'c2'] });
    expect(answerFor(q, '3 1')).toEqual({ question_id: q.question_id, selected_ids: ['c2', 'c0'] });
    expect(answerFor(q, 'all')).toEqual({ question_id: q.question_id, selected_ids: ['c0', 'c2'] });
    expect(answerFor(q, '2')).toBeUndefined();
  });

  it('leaves number and text questions to the agent', () => {
    expect(answerFor(question('number', []), '5')).toBeUndefined();
    expect(answerFor(question('text', []), 'aradhya')).toBeUndefined();
  });
});

describe('agent replies in the box', () => {
  it('shows a question with numbered choices and a hint', () => {
    const q = { ...question('chips', ['USDC', 'ETH'], [1]), attempt: 2 };
    expect(text(render(response({ state: 'awaiting_answer', question: q })))).toEqual([
      'Is 5 in USDC or ETH?  (try 2 of 4)',
      '[1] USDC',
      '[2] ETH',
      'type a number, or answer in your own words · or cancel',
    ]);
  });

  it('puts each line of a multi-line question on its own row', () => {
    const q = {
      ...question('chips', ['Yes', 'No, re-enter']),
      text: 'You have not paid this recipient before.\nWallet address: 0xdEaD',
    };
    expect(text(render(response({ state: 'awaiting_answer', question: q }))).slice(0, 2)).toEqual([
      'You have not paid this recipient before.',
      'Wallet address: 0xdEaD',
    ]);
  });

  it('shows an error, with how to retry when the wallet was unreachable', () => {
    const r = response({
      state: 'error',
      error: { code: 'EXECUTION_UNAVAILABLE', message: "I couldn't reach your wallet. Confirm again to retry." },
    });
    expect(text(render(r))).toEqual(["I couldn't reach your wallet. Confirm again to retry.", 'Type y to try again.']);
  });
});

/** A fake agent that records calls and replies from a script. */
class FakeApi implements AgentApi {
  calls: string[] = [];
  replies: Array<AgentResponse | Error> = [];
  private next(): Promise<AgentResponse> {
    const r = this.replies.shift() ?? response({});
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
  health = async () => ({ ok: true, ollama: false, db: true });
  openSession = async () => (this.calls.push('open'), 'ses_000000000001');
  closeSession = async () => void this.calls.push('close');
  message = async (_s: string, t: string) => (this.calls.push(`message ${t}`), this.next());
  answer = async (_s: string, b: unknown) => (this.calls.push(`answer ${JSON.stringify(b)}`), this.next());
  confirm = async (_s: string, _r: string, d: string) => (this.calls.push(`confirm ${d}`), this.next());
  cancel = async () => (this.calls.push('cancel'), this.next());
  getLimits = async () => ({});
  putLimits = async () => ({});
}

const endpoint = (over: Partial<AgentEndpoint> = {}): AgentEndpoint => ({
  baseUrl: 'http://127.0.0.1:1',
  token: TOKEN,
  walletUrl: 'http://127.0.0.1:8788/',
  started: true,
  stop: () => undefined,
  ...over,
});

describe('the conversation', () => {
  it('says the agent was started and that the model is not ready', async () => {
    const chat = new Chat({
      connect: async () => endpoint(),
      client: () => new FakeApi(),
      timezone: 'UTC',
      openPage: () => true,
    });
    expect(text(await chat.connect())).toEqual([
      'Connected to the agent (started it for you)',
      'The local model is not ready, so requests will fail until Ollama has it.',
    ]);
  });

  it('lists the config problems when the agent cannot start, and tries again on the next message', async () => {
    let attempts = 0;
    const chat = new Chat({
      connect: async () => {
        attempts++;
        throw new LaunchError('config', ["/ must have required property 'network'"]);
      },
      timezone: 'UTC',
      openPage: () => true,
    });
    const lines = text(await chat.send('hi'));
    expect(lines[0]).toBe("The agent's config isn't usable yet, so I can't start it:");
    expect(lines[1]).toBe("- / must have required property 'network'");
    await chat.send('hi');
    expect(attempts).toBe(2);
  });

  it('confirms with y, retries a failed hand-off with y, and declines with n', async () => {
    const api = new FakeApi();
    const opened: string[] = [];
    const chat = new Chat({
      connect: async () => endpoint(),
      client: () => api,
      timezone: 'UTC',
      openPage: (u) => (opened.push(u), true),
    });
    const summary = { text: 'Please confirm:\n1. Send.\nConfirm?', lines: ['1. Send.'], notes: [], footer: [] };
    api.replies = [
      response({ state: 'awaiting_confirmation', summary }),
      response({ state: 'error', error: { code: 'EXECUTION_UNAVAILABLE', message: "I couldn't reach your wallet." } }),
      response({ messages: [{ type: 'text', text: 'Sent to your wallet for signing.' }] }),
      response({ state: 'awaiting_confirmation', summary }),
      response({ messages: [{ type: 'text', text: "OK, I've dropped that." }] }),
    ];
    await chat.send('send 1 usdc to a');
    await chat.send('y');
    expect(opened).toEqual([]);
    const sent = text(await chat.send('yes'));
    expect(sent.at(-1)).toBe('Opened your wallet to approve it in MetaMask: http://127.0.0.1:8788/');
    await chat.send('send 1 usdc to a');
    await chat.send('n');
    expect(api.calls.filter((c) => c !== 'open')).toEqual([
      'message send 1 usdc to a',
      'confirm yes',
      'confirm yes',
      'message send 1 usdc to a',
      'confirm no',
    ]);
  });

  it('answers a chip question by number and sends other text as a message', async () => {
    const api = new FakeApi();
    const chat = new Chat({
      connect: async () => endpoint(),
      client: () => api,
      timezone: 'UTC',
      openPage: () => true,
    });
    api.replies = [response({ state: 'awaiting_answer', question: question('chips', ['USDC', 'ETH']) })];
    await chat.send('send 5 to a');
    await chat.send('2');
    expect(api.calls).toContain('answer {"question_id":"q_000000000001","chip_id":"c1"}');
  });

  it('reopens the session after the agent forgot it, and reconnects after losing it', async () => {
    const api = new FakeApi();
    const chat = new Chat({
      connect: async () => endpoint(),
      client: () => api,
      timezone: 'UTC',
      openPage: () => true,
    });
    api.replies = [new AgentHttpError(404)];
    expect(text(await chat.send('hi'))[0]).toMatch(/lost this session/);
    api.replies = [new AgentUnreachableError('x')];
    expect(text(await chat.send('hi'))[0]).toMatch(/^Lost the agent/);
    await chat.send('hi');
    expect(api.calls.filter((c) => c === 'open')).toHaveLength(3);
  });

  it('closes the session and stops an agent it started', async () => {
    const api = new FakeApi();
    let stopped = 0;
    const chat = new Chat({
      connect: async () => endpoint({ stop: () => stopped++ }),
      client: () => api,
      timezone: 'UTC',
      openPage: () => true,
    });
    await chat.connect();
    await chat.close();
    expect(api.calls).toEqual(['open', 'close']);
    expect(stopped).toBe(1);
  });
});

describe('agent client', () => {
  it('sends the bearer token and JSON, and maps errors', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const replies = [
      new Response(JSON.stringify({ session_id: 'ses_000000000001' }), { status: 200 }),
      new Response(JSON.stringify({ statusCode: 400, errors: ['daily_max.USDC must be positive'] }), { status: 400 }),
      new Response(null, { status: 204 }),
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return replies.shift()!;
    }) as unknown as typeof fetch;
    const client = new AgentClient('http://127.0.0.1:8787', TOKEN, fakeFetch);
    expect(await client.openSession('Asia/Kolkata')).toBe('ses_000000000001');
    expect(seen[0]!.url).toBe('http://127.0.0.1:8787/v1/sessions');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]!.init.body).toBe('{"timezone":"Asia/Kolkata"}');
    await expect(client.putLimits({})).rejects.toMatchObject({
      status: 400,
      fields: ['daily_max.USDC must be positive'],
    });
    await expect(client.closeSession('ses_000000000001')).resolves.toBeUndefined();
    const down = new AgentClient('http://127.0.0.1:1', TOKEN, (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(down.health()).rejects.toBeInstanceOf(AgentUnreachableError);
  });
});

describe('agent launcher', () => {
  /** A valid config in a temp folder, its UI token file written, the agent on `port`. */
  const setup = (port = 8787): { file: string; tokenFile: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'flexx-launch-'));
    const tokenFile = join(dir, 'ui_token');
    writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
    const config = testConfig();
    const file = join(dir, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        server: { ...config.server, port },
        auth: { ...config.auth, ui_token_file: tokenFile },
      }),
    );
    return { file, tokenFile };
  };
  /** A child process stand-in: it can exit, and records kills. */
  const fakeChild = () => {
    const child = new EventEmitter() as EventEmitter & {
      kill(s: string): void;
      exitCode: number | null;
      killed: string[];
    };
    child.exitCode = null;
    child.killed = [];
    child.kill = (sig: string) => void child.killed.push(sig);
    return child;
  };
  const answering = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
  const silent = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;

  it('prefers AGENT_CONFIG, then the set-up config in the checkout, then ~/.agent-layer', () => {
    const { file } = setup();
    expect(agentConfigFile({ AGENT_CONFIG: '/x/agent.json' }, file)).toBe('/x/agent.json');
    expect(agentConfigFile({}, file)).toBe(file);
    expect(agentConfigFile({}, '/nowhere/agent.config.json')).toMatch(/\.agent-layer\/config\.json$/);
  });

  it('reports config problems without starting anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flexx-launch-'));
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"server": {}}');
    let spawned = 0;
    const err = await connectAgent({
      configFile: file,
      fetchImpl: silent,
      spawnImpl: (() => (spawned++, fakeChild())) as unknown as typeof spawn,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LaunchError);
    expect((err as LaunchError).stage).toBe('config');
    expect((err as LaunchError).details.length).toBeGreaterThan(0);
    expect(spawned).toBe(0);
  });

  it('uses an agent that is already running and leaves it alone', async () => {
    const { file } = setup(8799);
    let spawned = 0;
    const e = await connectAgent({
      configFile: file,
      fetchImpl: answering,
      spawnImpl: (() => (spawned++, fakeChild())) as unknown as typeof spawn,
    });
    expect(e).toMatchObject({ baseUrl: 'http://127.0.0.1:8799', token: TOKEN, started: false });
    expect(e.walletUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(spawned).toBe(0);
  });

  it('starts the agent with its config, waits for it, and stops it on request', async () => {
    const { file } = setup();
    const child = fakeChild();
    let up = false;
    let launched: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    const e = await connectAgent({
      configFile: file,
      entry: '/x/dist/src/index.js',
      fetchImpl: (async () => {
        if (!up) throw new TypeError('fetch failed');
        return new Response(null, { status: 401 });
      }) as unknown as typeof fetch,
      spawnImpl: ((_cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
        launched = { args, env: o.env };
        setTimeout(() => (up = true), 300);
        return child;
      }) as unknown as typeof spawn,
    });
    expect(launched?.args).toEqual(['/x/dist/src/index.js']);
    expect(launched?.env.AGENT_CONFIG).toBe(file);
    expect(e.started).toBe(true);
    e.stop();
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('gives up when the started agent exits', async () => {
    const { file } = setup();
    const child = fakeChild();
    const err = await connectAgent({
      configFile: file,
      fetchImpl: silent,
      spawnImpl: (() => {
        setTimeout(() => child.emit('exit', 1), 50);
        return child;
      }) as unknown as typeof spawn,
    }).catch((x: unknown) => x);
    expect(err).toMatchObject({ stage: 'start' });
  });
});

describe('opening the wallet page', () => {
  it('opens only local pages, with the platform command', () => {
    expect(openCommand('darwin', 'http://127.0.0.1:8788/')).toEqual(['open', ['http://127.0.0.1:8788/']]);
    expect(openCommand('linux', 'http://127.0.0.1:8788/')).toEqual(['xdg-open', ['http://127.0.0.1:8788/']]);
    const calls: string[][] = [];
    const fake = ((cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => undefined;
      return child;
    }) as unknown as typeof spawn;
    expect(openLocalPage('https://evil.example/', fake)).toBe(false);
    expect(openLocalPage('http://127.0.0.1.evil.example/', fake)).toBe(false);
    expect(openLocalPage('http://127.0.0.1:8788/', fake)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
