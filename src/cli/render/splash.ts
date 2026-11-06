// The terminal splash: a lit cube (or Ethereum diamond) the pointer can steer on the left and, beside it, the FLEXX
// wordmark, a typed tagline, a rule and the `flex $` prompt. Adapted from "Flex Terminal.dc.html" in the Claude Design
// handoff "Flex animated ASCII art" (FLEXX instead of FLEX, status rows removed). It draws into any frame at a
// placement, so it can stand alone or sit under the opening scene's title; narrow terminals drop the cube.

import {
  createFrame,
  dot,
  drawWordmark,
  norm,
  put,
  setCell,
  text,
  wordmarkWidth,
  type Frame,
  type Vec3,
  type WordmarkLetter,
} from './frame.js';

export const SPLASH_COLS = 96;
export const SPLASH_ROWS = 24;

export type SplashShape = 'cube' | 'diamond';

/** Pointer position over the screen, each axis in [-1, 1]; `on` while the pointer is steering. */
export interface Pointer {
  x: number;
  y: number;
  on: boolean;
}

export interface SplashOptions {
  shape?: SplashShape;
  /** Animation speed multiplier (the design's range is 0.25–3). */
  speed?: number;
}

const RAMP = ' .,:-=+*#%@';
const GLYPHS = '0123456789abcdef#$%&*+=<>/';
const TAG = 'the access layer between AI and ethereum';
const LIGHT = norm([-0.45, 0.6, 0.7]);
const CUBE_FACES: { ax: 0 | 1 | 2; s: -1 | 1 }[] = [];
for (const ax of [0, 1, 2] as const) for (const s of [-1, 1] as const) CUBE_FACES.push({ ax, s });

const WORD: readonly WordmarkLetter[] = ['F', 'L', 'E', 'X', 'X'];
const PITCH = 11;
/** Width of the text block: the FLEXX wordmark, which the rule under the tagline matches. */
export const SPLASH_TEXT_WIDTH = wordmarkWidth(WORD.length, PITCH);
/** Text block: wordmark (7 rows), tagline, rule and prompt two rows apart. */
export const SPLASH_TEXT_ROWS = 13;
/** Half the widest the spinning object gets, and the gap the design leaves between it and the text. */
const OBJECT_REACH = 16;
const TEXT_GAP = 3;
/** Logo and text side by side. */
export const SPLASH_GROUP_WIDTH = 2 * OBJECT_REACH + TEXT_GAP + SPLASH_TEXT_WIDTH;
/** Rows the cube needs: it reaches about eight rows either side of its centre. */
export const SPLASH_GROUP_ROWS = 17;

/** Where the splash goes in a frame. `objectX`/`objectY` is the logo's centre; null `objectX` means no logo. */
export interface SplashPlacement {
  objectX: number | null;
  objectY: number;
  textX: number;
  textY: number;
}

/**
 * Centres the splash horizontally in `cols` columns with its text block's top row at `textY`, keeping the logo only
 * when `logo` allows and the width has room for it.
 */
export function placeSplash(cols: number, textY: number, logo = true): SplashPlacement {
  // a row above the text's middle: the pitched-forward cube shows more face below its centre than above
  const objectY = textY + (SPLASH_TEXT_ROWS - 1) / 2 - 1;
  if (logo && cols >= SPLASH_GROUP_WIDTH) {
    const objectX = Math.floor((cols - SPLASH_GROUP_WIDTH) / 2) + OBJECT_REACH;
    return { objectX, objectY, textX: objectX + OBJECT_REACH + TEXT_GAP, textY };
  }
  return { objectX: null, objectY, textX: Math.floor((cols - SPLASH_TEXT_WIDTH) / 2), textY };
}

/** The standalone splash frame's own placement. */
const OWN_PLACEMENT = placeSplash(SPLASH_COLS, Math.floor((SPLASH_ROWS - SPLASH_TEXT_ROWS) / 2));

/** Stateful splash animation: easing of the steering angles carries from frame to frame. */
export class SplashAnimation {
  private readonly shape: SplashShape;
  private readonly speed: number;
  private t0: number | undefined;
  private prev = 0;
  private yaw = 0;
  private pitch = 0.45;
  private spin = 0;
  private hot = 0;

  constructor(opts: SplashOptions = {}) {
    this.shape = opts.shape ?? 'cube';
    this.speed = opts.speed ?? 1;
  }

  /** True once the pointer has eased the layer into steering. */
  get steering(): boolean {
    return this.hot > 0.5;
  }

  /** Renders the standalone 96×24 frame for wall-clock time `nowMs` (milliseconds). */
  frame(nowMs: number, pointer: Pointer = { x: 0, y: 0, on: false }): Frame {
    const f = createFrame(SPLASH_COLS, SPLASH_ROWS);
    this.draw(f, nowMs, pointer, OWN_PLACEMENT);
    return f;
  }

