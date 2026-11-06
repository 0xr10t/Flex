// The 80×24 terminal splash: a lit cube (or Ethereum diamond) the pointer can steer, the FLEX wordmark, a typed
// tagline and the status rows ending in the `flex $` prompt. Port of "Flex Terminal.dc.html" from the Claude Design
// handoff "Flex animated ASCII art".

import { createFrame, dot, drawWordmark, norm, put, text, type Frame, type Vec3 } from './frame.js';

export const SPLASH_COLS = 80;
export const SPLASH_ROWS = 24;

export type SplashShape = 'cube' | 'diamond';

/** Pointer position over the splash panel, each axis in [-1, 1]; `on` while the pointer is steering. */
export interface Pointer {
  x: number;
  y: number;
  on: boolean;
}

/** Values for the `ai model` and `ethereum` status rows. */
export interface SplashStatus {
  aiModel: string;
  ethereum: string;
}

export interface SplashOptions {
  shape?: SplashShape;
  /** Animation speed multiplier (the design's range is 0.25–3). */
  speed?: number;
  /**
   * Status row values at time `t` (seconds, speed-scaled). Defaults to the design's simulated values; the CLI
   * passes real ones once it is connected to the model and the chain.
   */
  status?: (t: number) => SplashStatus;
}

const RAMP = ' .,:-=+*#%@';
const GLYPHS = '0123456789abcdef#$%&*+=<>/';
const TAG = 'the access layer between AI and ethereum';
const LIGHT = norm([-0.45, 0.6, 0.7]);
const CUBE_FACES: { ax: 0 | 1 | 2; s: -1 | 1 }[] = [];
for (const ax of [0, 1, 2] as const) for (const s of [-1, 1] as const) CUBE_FACES.push({ ax, s });

/** The design's simulated status: a connected model and a block number that ticks every two seconds. */
export function simulatedStatus(t: number): SplashStatus {
  return { aiModel: 'connected', ethereum: 'block #' + (21004200 + Math.floor(t / 2)).toLocaleString('en-US') };
}

/** Stateful splash animation: easing of the steering angles carries from frame to frame. */
export class SplashAnimation {
  private readonly shape: SplashShape;
  private readonly speed: number;
  private readonly status: (t: number) => SplashStatus;
  private t0: number | undefined;
  private prev = 0;
  private yaw = 0;
  private pitch = 0.45;
  private spin = 0;
  private hot = 0;

  constructor(opts: SplashOptions = {}) {
    this.shape = opts.shape ?? 'cube';
    this.speed = opts.speed ?? 1;
    this.status = opts.status ?? simulatedStatus;
  }

  /** True once the pointer has eased the layer into steering. */
  get steering(): boolean {
    return this.hot > 0.5;
  }

  /** Renders the frame for wall-clock time `nowMs` (milliseconds). */
  frame(nowMs: number, pointer: Pointer = { x: 0, y: 0, on: false }): Frame {
    if (this.t0 === undefined) {
      this.t0 = nowMs;
      this.prev = nowMs;
    }
    const dt = Math.min(0.1, (nowMs - this.prev) / 1000) * this.speed;
    this.prev = nowMs;
    const t = ((nowMs - this.t0) / 1000) * this.speed;
    const f = createFrame(SPLASH_COLS, SPLASH_ROWS);

    // steering
    this.hot += ((pointer.on ? 1 : 0) - this.hot) * Math.min(1, dt * 4);
    this.spin += dt * 0.7 * (1 - this.hot * 0.85);
    const ty = this.spin + (pointer.on ? pointer.x * 1.6 : 0);
    const tp = 0.45 + (pointer.on ? pointer.y * 0.9 : 0);
    this.yaw += (ty - this.yaw) * Math.min(1, dt * 5);
    this.pitch += (tp - this.pitch) * Math.min(1, dt * 5);

    this.drawObject(f);
    this.drawText(f, t);
    return f;
  }

  private drawObject(f: Frame): void {
    const cube = this.shape === 'cube';
    const cx = 17;
    const cy = 11.5;
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
        f.ch[i] = lit > 0.55 ? '#' : lit > 0.2 ? '+' : ':';
        f.tone[i] = 2;
      } else if (mark) {
        f.ch[i] = lit > 0.4 ? '=' : '-';
        f.tone[i] = lit > 0.3 ? 2 : 1;
      } else {
        f.ch[i] = RAMP[Math.min(10, 1 + Math.floor(lit * 9))]!;
        f.tone[i] = lit > 0.3 ? 0 : 1;
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

  private drawText(f: Frame, t: number): void {
    const wx = 36;
    drawWordmark(f, t, {
      x: wx,
      y: 3,
      pitch: 11,
      revealSpan: 43,
      revealScale: 1.1,
      revealJitter: 0.5,
      bandPeriod: 6,
      bandTravel: 70,
      bandOffset: 14,
      bandWidth: 1.4,
      glyphs: GLYPHS,
    });

    const typed = Math.max(0, Math.floor((t - 1.8) * 28));
    text(f, wx, 11, TAG.slice(0, typed), 0);
    if (typed < TAG.length && t > 1.8 && Math.floor(t * 3) % 2 === 0) put(f, wx + typed, 11, '_', 2);
    if (t > 3.2) for (let x = wx; x < wx + 43; x++) if (x - wx < (t - 3.2) * 80) put(f, x, 13, '─', 1);

    const status = this.status(t);
    const rows: [string, string][] = [
      ['ai model', status.aiModel],
      ['ethereum', status.ethereum],
      ['layer', this.steering ? 'steering' : 'idle'],
    ];
    rows.forEach(([k, v], i) => {
      if (t < 3.6 + i * 0.35) return;
      put(f, wx, 15 + i * 2, '>', 2);
      text(f, wx + 2, 15 + i * 2, k, 1);
      text(f, wx + 13, 15 + i * 2, v, i === 2 && this.steering ? 2 : 0);
    });
    if (t > 4.8) {
      text(f, wx, 21, 'flex', 2);
      text(f, wx + 4, 21, ' $ ', 1);
      if (Math.floor(t * 2) % 2 === 0) put(f, wx + 7, 21, '█', 0);
    }
  }
}
