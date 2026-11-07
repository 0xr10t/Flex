import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureTor, socksListening, TorStartError } from '../../../src/cli/agent/tor.js';

const proxy = 'socks5h://127.0.0.1:19050';
const folders: string[] = [];
const servers: Server[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'flexx tor '));
  folders.push(dir);
  return join(dir, 'tor');
};
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function child() {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    killed: [] as string[],
    unref() {},
    kill(signal: string) {
      this.killed.push(signal);
    },
  });
}

describe('Tor startup', () => {
  it('does nothing in explicit direct mode', async () => {
    const dir = folder();
    await ensureTor(null, dir, {
      probeImpl: async () => {
        throw new Error('must not probe');
      },
      spawnImpl: (() => {
        throw new Error('must not spawn');
      }) as typeof spawn,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('reuses a SOCKS listener without needing a Tor executable or creating files', async () => {
    const dir = folder();
    await ensureTor(proxy, dir, {
      executable: '/missing/tor',
      probeImpl: async () => true,
      spawnImpl: (() => {
        throw new Error('must not spawn');
      }) as typeof spawn,
    });
    expect(existsSync(dir)).toBe(false);
  });

  it('waits for bootstrap completion as well as the SOCKS listener before releasing the agent', async () => {
    const dir = folder();
    const process = child();
    let listening = false;
    let connected = false;
    let launched: { args: readonly string[]; detached: boolean } | undefined;
    const promise = ensureTor(proxy, dir, {
      executable: '/test/tor',
      probeImpl: async () => listening,
      spawnImpl: ((_exe: string, args: readonly string[], options: { detached: boolean }) => {
        launched = { args, detached: options.detached };
        listening = true;
        appendFileSync(join(dir, 'startup.log'), 'Bootstrapped 5% (conn): Connecting\n');
        return process;
      }) as unknown as typeof spawn,
    }).then(() => {
      connected = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(connected).toBe(false);
    appendFileSync(join(dir, 'startup.log'), 'Bootstrapped 100% (done): Done\n');
    await promise;
    expect(connected).toBe(true);
    expect(launched?.detached).toBe(true);
    expect(launched?.args).toContain('127.0.0.1:19050');
    expect(launched?.args).toContain(dir);
    expect(statSync(join(dir, 'startup.log')).mode & 0o777).toBe(0o600);
    expect(process.killed).toEqual([]);
  });

  it('does not treat an old bootstrap log as a newly connected Tor client', async () => {
    const dir = folder();
    mkdirSync(dir);
    appendFileSync(join(dir, 'startup.log'), 'Bootstrapped 100% (done): Done\n');
    const process = child();
    let probes = 0;
    await expect(
      ensureTor(proxy, dir, {
        executable: '/test/tor',
        startTimeoutMs: 0,
        probeImpl: async () => ++probes > 1,
        spawnImpl: (() => process) as unknown as typeof spawn,
      }),
    ).rejects.toMatchObject({ reason: 'timeout' });
    expect(process.killed).toEqual(['SIGTERM']);
  });

  it('reports a missing executable without exposing raw child errors', async () => {
    const process = child();
    const error = await ensureTor(proxy, folder(), {
      executable: '/test/tor',
      probeImpl: async () => false,
      spawnImpl: (() => {
        setImmediate(() => process.emit('error', Object.assign(new Error('private-value'), { code: 'ENOENT' })));
        return process;
      }) as unknown as typeof spawn,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TorStartError);
    expect(error).toMatchObject({ reason: 'missing' });
    expect(String(error)).toContain('brew install tor');
    expect(String(error)).not.toContain('private-value');
  });

  it('reuses a listener started by another launcher during a startup race', async () => {
    const process = child();
    let probes = 0;
    await ensureTor(proxy, folder(), {
      executable: '/test/tor',
      probeImpl: async () => ++probes > 1,
      spawnImpl: (() => {
        setImmediate(() => {
          process.exitCode = 1;
          process.emit('exit', 1);
        });
        return process;
      }) as unknown as typeof spawn,
    });
    expect(process.killed).toEqual([]);
  });

  it('rejects remote or malformed proxy addresses before doing any work', async () => {
    for (const invalid of ['socks5h://remote.test:9050', 'https://127.0.0.1:9050', 'invalid']) {
      await expect(ensureTor(invalid, folder())).rejects.toBeInstanceOf(TorStartError);
    }
  });
});

describe('SOCKS readiness', () => {
  it.each([true, false])('requires a SOCKS5 reply, not just an open TCP port (SOCKS: %s)', async (socks) => {
    const server = createServer((socket) => {
      socket.once('data', (request) => {
        expect([...request]).toEqual([5, 1, 0]);
        if (!socks) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        else {
          socket.write(Buffer.from([5]));
          setImmediate(() => socket.end(Buffer.from([0])));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    expect(await socksListening(`socks5h://127.0.0.1:${port}`)).toBe(socks);
  });
});