  /**
   * Draws the splash into `f` at `at` for wall-clock time `nowMs`; the first call starts its reveal. `prompt` false
   * leaves out the `flex $` line (the command box has its own).
   */
  draw(f: Frame, nowMs: number, pointer: Pointer, at: SplashPlacement, prompt = true): void {
    if (this.t0 === undefined) {
      this.t0 = nowMs;
      this.prev = nowMs;
    }
    const dt = Math.min(0.1, (nowMs - this.prev) / 1000) * this.speed;
    this.prev = nowMs;
    const t = ((nowMs - this.t0) / 1000) * this.speed;

    // steering
    this.hot += ((pointer.on ? 1 : 0) - this.hot) * Math.min(1, dt * 4);
    this.spin += dt * 0.7 * (1 - this.hot * 0.85);
    const ty = this.spin + (pointer.on ? pointer.x * 1.6 : 0);
    const tp = 0.45 + (pointer.on ? pointer.y * 0.9 : 0);
    this.yaw += (ty - this.yaw) * Math.min(1, dt * 5);
    this.pitch += (tp - this.pitch) * Math.min(1, dt * 5);

    if (at.objectX !== null) this.drawObject(f, at.objectX, at.objectY);
    this.drawText(f, t, at.textX, at.textY, prompt);
  }

  private drawObject(f: Frame, cx: number, cy: number): void {
    const cube = this.shape === 'cube';
    const sx = cube ? 8.6 : 11;
    const sy = cube ? 4.5 : 5.6;
    const cyw = Math.cos(this.yaw);
    const syw = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const tr = (v: Vec3): Vec3 => {
      const x = v[0] * cyw + v[2] * syw;
      const z = -v[0] * syw + v[2] * cyw;
      const y = v[1];
      return [x, y * cp - z * sp, y * sp + z * cp];
    };
    const zb = new Float32Array(f.cols * f.rows).fill(-99);
    const plot = (p: Vec3, n: Vec3, edge: boolean, mark: boolean): void => {
      const persp = 3.4 / (3.4 - p[2]);
      const X = Math.round(cx + p[0] * sx * persp);
      const Y = Math.round(cy - p[1] * sy * persp);
      if (X < 0 || Y < 0 || X >= f.cols || Y >= f.rows) return;
      const i = Y * f.cols + X;
      if (p[2] <= zb[i]!) return;
      zb[i] = p[2];
      const lit = Math.max(0, dot(n, LIGHT));
      if (edge) {
        setCell(f, i, lit > 0.55 ? '#' : lit > 0.2 ? '+' : ':', 2);
      } else if (mark) {
        setCell(f, i, lit > 0.4 ? '=' : '-', lit > 0.3 ? 2 : 1);
      } else {
        setCell(f, i, RAMP[Math.min(10, 1 + Math.floor(lit * 9))]!, lit > 0.3 ? 0 : 1);
      }
    };

    if (cube) {
      for (const { ax, s } of CUBE_FACES) {
        const nv: [number, number, number] = [0, 0, 0];
        nv[ax] = s;
        const n = tr(nv);
        if (n[2] < -0.05) continue;
        for (let u = -1; u <= 1.001; u += 0.04)
          for (let v = -1; v <= 1.001; v += 0.04) {
            const pt: [number, number, number] = [0, 0, 0];
            pt[ax] = s;
            pt[(ax + 1) % 3] = u;
            pt[(ax + 2) % 3] = v;
            const edge = Math.abs(u) > 0.95 || Math.abs(v) > 0.95;
            // horizontal "layers" on the side faces
            const band = ax !== 1 && Math.abs((((pt[1] + 1) * 1.5) % 1) - 0.5) > 0.44;
            plot(tr(pt), n, edge, band);
          }
      }
    } else {
      for (const a of [-1, 1])
        for (const b of [-1, 1])
          for (const c of [-1, 1]) {
            const n = tr(norm([a, b / 1.6, c]));
            if (n[2] < -0.05) continue;
            for (let u = 0; u <= 1; u += 0.025)
              for (let v = 0; u + v <= 1.0001; v += 0.025) {
                const w = 1 - u - v;
                const edge = u < 0.035 || v < 0.035 || w < 0.035;
                plot(tr([a * u * 0.75, b * v * 1.3, c * w * 0.75]), n, edge, Math.abs(v - 0.5) < 0.02);
              }
          }
    }
  }

  private drawText(f: Frame, t: number, wx: number, wy: number, prompt: boolean): void {
    drawWordmark(f, t, {
      word: WORD,
      x: wx,
      y: wy,
      pitch: PITCH,
      revealSpan: SPLASH_TEXT_WIDTH,
      revealScale: 1.1,
      revealJitter: 0.5,
      bandPeriod: 6,
      bandTravel: SPLASH_TEXT_WIDTH + 27,
      bandOffset: 14,
      bandWidth: 1.4,
      glyphs: GLYPHS,
    });

    const tagY = wy + 8;
    const typed = Math.max(0, Math.floor((t - 1.8) * 28));
    text(f, wx, tagY, TAG.slice(0, typed), 0);
    if (typed < TAG.length && t > 1.8 && Math.floor(t * 3) % 2 === 0) put(f, wx + typed, tagY, '_', 2);
    if (t > 3.2)
      for (let x = wx; x < wx + SPLASH_TEXT_WIDTH; x++) if (x - wx < (t - 3.2) * 80) put(f, x, wy + 10, '─', 1);

    if (prompt && t > 4) {
      text(f, wx, wy + 12, 'flex', 2);
      text(f, wx + 4, wy + 12, ' $ ', 1);
      if (Math.floor(t * 2) % 2 === 0) put(f, wx + 7, wy + 12, '█', 0);
    }
  }
}
