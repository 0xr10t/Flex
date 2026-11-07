import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import type { spawn } from 'node:child_process';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../fakes/context.js';
import { prepareWalletConfig, saveWalletEnv } from '../../../src/cli/onboarding/config.js';
import { connectMetaMask, startWalletConnectServer, WalletConnectError } from '../../../src/cli/onboarding/connect.js';
import { focusTerminal, openCommand, openLocalPageAsync } from '../../../src/cli/open.js';
import { connectAgent } from '../../../src/cli/agent/launcher.js';

const folders: string[] = [];
const TEST_WALLET = '0x00000000000000000000000000000000000000AA';
const servers: Awaited<ReturnType<typeof startWalletConnectServer>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function setup(address: unknown = undefined) {
  const root = mkdtempSync(join(tmpdir(), 'flexx-connect-'));
  folders.push(root);
  mkdirSync(join(root, '.local'));
  const file = join(root, '.local/agent.config.json');
  writeFileSync(file, JSON.stringify({ ...testConfig(), wallet: { address } }));
  return { root, file };
}
async function server() {
  const s = await startWalletConnectServer();
  servers.push(s);
  const url = new URL(s.url);
  const headers = { 'content-type': 'application/json', origin: url.origin, 'x-flex-connect': url.hash.slice(9) };
  const post = (path: string, body: unknown, override = {}) =>
    fetch(`${url.origin}${path}`, {
      method: 'POST',
      headers: { ...headers, ...override },
      body: JSON.stringify(body),
    });
  const spoofHost = () =>
    new Promise<number>((done, fail) => {
      const req = request(
        `${url.origin}/connect`,
        { method: 'POST', headers: { ...headers, host: 'evil.test' } },
        (res) => {
          res.resume();
          done(res.statusCode!);
        },
      );
      req.once('error', fail);
      req.end(JSON.stringify({ address: TEST_WALLET }));
    });
  return { s, url, post, spoofHost };
}

