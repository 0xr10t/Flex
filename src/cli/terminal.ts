// Runs a view in the terminal: alternate screen, hidden cursor, ~30 fps redraw, SGR mouse reporting so the pointer
// steers the splash (as hovering does in the design), and a full restore on every exit path. With `intro`, the
// gateway scene plays first and then disintegrates (the snap) before the splash comes up. Also renders a single still
// frame for pipes and `--static`.

import { performance } from 'node:perf_hooks';
import type { ReadStream, WriteStream } from 'node:tty';
import { padFrame } from './render/frame.js';
import { minimumSize, PAD_X, panel, place, type Placement, type View } from './render/layout.js';
import {
  frameRows,
  paintRow,
  SCENE_PALETTE,
  SPLASH_PALETTE,
  type ColorMode,
  type Palette,
  type Row,
} from './render/paint.js';
import { renderScene, type SceneOptions } from './render/scene.js';
import { snap, SNAP_SECONDS } from './render/snap.js';
import { SplashAnimation, type Pointer, type SplashOptions } from './render/splash.js';

export interface ViewOptions {
  view: View;
  /** Open on the gateway scene and snap it away into the splash (interactive runs of the splash only). */
  intro?: boolean;
  splash?: SplashOptions;
  scene?: SceneOptions;
  /** Scene speed multiplier (the splash takes its own in `splash.speed`). */
  sceneSpeed?: number;
  /** Overrides the view's accent colour (#rrggbb). */
  accent?: string;
  colorMode: ColorMode;
}

export type ExitReason = 'continue' | 'quit' | 'interrupt';

export type InputEvent =
  { kind: 'mouse'; col: number; row: number } | { kind: 'key'; key: 'enter' | 'quit' | 'interrupt' | 'other' };

const ESC = '\u001b';
const CSI = `${ESC}[`;
const FRAME_MS = 33;
/** Terminals do not report the pointer leaving, so steering lapses after this long without movement. */
const POINTER_IDLE_MS = 2500;

const ENTER_SCREEN = `${CSI}?1049h${CSI}?25l${CSI}2J`;
const LEAVE_SCREEN = `${CSI}0m${CSI}?25h${CSI}?1049l`;
const MOUSE_ON = `${CSI}?1003h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1006l${CSI}?1003l`;
const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

/** Scene seconds the opening plays before the snap: long enough for the gateway log to fill. */
export const INTRO_SECONDS = 5.5;

type Phase = 'intro' | 'snap' | View;

/** Picks a colour mode from the stream and environment (NO_COLOR wins, then FORCE_COLOR, then the TTY's depth). */
export function detectColorMode(
  stream: { isTTY?: boolean; getColorDepth?: () => number },
  env: NodeJS.ProcessEnv,
): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.FORCE_COLOR === '0') return 'none';
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 'truecolor';
  if (!stream.isTTY && env.FORCE_COLOR === undefined) return 'none';
  const depth = stream.getColorDepth?.() ?? 8;
  return depth >= 24 ? 'truecolor' : depth >= 8 ? '256' : depth >= 4 ? 'basic' : 'none';
}

/**
 * Splits raw terminal input into mouse moves and key presses. Mouse reports use SGR encoding
 * (`ESC [ < button ; col ; row M|m`); only their position matters here.
 */
