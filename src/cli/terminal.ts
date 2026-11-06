// Runs the CLI full-screen in the terminal: alternate screen, hidden cursor, ~30 fps redraw that rewrites only the
// rows that changed, SGR mouse reporting so the pointer steers the splash's logo, and a full restore on every exit
// path. The opening plays the gateway scene over the starfield, snaps its title and objects away into dust and brings
// the splash up over the stars and footer that stay. Everything is laid out for the terminal's current size. Also
// renders a single still frame for pipes and `--static`.

import { performance } from 'node:perf_hooks';
import type { ReadStream, WriteStream } from 'node:tty';
import { createFrame, overlay, type Frame } from './render/frame.js';
import { frameRows, paintRow, SCENE_PALETTE, SPLASH_PALETTE, type ColorMode, type Palette } from './render/paint.js';
import { renderScene, SCENE_COLS, SCENE_ROWS, type SceneOptions } from './render/scene.js';
import { snap, SNAP_SECONDS } from './render/snap.js';
import { SplashAnimation, type Pointer, type SplashOptions } from './render/splash.js';
import { drawBackdrop, MIN_COLS, MIN_ROWS, objectsLayer, stageLayout, type StageLayout } from './render/stage.js';

/** What to show: the opening into the splash, or one of them alone. */
export type View = 'opening' | 'splash' | 'scene';

export interface ViewOptions {
  view: View;
  splash?: SplashOptions;
  scene?: SceneOptions;
  /** Scene speed multiplier (the splash takes its own in `splash.speed`). */
  sceneSpeed?: number;
  /** Overrides the accent colour (#rrggbb). */
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

type Phase = 'intro' | 'snap' | 'splash';

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

function viewPalette(opts: ViewOptions): Palette {
  const base = opts.view === 'splash' ? SPLASH_PALETTE : SCENE_PALETTE;
  return opts.accent ? { ...base, accent: opts.accent } : base;
}

/** Paints a whole-screen frame as one string per row. */
function paintFrame(f: Frame, palette: Palette, mode: ColorMode): string[] {
  return frameRows(f).map((row) => paintRow(row, f.cols, palette, mode));
}

/** Composes one screen of the opening (or the splash that follows it) for `phase`. */
export function composeOpening(
  layout: StageLayout,
  phase: Phase,
  sceneT: number,
  snapS: number,
  splash: SplashAnimation,
  now: number,
  pointer: Pointer,
  starfield: boolean,
): Frame {
  const f = createFrame(layout.cols, layout.rows);
  drawBackdrop(f, sceneT, layout, starfield);
  const objects = phase === 'splash' ? null : objectsLayer(sceneT, layout);
  if (objects) overlay(f, phase === 'snap' ? snap(objects, snapS) : objects);
  else splash.draw(f, now, pointer, layout.splash);
  return f;
}

/** One still frame (the animation settled at `t` seconds), for pipes, `--static` and tests. */
export function renderStatic(opts: ViewOptions, t = 6): string {
  let frame: Frame;
  if (opts.view === 'scene') frame = renderScene(t, opts.scene);
  else {
    const anim = new SplashAnimation(opts.splash);
    const now = (t / (opts.splash?.speed ?? 1)) * 1000;
    anim.frame(0);
    if (opts.view === 'splash') frame = anim.frame(now);
    else {
      const layout = stageLayout(SCENE_COLS, SCENE_ROWS)!;
      frame = composeOpening(
        layout,
        'splash',
        t,
        0,
        anim,
        now,
        { x: 0, y: 0, on: false },
        opts.scene?.starfield ?? true,
      );
    }
  }
  return paintFrame(frame, viewPalette(opts), opts.colorMode).join('\n') + '\n';
}

/** Plays the view until the user presses Enter, q, Escape or Ctrl-C. Requires TTY streams. */
export function runInteractive(opts: ViewOptions, input: ReadStream, output: WriteStream): Promise<ExitReason> {
  const palette = viewPalette(opts);
  const splash = new SplashAnimation(opts.splash);
  const sceneSpeed = opts.sceneSpeed ?? 1;
  const starfield = opts.scene?.starfield ?? true;
  const t0 = performance.now();
  let phase: Phase = opts.view === 'splash' ? 'splash' : 'intro';
  let snapAt = 0;
  let mouse: { col: number; row: number; at: number } | undefined;
  let painted: string[] = [];

  const sceneTime = (now: number): number => ((now - t0) / 1000) * sceneSpeed;
  const snapTime = (now: number): number => ((now - snapAt) / 1000) * sceneSpeed;

  const pointer = (now: number, cols: number, rows: number): Pointer => {
    if (!mouse || now - mouse.at > POINTER_IDLE_MS) return { x: 0, y: 0, on: false };
    return { x: ((mouse.col - 0.5) / cols) * 2 - 1, y: ((mouse.row - 0.5) / rows) * 2 - 1, on: true };
  };

  const skipOpening = (): void => {
    if (opts.view === 'opening') phase = 'splash';
  };

  const frameFor = (now: number, cols: number, rows: number): Frame | string => {
    const layout = stageLayout(cols, rows, opts.view !== 'splash');
    const need = opts.view === 'scene' ? `${SCENE_COLS} × ${SCENE_ROWS}` : `${MIN_COLS} × ${MIN_ROWS}`;
    if (!layout || (opts.view === 'scene' && !layout.scene))
      return `Make the terminal at least ${need} (it is ${cols} × ${rows}) · q to exit`;

    if (opts.view === 'opening') {
      if (phase === 'intro' && sceneTime(now) >= INTRO_SECONDS) {
        phase = 'snap';
        snapAt = now;
      }
      if (phase === 'snap' && snapTime(now) >= SNAP_SECONDS) phase = 'splash';
      // no room for the opening's objects: straight to the splash
      if (!layout.scene) phase = 'splash';
    }
    if (opts.view === 'splash') {
      const f = createFrame(cols, rows);
      splash.draw(f, now, pointer(now, cols, rows), layout.splash);
      return f;
    }
    const p = opts.view === 'scene' ? 'intro' : phase;
    return composeOpening(layout, p, sceneTime(now), snapTime(now), splash, now, pointer(now, cols, rows), starfield);
  };

  const draw = (): void => {
    const now = performance.now();
    const cols = output.columns || 80;
    const rows = output.rows || 24;
    const frame = frameFor(now, cols, rows);
    let s = SYNC_BEGIN;
    if (typeof frame === 'string') {
      const y = Math.ceil(rows / 2);
      const x = Math.max(1, Math.floor((cols - frame.length) / 2) + 1);
      s += `${CSI}0m${CSI}2J${CSI}${y};${x}H${frame}`;
      painted = [];
    } else {
      const next = paintFrame(frame, palette, opts.colorMode);
      // only rewrite the rows that changed since the last frame (all of them after a resize)
      if (next.length !== painted.length) s += `${CSI}0m${CSI}2J`;
      next.forEach((line, y) => {
        if (line !== painted[y] || next.length !== painted.length) s += `${CSI}${y + 1};1H${line}`;
      });
      painted = next;
    }
    output.write(s + SYNC_END);
  };

  return new Promise<ExitReason>((resolve) => {
    let done = false;
    const wasRaw = input.isRaw;
    const restore = (): void => {
      output.write(MOUSE_OFF + LEAVE_SCREEN);
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
        else if (opts.view === 'opening' && phase !== 'splash') skipOpening();
        else if (ev.key === 'enter') return finish('continue');
      }
    };
    const onResize = (): void => {
      painted = [];
    };
    const onTerm = (): void => finish('interrupt');

    output.write(ENTER_SCREEN + MOUSE_ON);
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
