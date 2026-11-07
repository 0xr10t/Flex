// Desktop helpers: opens a local page (the wallet's MetaMask approval page) in the default browser, and copies text
// to the clipboard for /copy. Only loopback http URLs are opened, so nothing the agent or a message says can send the
// browser anywhere else.

import { spawn } from 'node:child_process';

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/(#approve=req_[0-9a-f]{12})?$/;

/** The command that opens a URL on this platform. */
export function openCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
  return ['xdg-open', [url]];
}

/** Opens `url` when it is a local page; returns false (and opens nothing) otherwise or when it cannot. */
export function openLocalPage(url: string, spawnImpl: typeof spawn = spawn): boolean {
  if (!LOCAL_URL.test(url)) return false;
  const [cmd, args] = openCommand(process.platform, url);
  try {
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The command that puts its standard input on the clipboard on this platform. */
export function copyCommand(platform: NodeJS.Platform): [string, string[]] {
  if (platform === 'darwin') return ['pbcopy', []];
  if (platform === 'win32') return ['clip', []];
  return ['xclip', ['-selection', 'clipboard']];
}

/** Puts `text` on the clipboard; resolves false when no clipboard command is available. */
export async function copyText(text: string, spawnImpl: typeof spawn = spawn): Promise<boolean> {
  const commands: Array<[string, string[]]> =
    process.platform === 'linux' ? [['wl-copy', []], copyCommand(process.platform)] : [copyCommand(process.platform)];
  for (const [cmd, args] of commands) {
    const copied = await new Promise<boolean>((resolve) => {
      let settled = false;
      let child: ReturnType<typeof spawn> | undefined;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        done(false);
        child?.kill();
      }, 3000);
      try {
        child = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => done(false));
        child.on('close', (code) => done(code === 0));
        child.stdin?.on('error', () => done(false));
        child.stdin?.end(text);
      } catch {
        done(false);
      }
    });
    if (copied) return true;
  }
  return false;
}

/** Reads only when the user asks to paste. Limit output and subprocess lifetime. */
export async function readClipboard(spawnImpl: typeof spawn = spawn): Promise<string | undefined> {
  const commands: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['pbpaste', []]]
      : process.platform === 'win32'
        ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']]]
        : [
            ['wl-paste', ['--no-newline']],
            ['xclip', ['-selection', 'clipboard', '-o']],
            ['xsel', ['--clipboard', '--output']],
          ];
  for (const [command, args] of commands) {
    const result = await new Promise<string | undefined>((resolve) => {
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const done = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        done(undefined);
        child?.kill();
      }, 3000);
      let child: ReturnType<typeof spawn> | undefined;
      try {
        child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        child.on('error', () => done(undefined));
        child.stdout?.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1_000_000) {
            done(undefined);
            child?.kill();
          } else chunks.push(Buffer.from(chunk));
        });
        child.on('close', (code) => done(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
      } catch {
        done(undefined);
      }
    });
    if (result !== undefined) return result;
  }
  return undefined;
}
