// Desktop helpers: opens a local page (the wallet's MetaMask approval page) in the default browser, and copies text
// to the clipboard for /copy. Only loopback http URLs are opened, so nothing the agent or a message says can send the
// browser anywhere else.

import { spawn } from 'node:child_process';

const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/(#(?:approve=req_[0-9a-f]{12}|connect=[0-9a-f]{64}))?$/;

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

/** Waits for the OS opener, which uses the user's default browser. */
export function openLocalPageAsync(url: string, spawnImpl: typeof spawn = spawn): Promise<boolean> {
  if (!LOCAL_URL.test(url)) return Promise.resolve(false);
  const [cmd, args] = openCommand(process.platform, url);
  return runDesktopCommand(cmd, args, spawnImpl);
}

function runDesktopCommand(cmd: string, args: string[], spawnImpl: typeof spawn): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawnImpl(cmd, args, { stdio: 'ignore', windowsHide: true });
      child.once('error', () => resolve(false));
      child.once('exit', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Best-effort foreground return; unsupported window managers leave a clear browser completion message. */
export async function focusTerminal(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): Promise<boolean> {
  if (platform === 'darwin') {
    const apps: Record<string, string> = {
      Apple_Terminal: 'com.apple.Terminal',
      'iTerm.app': 'com.googlecode.iterm2',
      vscode: 'com.microsoft.VSCode',
      WezTerm: 'com.github.wez.wezterm',
      ghostty: 'com.mitchellh.ghostty',
      WarpTerminal: 'dev.warp.Warp-Stable',
    };
    const app = apps[env.TERM_PROGRAM ?? 'Apple_Terminal'];
    return app ? runDesktopCommand('open', ['-b', app], spawnImpl) : false;
  }
  if (platform === 'linux' && /^\d+$/.test(env.WINDOWID ?? ''))
    return runDesktopCommand('xdotool', ['windowactivate', env.WINDOWID!], spawnImpl);
  if (platform === 'win32')
    return runDesktopCommand(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(New-Object -ComObject WScript.Shell).AppActivate(${process.ppid}) | Out-Null`,
      ],
      spawnImpl,
    );
  return false;
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
