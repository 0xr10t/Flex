// Runs the CLI full-screen in the terminal: alternate screen, hidden cursor, ~30 fps redraw that rewrites only the
// rows that changed, SGR mouse reporting so the pointer steers the header's cube, and a full restore on every exit
// path. The opening plays the gateway scene under the cube and FLEXX header and snaps the globe, gateway and diamond
// away into dust; then the cube and FLEXX shrink into a small logo on the left and the command box opens from the top
// of the screen. Everything is laid out for the terminal's current size. Also renders a single still frame for pipes
// and `--static`.

import { performance } from 'node:perf_hooks';
import type { ReadStream, WriteStream } from 'node:tty';
import { parseInput, type KeyEvent } from './input.js';
import { Repl } from './repl.js';
import { createFrame, overlay, text, type Frame } from './render/frame.js';
import { frameRows, paintRow, SCENE_PALETTE, SPLASH_PALETTE, type ColorMode, type Palette } from './render/paint.js';
import { renderScene, SCENE_COLS, SCENE_ROWS, type SceneOptions } from './render/scene.js';
import { snap, SNAP_SECONDS } from './render/snap.js';
import { placeSplash, SplashAnimation, SPLASH_TEXT_ROWS, type Pointer, type SplashOptions } from './render/splash.js';
import {
  blendMorph,
  drawBackdrop,
  headerMorph,
  MIN_COLS,
  MIN_ROWS,
  objectsLayer,
  stageLayout,
  type Origin,
  type StageLayout,
} from './render/stage.js';

/** What to show: the opening into the command box, or the splash or scene alone. */
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

/** Opening phases: the scene (or the header alone), its snap, the logo shrinking away, then the command box. */
export type Phase = 'intro' | 'snap' | 'shrink' | 'box';

const ESC = '\u001b';
const CSI = `${ESC}[`;
const FRAME_MS = 33;
/** Terminals do not report the pointer leaving, so steering lapses after this long without movement. */
const POINTER_IDLE_MS = 2500;
/** Rows the standalone splash needs before it shows its cube. */
const SPLASH_CUBE_ROWS = 17;

const ENTER_SCREEN = `${CSI}?1049h${CSI}?25l${CSI}2J`;
const LEAVE_SCREEN = `${CSI}0m${CSI}?25h${CSI}?1049l`;
const MOUSE_ON = `${CSI}?1003h${CSI}?1006h`;
const MOUSE_OFF = `${CSI}?1006l${CSI}?1003l`;
const SYNC_BEGIN = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

/** Scene seconds the opening plays before the snap: long enough for the gateway log to fill. */
export const INTRO_SECONDS = 5.5;
/** Without the scene, how long the header plays: until its tagline and rule have drawn in. */
export const HEADER_SECONDS = 4.6;
/** How long the logo takes to shrink into the corner. */
export const SHRINK_SECONDS = 1.2;

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

function viewPalette(opts: ViewOptions): Palette {
  const base = opts.view === 'splash' ? SPLASH_PALETTE : SCENE_PALETTE;
  return opts.accent ? { ...base, accent: opts.accent } : base;
}

/** Paints a whole-screen frame as one string per row. */
function paintFrame(f: Frame, palette: Palette, mode: ColorMode): string[] {
  return frameRows(f).map((row) => paintRow(row, f.cols, palette, mode));
}

export interface OpeningState {
  phase: Phase;
  /** Scene seconds (speed-scaled) since the opening began, since the snap, and the shrink's progress (0–1). */
  sceneT: number;
  snapS: number;
  shrinkP: number;
  nowMs: number;
  pointer: Pointer;
  starfield: boolean;
}

/** Where the footer is: under the opening, gliding down with the shrink, then under the box. */
function footerAt(layout: StageLayout, s: OpeningState): Origin | null {
  const from = layout.footer;
  const to = layout.final.footer;
  if (s.phase === 'intro' || s.phase === 'snap') return from;
  if (s.phase === 'box') return to;
  if (!from || !to) return null;
  const e = s.shrinkP * s.shrinkP * (3 - 2 * s.shrinkP);
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
}

/** Composes one screen of the opening for its current phase. */
export function composeOpening(layout: StageLayout, s: OpeningState, header: SplashAnimation, repl: Repl): Frame {
  const f = createFrame(layout.cols, layout.rows);
  const { logo, box } = layout.final;
  drawBackdrop(f, s.sceneT, footerAt(layout, s), s.starfield);

  if (s.phase === 'intro' || s.phase === 'snap') {
    if (layout.header) header.draw(f, s.nowMs, s.pointer, layout.header, false);
    const objects = objectsLayer(s.sceneT, layout);
    if (objects) overlay(f, s.phase === 'snap' ? snap(objects, s.snapS) : objects);
    return f;
  }
  if (s.phase === 'shrink' && layout.header && logo) {
    header.drawMorph(f, s.nowMs, s.pointer, blendMorph(headerMorph(layout.header), logo.morph, s.shrinkP));
    return f;
  }
  if (logo) {
    header.drawMorph(f, s.nowMs, s.pointer, logo.morph);
    logo.tagline?.lines.forEach((line, i) => text(f, logo.tagline!.x, logo.tagline!.y + i, line, 1));
  }
  repl.draw(f, box, s.nowMs);
  return f;
}

