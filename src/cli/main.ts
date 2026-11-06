#!/usr/bin/env node
// `flexx` command-line entry (macOS already ships an unrelated `/usr/bin/flex`). It opens on the gateway scene
// ("Flex ASCII"), turns its objects to dust and brings the splash ("Flex Terminal") up under the title; the wallet
// commands land behind the splash's `flex $` prompt next.

import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ReadStream, WriteStream } from 'node:tty';
import { isHexColor } from './render/paint.js';
import type { SplashShape } from './render/splash.js';
import { detectColorMode, renderStatic, runInteractive, type View, type ViewOptions } from './terminal.js';

export const USAGE = `Usage: flexx [splash|scene] [options]

With no view, opens on the gateway scene, turns the globe, gateway and diamond to
dust and brings the splash up under the FLEX title (any key skips ahead). It fills
the terminal and fits itself to its size: below 120 × 40 the opening is skipped.

Views:
  splash            the splash alone: the logo beside FLEXX; move the mouse to steer
  scene             the gateway scene alone (needs 120 × 40)

Options:
  --shape <s>       splash object: cube (default) or diamond
  --speed <n>       animation speed, 0.25–3 (default 1)
  --accent <hex>    accent colour as #rrggbb
  --no-starfield    scene without the background dots
  --static          print one still frame and exit
  -h, --help        show this help
`;

export interface CliArgs {
  help: boolean;
  staticFrame: boolean;
  /** `opening` when no view is named. */
  view: View;
  shape: SplashShape;
  speed: number;
  accent: string | undefined;
  starfield: boolean;
}

export class UsageError extends Error {}

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      allowNegative: true,
      options: {
        help: { type: 'boolean', short: 'h', default: false },
        static: { type: 'boolean', default: false },
        shape: { type: 'string', default: 'cube' },
        speed: { type: 'string', default: '1' },
        accent: { type: 'string' },
        starfield: { type: 'boolean', default: true },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  const view = positionals[0] ?? 'opening';
  if (view !== 'opening' && view !== 'splash' && view !== 'scene') throw new UsageError(`unknown view: ${view}`);
  if (values.shape !== 'cube' && values.shape !== 'diamond') throw new UsageError('--shape must be cube or diamond');
  const speed = Number(values.speed);
  if (!Number.isFinite(speed) || speed < 0.25 || speed > 3) throw new UsageError('--speed must be between 0.25 and 3');
  if (values.accent !== undefined && !isHexColor(values.accent)) throw new UsageError('--accent must be #rrggbb');
  return {
    help: values.help,
    staticFrame: values.static,
    view,
    shape: values.shape,
    speed,
    accent: values.accent,
    starfield: values.starfield,
  };
}

/** Runs the CLI and returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`flexx: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const opts: ViewOptions = {
    view: args.view,
    splash: { shape: args.shape, speed: args.speed },
    scene: { starfield: args.starfield },
    sceneSpeed: args.speed,
    accent: args.accent,
    colorMode: detectColorMode(process.stdout, process.env),
  };

  const interactive = !args.staticFrame && process.stdin instanceof ReadStream && process.stdout instanceof WriteStream;
  if (!interactive) {
    process.stdout.write(renderStatic(opts));
    return 0;
  }
  const reason = await runInteractive(opts, process.stdin, process.stdout);
  return reason === 'interrupt' ? 130 : 0;
}

/** True when this module is the program being run, including through the `flexx` bin symlink npm installs. */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  // a reader that stops early (`flexx --static | head`) is not an error
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
    process.exit(0);
  });
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`flexx: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
