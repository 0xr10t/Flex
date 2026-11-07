import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { execPath } from 'node:process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../fakes/context.js';
import { connectAgent } from '../../../src/cli/agent/launcher.js';
import { ensureOllama } from '../../../src/cli/agent/ollama.js';
import { ensureWallet } from '../../../src/cli/agent/wallet.js';
import { ensureRecurring } from '../../../src/cli/agent/recurring.js';
import { ensureProcess, reusedService, ServiceStartError, type ServiceHandle } from '../../../src/cli/agent/process.js';

const folders: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const json = (value: unknown, status = 200) => Response.json(value, { status });
const down = () => {
  throw new TypeError('private-provider-key');
};
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response> | Response) =>
  vi.fn(async (url, init) => fn(String(url), init ?? {})) as unknown as typeof fetch;
const child = () => Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn(), unref: vi.fn() });
const handle = (): ServiceHandle => ({ started: true, stop: vi.fn(), detach: vi.fn() });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flex-services-'));
  folders.push(root);
  const local = join(root, '.local');
  mkdirSync(local);
  mkdirSync(join(root, 'wallet/dist/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'wallet/dist/src/main.js'), '');
  writeFileSync(
    join(root, 'wallet/dist/src/config.js'),
    "import {readFileSync} from 'node:fs'; export const loadConfig = path => JSON.parse(readFileSync(path, 'utf8'));",
  );
  const config = testConfig();
  config.network.socks_proxy = null;
  config.auth.ui_token_file = join(local, 'ui_token');
  config.auth.execution_report_token_file = join(local, 'report_token');
  config.execution.outbound_token_file = join(local, 'outbound_token');
  const tokens = { ui: 'a'.repeat(64), report: 'b'.repeat(64), outbound: 'c'.repeat(64) };
  for (const [path, token] of [
    [config.auth.ui_token_file, tokens.ui],
    [config.auth.execution_report_token_file, tokens.report],
    [config.execution.outbound_token_file, tokens.outbound],
  ])
    writeFileSync(path!, token!, { mode: 0o600 });
  const file = join(local, 'agent.config.json');
  const walletFile = join(local, 'wallet.config.json');
  const wallet = {
    server: { host: '127.0.0.1', port: Number(new URL(config.execution.url).port) },
    agent: { url: `http://127.0.0.1:${config.server.port}` },
    auth: {
      inbound_token_file: config.execution.outbound_token_file,
      report_token_file: config.auth.execution_report_token_file,
    },
    approval: { mode: 'metamask', wallet_address: config.wallet.address },
    network: { ...config.network },
    chains: config.chains,
  };
  writeFileSync(file, JSON.stringify(config));
  writeFileSync(walletFile, JSON.stringify(wallet));
  const healthyWallet = () =>
    json({ service: 'flex-wallet', ok: true, db: true, wallet_address: config.wallet.address });
  return { root, local, config, file, walletFile, wallet, tokens, healthyWallet };
}

describe('service process ownership', () => {
  it('starts a real local child, waits for its HTTP listener, and releases it on stop', async () => {
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const url = `http://127.0.0.1:${port}`;
    const running = await ensureProcess(
      {
        service: 'start',
        label: 'test agent',
        failure: 'test child failed',
        probe: async () =>
          fetch(url).then(
            (res) => (res.ok ? ('ready' as const) : ('waiting' as const)),
            () => 'offline' as const,
          ),
        command: () => ({
          executable: execPath,
          args: ['-e', `require('node:http').createServer((req,res)=>res.end('ready')).listen(${port},'127.0.0.1')`],
        }),
      },
      { startTimeoutMs: 3000 },
    );
    try {
      expect(await (await fetch(url)).text()).toBe('ready');
      running.stop();
      await vi.waitFor(
        async () => {
          await expect(fetch(url)).rejects.toThrow();
        },
        { timeout: 2000 },
      );
    } finally {
      running.stop();
    }
  });
  it('reuses a healthy process without spawning or stopping it', async () => {
    const spawnImpl = vi.fn();
    const running = await ensureProcess(
      {
        service: 'start',
        label: 'agent',
        probe: async () => 'ready',
        command: () => ({ executable: 'node', args: [] }),
        failure: 'failed',
      },
      { spawnImpl },
    );
    running.stop();
    expect(running.started).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('does not start a duplicate when a listening service is unhealthy', async () => {
    const spawnImpl = vi.fn();
    await expect(
      ensureProcess(
        {
          service: 'start',
          label: 'agent',
          probe: async () => 'waiting',
          command: () => ({ executable: 'node', args: [] }),
          failure: 'failed',
        },
        { spawnImpl, startTimeoutMs: 0 },
      ),
    ).rejects.toThrow('failed');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('kills a newly started process on timeout and hides raw spawn errors', async () => {
    const process = child();
    const spec = {
      service: 'start' as const,
      label: 'agent',
      probe: async () => 'offline' as const,
      command: () => ({ executable: 'node', args: [] }),
      failure: 'safe failure',
    };
    await expect(
      ensureProcess(spec, { spawnImpl: (() => process) as unknown as typeof spawn, startTimeoutMs: 0 }),
    ).rejects.toThrow('safe failure');
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await expect(ensureProcess(spec, { spawnImpl: down as unknown as typeof spawn })).rejects.toThrow('safe failure');
  });

  it('cancels a pending start and stops only its own child', async () => {
    const abort = new AbortController();
    const process = child();
    await expect(
      ensureProcess(
        {
          service: 'start',
          label: 'agent',
          probe: async () => 'offline',
          command: () => ({ executable: 'node', args: [] }),
          failure: 'failed',
        },
        {
          signal: abort.signal,
          spawnImpl: (() => {
            setImmediate(() => abort.abort());
            return process;
          }) as unknown as typeof spawn,
        },
      ),
    ).rejects.toThrow();
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });
});

describe('Ollama startup', () => {
  it('starts on the configured loopback port, downloads a missing model, and loads it', async () => {
    const config = testConfig();
    config.llm.ollama_url = 'http://127.0.0.1:21434';
    let up = false;
    const process = child();
    const fetchImpl = fakeFetch((url, init) => {
      if (url.endsWith('/api/tags')) return up ? json({ models: [] }) : down();
      expect(init.redirect).toBe('error');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe(config.llm.model);
      return url.endsWith('/api/pull') ? json({ status: 'success' }) : json({ done: true });
    });
    const spawnImpl = vi.fn((_cmd, _args, opts) => {
      expect(opts.env.OLLAMA_HOST).toBe('127.0.0.1:21434');
      expect(opts.env.OLLAMA_NO_CLOUD).toBe('true');
      up = true;
      return process;
    }) as unknown as typeof spawn;
    const running = await ensureOllama(config, { fetchImpl, spawnImpl, executable: execPath });
    expect(running.started).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    running.detach();
    expect(process.unref).toHaveBeenCalledOnce();
    running.stop();
    running.stop();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('reuses Ollama and checks both distinct configured models, loading the payment model last', async () => {
    const config = testConfig();
    config.chat = { enabled: true, think: false, model: 'qwen3:8b' };
    const loaded: string[] = [];
    const spawnImpl = vi.fn();
    const fetchImpl = fakeFetch((url, init) => {
      if (url.endsWith('/api/tags')) return json({ models: [{ name: config.llm.model }, { name: 'qwen3:8b' }] });
      expect(url).toMatch(/\/api\/generate$/);
      loaded.push(JSON.parse(String(init.body)).model);
      return json({ done: true });
    });
    const running = await ensureOllama(config, { fetchImpl, spawnImpl });
    running.stop();
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(loaded).toEqual(['qwen3:8b', config.llm.model]);
  });

  it('does not accept an unrelated HTTP server or expose its error response', async () => {
    const spawnImpl = vi.fn();
    await expect(
      ensureOllama(testConfig(), { spawnImpl, fetchImpl: fakeFetch(() => json({ error: 'secret' })) }),
    ).rejects.toThrow('incompatible service');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('stops its daemon when model loading fails', async () => {
    let up = false;
    const process = child();
    const fetchImpl = fakeFetch((url) =>
      url.endsWith('/api/tags')
        ? up
          ? json({ models: [{ name: testConfig().llm.model }] })
          : down()
        : json({ error: 'private-provider-key' }, 500),
    );
    await expect(
      ensureOllama(testConfig(), {
        executable: execPath,
        fetchImpl,
        spawnImpl: (() => {
          up = true;
          return process;
        }) as unknown as typeof spawn,
      }),
    ).rejects.toThrow('could not load');
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });
});

describe('wallet startup', () => {
  it('starts a missing wallet and waits for an authenticated health response', async () => {
    const f = fixture();
    let up = false;
    const process = child();
    const spawnImpl = vi.fn((_cmd, args) => {
      expect(args).toEqual([join(f.root, 'wallet/dist/src/main.js'), f.walletFile]);
      up = true;
      return process;
    }) as unknown as typeof spawn;
    const fetchImpl = fakeFetch((url, init) => {
      expect(url).toBe(`${f.config.execution.url}/v1/health`);
      expect(init.headers).toEqual({ authorization: `Bearer ${f.tokens.outbound}` });
      return up ? f.healthyWallet() : down();
    });
    const running = await ensureWallet(f.config, f.file, { projectRoot: f.root, fetchImpl, spawnImpl });
    expect(running.started).toBe(true);
    running.stop();
    expect(process.kill).toHaveBeenCalledOnce();
  });

  it('leaves a matching running wallet alone', async () => {
    const f = fixture();
    const spawnImpl = vi.fn();
    const running = await ensureWallet(f.config, f.file, {
      projectRoot: f.root,
      fetchImpl: fakeFetch(f.healthyWallet),
      spawnImpl,
    });
    running.stop();
    expect(running.started).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('refuses mismatched wallet routing before starting or probing it', async () => {
    const f = fixture();
    f.wallet.network.socks_proxy = 'socks5h://127.0.0.1:19050';
    writeFileSync(f.walletFile, JSON.stringify(f.wallet));
    const spawnImpl = vi.fn();
    const fetchImpl = fakeFetch(f.healthyWallet);
    await expect(ensureWallet(f.config, f.file, { projectRoot: f.root, fetchImpl, spawnImpl })).rejects.toThrow(
      'does not match',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('refuses another wallet account on the expected port', async () => {
    const f = fixture();
    const spawnImpl = vi.fn();
    await expect(
      ensureWallet(f.config, f.file, {
        projectRoot: f.root,
        spawnImpl,
        fetchImpl: fakeFetch(() =>
          json({ service: 'flex-wallet', ok: true, db: true, wallet_address: `0x${'1'.repeat(40)}` }),
        ),
      }),
    ).rejects.toThrow('Another or older wallet');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('complete flexx startup', () => {
  it('starts dependencies before the agent and preserves shared processes on exit', async () => {
    const f = fixture();
    f.config.network.socks_proxy = 'socks5h://127.0.0.1:19050';
    writeFileSync(f.file, JSON.stringify(f.config));
    const order: string[] = [];
    const ollama = handle(),
      wallet = handle(),
      recurring = { ...handle(), mode: 'dry-run' as const };
    const agent = child();
    let up = false;
    const endpoint = await connectAgent({
      configFile: f.file,
      ensureTorImpl: async () => {
        order.push('tor');
      },
      ensureOllamaImpl: async () => {
        order.push('ollama');
        return ollama;
      },
      ensureWalletImpl: async () => {
        order.push('wallet');
        return wallet;
      },
      ensureRecurringImpl: async () => {
        order.push('recurring');
        return recurring;
      },
      spawnImpl: (() => {
        order.push('agent');
        up = true;
        return agent;
      }) as unknown as typeof spawn,
      fetchImpl: fakeFetch((_url, init) => {
        expect(init.headers).toEqual({ authorization: `Bearer ${f.tokens.ui}` });
        return up ? json({ ok: true, ollama: true, db: true }) : down();
      }),
    });
    expect(order).toEqual(['tor', 'ollama', 'wallet', 'agent', 'recurring']);
    endpoint.stop();
    expect(ollama.stop).not.toHaveBeenCalled();
    expect(ollama.detach).toHaveBeenCalledOnce();
    expect(wallet.stop).toHaveBeenCalledOnce();
    expect(recurring.stop).toHaveBeenCalledOnce();
    expect(agent.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('rolls back its services when the agent rejects its credentials', async () => {
    const f = fixture();
    const ollama = handle(),
      wallet = handle();
    const spawnImpl = vi.fn();
    await expect(
      connectAgent({
        configFile: f.file,
        spawnImpl,
        ensureOllamaImpl: async () => ollama,
        ensureWalletImpl: async () => wallet,
        fetchImpl: fakeFetch(() => json({}, 401)),
      }),
    ).rejects.toMatchObject({ stage: 'start' });
    expect(ollama.stop).toHaveBeenCalledOnce();
    expect(wallet.stop).toHaveBeenCalledOnce();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('never reports an agent with an unavailable model as ready', async () => {
    const f = fixture();
    const spawnImpl = vi.fn();
    await expect(
      connectAgent({
        configFile: f.file,
        spawnImpl,
        startTimeoutMs: 0,
        ensureOllamaImpl: async () => reusedService(),
        ensureWalletImpl: async () => reusedService(),
        fetchImpl: fakeFetch(() => json({ ok: true, db: true, ollama: false })),
      }),
    ).rejects.toMatchObject({ stage: 'start' });
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('optional recurring runner', () => {
  it('stays off unless explicitly enabled, even when CRE config exists', async () => {
    vi.stubEnv('FLEX_CRE_MODE', '');
    const f = fixture();
    writeFileSync(join(f.local, 'cre.config.json'), '{}');
    const spawnImpl = vi.fn(),
      portProbe = vi.fn();
    expect((await ensureRecurring(f.config, f.file, { projectRoot: f.root, spawnImpl, portProbe })).mode).toBe('off');
    expect(portProbe).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each(['dry-run', 'broadcast'] as const)(
    'starts the explicitly selected %s and waits for a fresh check',
    async (mode) => {
      const f = fixture();
      writeFileSync(join(f.local, 'cre.config.json'), '{}');
      mkdirSync(join(f.local, 'cre-runner'));
      let up = false;
      const process = child();
      const spawnImpl = vi.fn((_cmd, args) => {
        expect(args).toEqual([
          join(f.root, 'scripts/cre-local.mjs'),
          mode === 'broadcast' ? 'broadcast' : 'run',
          '--watch',
        ]);
        up = true;
        writeFileSync(
          join(f.local, 'cre-runner/status.json'),
          JSON.stringify({
            status: mode === 'broadcast' ? 'broadcast_checked' : 'simulated',
            time: new Date().toISOString(),
            broadcast: mode === 'broadcast',
          }),
        );
        return process;
      }) as unknown as typeof spawn;
      const running = await ensureRecurring(f.config, f.file, {
        projectRoot: f.root,
        mode,
        spawnImpl,
        portProbe: async () => up,
      });
      expect(running.mode).toBe(mode);
      running.stop();
      expect(process.kill).toHaveBeenCalledOnce();
    },
  );

  it('does not bypass Tor for an enabled recurring runner', async () => {
    const f = fixture();
    f.config.network.socks_proxy = 'socks5h://127.0.0.1:19050';
    const spawnImpl = vi.fn();
    await expect(
      ensureRecurring(f.config, f.file, { projectRoot: f.root, mode: 'broadcast', spawnImpl }),
    ).rejects.toBeInstanceOf(ServiceStartError);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reads the saved startup mode and refuses a stale running process without spawning a duplicate', async () => {
    vi.stubEnv('FLEX_CRE_MODE', undefined);
    const f = fixture();
    writeFileSync(join(f.root, '.env'), 'FLEX_CRE_MODE=dry-run\n');
    writeFileSync(join(f.local, 'cre.config.json'), '{}');
    mkdirSync(join(f.local, 'cre-runner'));
    writeFileSync(
      join(f.local, 'cre-runner/status.json'),
      JSON.stringify({ status: 'simulated', time: '2000-01-01T00:00:00Z', broadcast: false }),
    );
    const spawnImpl = vi.fn();
    await expect(
      ensureRecurring(f.config, f.file, {
        projectRoot: f.root,
        spawnImpl,
        startTimeoutMs: 0,
        portProbe: async () => true,
      }),
    ).rejects.toThrow('did not become ready');
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});