/** One still frame (the animation settled at `t` seconds), for pipes, `--static` and tests. */
export function renderStatic(opts: ViewOptions, t = 6): string {
  const nowMs = (t / (opts.splash?.speed ?? 1)) * 1000;
  const anim = new SplashAnimation(opts.splash);
  anim.frame(0);
  let frame: Frame;
  if (opts.view === 'scene') frame = renderScene(t, opts.scene);
  else if (opts.view === 'splash') frame = anim.frame(nowMs);
  else {
    const layout = stageLayout(SCENE_COLS, 43)!;
    const pointer = { x: 0, y: 0, on: false };
    const starfield = opts.scene?.starfield ?? true;
    const state = { phase: 'box' as const, sceneT: t, snapS: 0, shrinkP: 1, nowMs, pointer, starfield };
    frame = composeOpening(layout, state, anim, new Repl());
  }
  return paintFrame(frame, viewPalette(opts), opts.colorMode).join('\n') + '\n';
}

/** Plays the view until the user leaves (q, Escape or Ctrl-C on the splash and scene; `exit` or Ctrl-C in the box). */
export function runInteractive(opts: ViewOptions, input: ReadStream, output: WriteStream): Promise<ExitReason> {
  const palette = viewPalette(opts);
  const header = new SplashAnimation(opts.splash);
  const repl = new Repl();
  const sceneSpeed = opts.sceneSpeed ?? 1;
  const starfield = opts.scene?.starfield ?? true;
  const t0 = performance.now();
  let phase: Phase = 'intro';
  let snapAt = 0;
  let shrinkAt = 0;
  let mouse: { col: number; row: number; at: number } | undefined;
  let painted: string[] = [];

  const sceneTime = (now: number): number => ((now - t0) / 1000) * sceneSpeed;
  const snapTime = (now: number): number => ((now - snapAt) / 1000) * sceneSpeed;

  const pointer = (now: number, cols: number, rows: number): Pointer => {
    if (!mouse || now - mouse.at > POINTER_IDLE_MS) return { x: 0, y: 0, on: false };
    return { x: ((mouse.col - 0.5) / cols) * 2 - 1, y: ((mouse.row - 0.5) / rows) * 2 - 1, on: true };
  };

  const tooSmall = (cols: number, rows: number, needCols: number, needRows: number): string =>
    `Make the terminal at least ${needCols} × ${needRows} (it is ${cols} × ${rows}) · Ctrl-C to exit`;

  const frameFor = (now: number, cols: number, rows: number): Frame | string => {
    if (opts.view === 'scene') {
      if (cols < SCENE_COLS || rows < SCENE_ROWS) return tooSmall(cols, rows, SCENE_COLS, SCENE_ROWS);
      const f = createFrame(cols, rows);
      const x = Math.floor((cols - SCENE_COLS) / 2);
      overlay(f, renderScene(sceneTime(now), opts.scene), x, Math.floor((rows - SCENE_ROWS) / 2));
      return f;
    }
    if (opts.view === 'splash') {
      if (cols < MIN_COLS || rows < SPLASH_TEXT_ROWS) return tooSmall(cols, rows, MIN_COLS, SPLASH_TEXT_ROWS);
      const f = createFrame(cols, rows);
      const at = placeSplash(cols, Math.floor((rows - SPLASH_TEXT_ROWS) / 2), rows >= SPLASH_CUBE_ROWS);
      header.draw(f, now, pointer(now, cols, rows), at);
      return f;
    }
    const layout = stageLayout(cols, rows);
    if (!layout) return tooSmall(cols, rows, MIN_COLS, MIN_ROWS);
    const startShrink = (): void => {
      phase = 'shrink';
      shrinkAt = now;
    };
    // nothing to play at this size: straight to the command box
    if (!layout.header) phase = 'box';
    // the objects no longer fit (the terminal shrank): skip their snap
    if (!layout.scene && phase === 'snap') startShrink();
    if (phase === 'intro' && sceneTime(now) >= (layout.scene ? INTRO_SECONDS : HEADER_SECONDS)) {
      if (layout.scene) {
        phase = 'snap';
        snapAt = now;
      } else startShrink();
    }
    if (phase === 'snap' && snapTime(now) >= SNAP_SECONDS) startShrink();
    const shrinkP = Math.min(1, ((now - shrinkAt) / 1000 / SHRINK_SECONDS) * sceneSpeed);
    if (phase === 'shrink' && shrinkP >= 1) phase = 'box';
    const state: OpeningState = {
      phase,
      sceneT: sceneTime(now),
      snapS: snapTime(now),
      shrinkP,
      nowMs: now,
      pointer: pointer(now, cols, rows),
      starfield,
    };
    return composeOpening(layout, state, header, repl);
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
      const full = next.length !== painted.length;
      if (full) s += `${CSI}0m${CSI}2J`;
      next.forEach((line, y) => {
        if (full || line !== painted[y]) s += `${CSI}${y + 1};1H${line}`;
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

    /** Keys on the splash and scene views: q, Escape and Ctrl-C leave, Enter continues. */
    const viewKey = (ev: KeyEvent): void => {
      if (ev.key === 'interrupt') finish('interrupt');
      else if (ev.key === 'escape' || (ev.key === 'char' && ev.char?.toLowerCase() === 'q')) finish('quit');
      else if (ev.key === 'enter') finish('continue');
    };
    /** Keys in the opening: Ctrl-C leaves, any other key skips to the box; from then on the box takes them. */
    const openingKey = (ev: KeyEvent): void => {
      if (phase !== 'box') {
        if (ev.key === 'interrupt') finish('interrupt');
        else phase = 'box';
        return;
      }
      if (repl.handle(ev) === 'quit') finish(ev.key === 'interrupt' ? 'interrupt' : 'quit');
    };

    const onData = (buf: Buffer): void => {
      for (const ev of parseInput(buf.toString('utf8'))) {
        if (done) return;
        if (ev.kind === 'mouse') mouse = { col: ev.col, row: ev.row, at: performance.now() };
        else if (opts.view === 'opening') openingKey(ev);
        else viewKey(ev);
      }
      // echo typing at once rather than on the next tick
      if (!done) draw();
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