export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < data.length) {
    if (data.startsWith(`${CSI}<`, i)) {
      let j = i + 3;
      while (j < data.length && data[j] !== 'M' && data[j] !== 'm') j++;
      const parts = data.slice(i + 3, j).split(';');
      const col = Number(parts[1]);
      const row = Number(parts[2]);
      if (parts.length === 3 && Number.isInteger(col) && Number.isInteger(row))
        events.push({ kind: 'mouse', col, row });
      i = j + 1;
      continue;
    }
    if (data[i] === ESC) {
      // A lone Escape quits; any other escape sequence (arrows, focus reports) is ignored.
      if (i + 1 >= data.length) events.push({ kind: 'key', key: 'quit' });
      else {
        let j = i + 2;
        while (j < data.length && !/[A-Za-z~]/.test(data[j]!)) j++;
        events.push({ kind: 'key', key: 'other' });
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    const c = data[i]!;
    const key =
      c === '\r' || c === '\n' ? 'enter' : c === 'q' || c === 'Q' ? 'quit' : c === '\u0003' ? 'interrupt' : 'other';
    events.push({ kind: 'key', key });
    i++;
  }
  return events;
}

function viewPalette(opts: ViewOptions, view: View = opts.view): Palette {
  const base = view === 'splash' ? SPLASH_PALETTE : SCENE_PALETTE;
  return opts.accent ? { ...base, accent: opts.accent } : base;
}

function paintPanel(rows: Row[], width: number, p: Placement, palette: Palette, mode: ColorMode): string {
  let s = '';
  rows.forEach((row, i) => {
    s += `${CSI}${p.top + i};${p.left}H` + paintRow(row, width, palette, mode);
  });
  return s;
}

/** One still frame (the animation settled at `t` seconds), for pipes, `--static` and tests. */
export function renderStatic(opts: ViewOptions, t = 6): string {
  const palette = viewPalette(opts);
  let frame;
  if (opts.view === 'splash') {
    const anim = new SplashAnimation(opts.splash);
    anim.frame(0);
    frame = anim.frame((t / (opts.splash?.speed ?? 1)) * 1000);
  } else frame = renderScene(t, opts.scene);
  const pnl = panel(opts.view, frame, true);
  return pnl.rows.map((r) => paintRow(r, pnl.width, palette, opts.colorMode)).join('\n') + '\n';
}

/** Plays the view until the user presses Enter, q, Escape or Ctrl-C. Requires TTY streams. */
export function runInteractive(opts: ViewOptions, input: ReadStream, output: WriteStream): Promise<ExitReason> {
  const splash = opts.view === 'splash' ? new SplashAnimation(opts.splash) : undefined;
  const sceneSpeed = opts.sceneSpeed ?? 1;
  const t0 = performance.now();
  let phase: Phase = opts.intro && opts.view === 'splash' ? 'intro' : opts.view;
  let snapAt = 0;
  let mouse: { col: number; row: number; at: number } | undefined;
  let placement: Placement | null = null;
  let dirty = true;

  const enter = (next: Phase): void => {
    phase = next;
    dirty = true;
  };
  const viewOf = (p: Phase): View => (p === 'intro' || p === 'snap' ? 'scene' : p);
  const sceneTime = (now: number): number => ((now - t0) / 1000) * sceneSpeed;

  const pointer = (now: number): Pointer => {
    if (!mouse || !placement || now - mouse.at > POINTER_IDLE_MS) return { x: 0, y: 0, on: false };
    const x = (mouse.col - placement.left + 0.5) / placement.width;
    const y = (mouse.row - placement.top + 0.5) / placement.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return { x: 0, y: 0, on: false };
    return { x: x * 2 - 1, y: y * 2 - 1, on: true };
  };

  /** The rows to paint for the current phase, after advancing it. */
  const rowsFor = (now: number, p: Placement): { rows: Row[]; width: number } => {
    if (phase === 'intro' && sceneTime(now) >= INTRO_SECONDS) {
      phase = 'snap';
      snapAt = now;
    }
    if (phase === 'snap') {
      const scene = renderScene(sceneTime(now), opts.scene);
      const framed = p.chrome ? padFrame(scene, PAD_X, 1) : scene;
      const dust = snap(framed, ((now - snapAt) / 1000) * sceneSpeed);
      return { rows: frameRows(dust), width: framed.cols };
    }
    const view = viewOf(phase);
    const frame = view === 'splash' ? splash!.frame(now, pointer(now)) : renderScene(sceneTime(now), opts.scene);
    const pnl = panel(view, frame, p.chrome);
    return { rows: pnl.rows, width: pnl.width };
  };

  const draw = (): void => {
    const now = performance.now();
    const cols = output.columns || 80;
    const rows = output.rows || 24;
    if (phase === 'snap' && ((now - snapAt) / 1000) * sceneSpeed >= SNAP_SECONDS) enter('splash');
    placement = place(viewOf(phase), cols, rows);
    // a terminal too small for the opening goes straight to the splash
    if (!placement && (phase === 'intro' || phase === 'snap')) {
      enter('splash');
      placement = place('splash', cols, rows);
    }
    let s = SYNC_BEGIN;
    if (dirty) s += `${CSI}0m${CSI}2J`;
    if (!placement) {
      const min = minimumSize(viewOf(phase));
      const msg = `Make the terminal at least ${min.cols} × ${min.rows} (it is ${cols} × ${rows}) · q to exit`;
      s += `${CSI}0m${CSI}2J${CSI}${Math.ceil(rows / 2)};${Math.max(1, Math.floor((cols - msg.length) / 2) + 1)}H${msg}`;
      dirty = true;
    } else {
      const { rows: painted, width } = rowsFor(now, placement);
      const palette = viewPalette(opts, viewOf(phase));
      s += paintPanel(painted, width, placement, palette, opts.colorMode);
      dirty = false;
    }
    output.write(s + SYNC_END);
  };

  return new Promise<ExitReason>((resolve) => {
    let done = false;
    const wasRaw = input.isRaw;
    const restore = (): void => {
      output.write((splash ? MOUSE_OFF : '') + LEAVE_SCREEN);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // the stream may already be closed
      }
    };
    const finish = (reason: ExitReason): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      input.off('data', onData);
      output.off('resize', onResize);
      process.off('exit', restore);
      process.off('SIGTERM', onTerm);
      restore();
      input.pause();
      resolve(reason);
    };
    const onData = (buf: Buffer): void => {
      for (const ev of parseInput(buf.toString('utf8'))) {
        if (ev.kind === 'mouse') mouse = { col: ev.col, row: ev.row, at: performance.now() };
        else if (ev.key === 'quit') return finish('quit');
        else if (ev.key === 'interrupt') return finish('interrupt');
        // during the opening any other key skips to the splash
        else if (phase === 'intro' || phase === 'snap') enter('splash');
        else if (ev.key === 'enter') return finish('continue');
      }
    };
    const onResize = (): void => {
      dirty = true;
    };
    const onTerm = (): void => finish('interrupt');

    output.write(ENTER_SCREEN + (splash ? MOUSE_ON : ''));
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.on('resize', onResize);
    process.on('exit', restore);
    process.on('SIGTERM', onTerm);
    draw();
    const timer = setInterval(draw, FRAME_MS);
  });
}
