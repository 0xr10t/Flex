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
export function copyText(text: string, spawnImpl: typeof spawn = spawn): Promise<boolean> {
  const [cmd, args] = copyCommand(process.platform);
  return new Promise((resolve) => {
    try {
      const child = spawnImpl(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin?.end(text);
    } catch {
      resolve(false);
    }
  });
}
