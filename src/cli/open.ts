// Opens a local page (the wallet's MetaMask approval page) in the user's default browser. Only loopback http URLs
// are opened, so nothing the agent or a message says can send the browser anywhere else.

import { spawn } from 'node:child_process';

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

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