describe('wallet connection callback', () => {
  it('serves a private local page and accepts exactly one authenticated public address', async () => {
    const { s, url, post } = await server();
    const page = await fetch(url.origin);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(await page.text()).not.toContain(url.hash.slice(9));
    expect((await post('/connect', { address: TEST_WALLET })).status).toBe(200);
    await expect(s.address).resolves.toBe(TEST_WALLET);
    expect((await post('/connect', { address: TEST_WALLET })).status).toBe(409);
  });

  it('rejects foreign origins, missing tokens, spoofed hosts, zero addresses and extra signing fields', async () => {
    const { post, spoofHost } = await server();
    expect((await post('/connect', { address: TEST_WALLET }, { origin: 'https://evil.test' })).status).toBe(403);
    expect((await post('/connect', { address: TEST_WALLET }, { 'x-flex-connect': '' })).status).toBe(403);
    expect(await spoofHost()).toBe(403);
    expect((await post('/connect', { address: `0x${'0'.repeat(40)}` })).status).toBe(400);
    expect((await post('/connect', { address: TEST_WALLET, privateKey: 'not-accepted' })).status).toBe(400);
  });

  it('handles browser cancellation and timeout without returning an address', async () => {
    const { s, post } = await server();
    expect((await post('/cancel', {})).status).toBe(200);
    await expect(s.address).rejects.toMatchObject({ reason: 'cancelled' });
    const timed = await startWalletConnectServer({ timeoutMs: 10 });
    servers.push(timed);
    await expect(timed.address).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('shuts down the listener when the CLI is cancelled', async () => {
    const abort = new AbortController();
    let url = '';
    const task = connectMetaMask({
      signal: abort.signal,
      openPage: async (u) => {
        url = u;
        abort.abort();
        return true;
      },
    });
    await expect(task).rejects.toMatchObject({ reason: 'cancelled' });
    await expect(fetch(new URL(url).origin)).rejects.toThrow();
  });

  it('reports an opener failure and closes the callback', async () => {
    let url = '';
    await expect(
      connectMetaMask({
        openPage: async (u) => {
          url = u;
          return false;
        },
      }),
    ).rejects.toMatchObject({ reason: 'browser' });
    await expect(fetch(new URL(url).origin)).rejects.toThrow();
  });
});

describe('first-run configuration', () => {
  it('uses a saved address without opening the browser even when .env is absent', async () => {
    const { root, file } = setup(TEST_WALLET);
    const connect = vi.fn();
    const config = await prepareWalletConfig(file, { projectRoot: root, env: {}, connect });
    expect(config.wallet.address).toBe(TEST_WALLET);
    expect(connect).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('saves a connected address in .env and all project configs before returning to the terminal', async () => {
    const { root, file } = setup();
    const envFile = join(root, '.env');
    writeFileSync(envFile, 'RPC_SECRET="keep\nthese lines"\nFLEX_WALLET_ADDRESS=\n');
    writeFileSync(join(root, '.local/wallet.config.json'), JSON.stringify({ approval: { mode: 'metamask' } }));
    writeFileSync(join(root, '.local/cre.config.json'), '{}');
    const focus = vi.fn(async () => {
      expect(JSON.parse(readFileSync(file, 'utf8')).wallet.address).toBe(TEST_WALLET);
      return true;
    });
    const config = await prepareWalletConfig(file, {
      projectRoot: root,
      env: {},
      connect: async () => TEST_WALLET,
      focus,
    });
    expect(config.wallet.address).toBe(TEST_WALLET);
    expect(parseEnv(readFileSync(envFile, 'utf8'))).toMatchObject({
      FLEX_WALLET_ADDRESS: TEST_WALLET,
      RPC_SECRET: 'keep\nthese lines',
    });
    expect(JSON.parse(readFileSync(join(root, '.local/wallet.config.json'), 'utf8')).approval.wallet_address).toBe(
      TEST_WALLET,
    );
    expect(JSON.parse(readFileSync(join(root, '.local/cre.config.json'), 'utf8')).walletAddress).toBe(TEST_WALLET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(focus).toHaveBeenCalledOnce();
  });

  it('uses an address from .env without asking MetaMask again', async () => {
    const { root, file } = setup();
    saveWalletEnv(join(root, '.env'), TEST_WALLET);
    const connect = vi.fn();
    await prepareWalletConfig(file, { projectRoot: root, env: {}, connect });
    expect(connect).not.toHaveBeenCalled();
  });

  it('bootstraps a missing project config after obtaining the address', async () => {
    const { root, file } = setup();
    rmSync(file);
    const configure = vi.fn(async (_root: string, selected: string) => {
      expect(parseEnv(readFileSync(join(root, '.env'), 'utf8')).FLEX_WALLET_ADDRESS).toBe(selected);
      writeFileSync(file, JSON.stringify({ ...testConfig(), wallet: { address: selected } }));
    });
    await prepareWalletConfig(file, {
      projectRoot: root,
      env: {},
      connect: async () => TEST_WALLET,
      focus: async () => true,
      setup: configure,
    });
    expect(configure).toHaveBeenCalledOnce();
  });

  it('does not save anything when connection is rejected or cancelled', async () => {
    const { root, file } = setup();
    const before = readFileSync(file, 'utf8');
    await expect(
      prepareWalletConfig(file, {
        projectRoot: root,
        env: {},
        focus: async () => true,
        connect: async () => {
          throw new WalletConnectError('cancelled');
        },
      }),
    ).rejects.toMatchObject({ reason: 'cancelled' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(existsSync(join(root, '.env'))).toBe(false);
  });

  it('routes interactive launch through onboarding and never starts the agent after a cancelled connection', async () => {
    const prepared = vi.fn(async () => {
      throw new WalletConnectError('cancelled');
    });
    const fetchImpl = vi.fn();
    const spawnImpl = vi.fn();
    await expect(
      connectAgent({ onboard: true, prepareConfigImpl: prepared, fetchImpl, spawnImpl }),
    ).rejects.toMatchObject({ stage: 'wallet' });
    expect(prepared).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(spawnImpl).not.toHaveBeenCalled();
  });
});

describe('desktop handoff', () => {
  it('uses the default browser opener and returns to the originating terminal app', async () => {
    const calls: [string, string[]][] = [];
    const fake = ((cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      const child = new EventEmitter();
      setImmediate(() => child.emit('exit', 0));
      return child;
    }) as unknown as typeof spawn;
    const url = `http://127.0.0.1:8789/#connect=${'a'.repeat(64)}`;
    expect(await openLocalPageAsync(url, fake)).toBe(true);
    expect(calls[0]).toEqual(openCommand(process.platform, url));
    expect(await focusTerminal({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', fake)).toBe(true);
    expect(calls[1]).toEqual(['open', ['-b', 'com.apple.Terminal']]);
    expect(await openLocalPageAsync('https://evil.test/', fake)).toBe(false);
    expect(calls).toHaveLength(2);
  });
});
