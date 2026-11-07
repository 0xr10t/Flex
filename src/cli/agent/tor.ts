// Starts a local Tor client when the configured SOCKS listener is absent. A successful client stays running so
// other CLI sessions and the wallet can share it. Existing services are never stopped or reconfigured.
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { connect } from 'node:net';
import { delimiter, join } from 'node:path';
import { isTorSocks } from '../../config/load.js';
import { protectPrivateFile } from '../../util/private-file.js';

export class TorStartError extends Error {
  constructor(readonly reason: 'missing' | 'start' | 'timeout') {
    super(
      reason === 'missing'
        ? 'Tor is not installed. Install Tor (macOS: brew install tor), then reopen flexx.'
        : reason === 'timeout'
          ? 'Tor did not connect within two minutes. Check your internet connection, then reopen flexx.'
          : 'Tor could not start. Check that its configured SOCKS port is available, then reopen flexx.',
    );
    this.name = 'TorStartError';
  }
}

export interface TorOptions {
  executable?: string;
  startTimeoutMs?: number;
  spawnImpl?: typeof spawn;
  probeImpl?: typeof socksListening;
  onStatus?: (note: string) => void;
}

/** A SOCKS5 greeting checks the listener without contacting any external host. */
export function socksListening(proxy: string): Promise<boolean> {
  const url = new URL(proxy);
  return new Promise((resolve) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let reply = Buffer.alloc(0);
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('error', () => done(false));
    socket.once('end', () => done(false));
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (chunk: Buffer) => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length >= 2) done(reply[0] === 5 && reply[1] === 0);
    });
  });
}

function torExecutable(): string {
  const binary = process.platform === 'win32' ? 'tor.exe' : 'tor';
  const candidates = process.env.FLEX_TOR_PATH
    ? [process.env.FLEX_TOR_PATH]
    : [
        ...(process.env.PATH ?? '')
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, binary)),
        '/opt/homebrew/bin/tor',
        '/usr/local/bin/tor',
      ];
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next install location; never invoke a shell.
    }
  }
  throw new TorStartError('missing');
}

/** Read only this startup's last 64 KiB; old bootstrap messages must not make a new client look ready. */
function bootstrapped(path: string, offset: number): boolean {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(offset, size - 64 * 1024);
    const bytes = Buffer.alloc(Math.max(0, size - start));
    const read = readSync(fd, bytes, 0, bytes.length, start);
    return /Bootstrapped 100% \(done\): Done/.test(bytes.subarray(0, read).toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

/** Direct mode does nothing. New clients must finish bootstrapping before the agent starts reading balances. */
export async function ensureTor(proxy: string | null, dataDir: string, opts: TorOptions = {}): Promise<void> {
  if (proxy === null) return;
  if (!isTorSocks(proxy)) throw new TorStartError('start');
  const probe = opts.probeImpl ?? socksListening;
  if (await probe(proxy)) return;
  const executable = opts.executable ?? torExecutable();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const logFile = join(dataDir, 'startup.log');
  const logFd = openSync(logFile, 'a', 0o600);
  let child: ChildProcess;
  let offset: number;
  try {
    protectPrivateFile(logFile);
    offset = fstatSync(logFd).size;
    opts.onStatus?.('Starting Tor; waiting for its connection...');
    child = (opts.spawnImpl ?? spawn)(
      executable,
      [
        '--SocksPort',
        `127.0.0.1:${new URL(proxy).port}`,
        '--DataDirectory',
        dataDir,
        '--ClientOnly',
        '1',
        '--RunAsDaemon',
        '0',
        '--SafeLogging',
        '1',
        '--Log',
        'notice stdout',
      ],
      { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true },
    );
  } catch {
    throw new TorStartError('start');
  } finally {
    closeSync(logFd);
  }

  let failure: TorStartError | undefined;
  child.once('error', (err: NodeJS.ErrnoException) => {
    failure = new TorStartError(err.code === 'ENOENT' ? 'missing' : 'start');
  });
  child.once('exit', () => {
    failure ??= new TorStartError('start');
  });
  child.unref();
  const deadline = Date.now() + (opts.startTimeoutMs ?? 120_000);
  try {
    while (true) {
      if (failure) {
        // Another flexx may have won the race to start the same Tor client.
        if (await probe(proxy)) return;
        throw failure;
      }
      if (bootstrapped(logFile, offset) && (await probe(proxy))) {
        opts.onStatus?.('Tor connected.');
        return;
      }
      if (Date.now() >= deadline) throw new TorStartError('timeout');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } catch (err) {
    if (child.exitCode === null) child.kill('SIGTERM');
    throw err instanceof TorStartError ? err : new TorStartError('start');
  }
}
