// The 120×40 gateway scene: an AI-model sphere and an Ethereum octahedron joined through the FLEX GATEWAY log box by
// packet rails, under the FLEX title and over a starfield. Port of "Flex ASCII.dc.html" from the Claude Design
// handoff "Flex animated ASCII art". Drawn in layers so the opening can keep the title and stars while the objects
// turn to dust. Purely a function of time, so it needs no state.

import {
  createFrame,
  dot,
  drawWordmark,
  hash,
  norm,
  overlay,
  put,
  setCell,
  text,
  type Frame,
  type Tone,
  type Vec3,
} from './frame.js';

export const SCENE_COLS = 120;
export const SCENE_ROWS = 40;

export interface SceneOptions {
  /** Twinkling background dots (the design's `starfield` prop, default on). */
  starfield?: boolean;
}

const RAMP = ' .:-=+*#%@';
const GLYPHS = '0123456789abcdef#$%&*+=<>/\\';
const LIGHT = norm([-0.5, 0.6, 0.65]);
const SPHERE_X = 20;
const OCTAHEDRON_X = 100;
/** The footer's row, and the rows the objects layer spans, in scene coordinates. */
export const SCENE_FOOTER_ROW = 38;
export const SCENE_OBJECTS_TOP = 14;
export const SCENE_OBJECTS_BOTTOM = 35;
const LOGS = [
  '> infer   model.req',
  '  auth    flex.key',
  '  sign    tx 0x{h}',
  '> rpc     eth_call',
  '< block   #{b}',
  '< ok      {ms}ms',
  '> read    slot 0x{h}',
  '  verify  sig ok',
  '> route   mainnet',
  '< emit    Event 0x{h}',
];

/** The layers of the scene, each drawn in the design's 120×40 coordinates. */
export type SceneLayer = 'title' | 'objects' | 'footer';

/** Twinkling dots over the whole frame, whatever its size. */
export function drawStarfield(f: Frame, t: number): void {
  for (let y = 0; y < f.rows; y++)
    for (let x = 0; x < f.cols; x++) {
      const r = hash(x, y, 7);
      if (r < 0.025) put(f, x, y, hash(x, y, Math.floor(t * 0.7 + r * 50)) < 0.85 ? '.' : '+', 1);
    }
}

/**
 * One layer of the scene at `t` seconds: `title` is the FLEX wordmark and tagline, `objects` the globe, gateway,
 * diamond, rails and labels, `footer` the block line.
 */
export function renderSceneLayer(t: number, layer: SceneLayer): Frame {
  const f = createFrame(SCENE_COLS, SCENE_ROWS);
  const center = (y: number, s: string, k: Tone): void => text(f, Math.floor((SCENE_COLS - s.length) / 2), y, s, k);
  if (layer === 'title') {
    drawWordmark(f, t, {
      word: ['F', 'L', 'E', 'X'],
      x: 37,
      y: 2,
      pitch: 12,
      revealSpan: 46,
      revealScale: 1.4,
      revealJitter: 0.6,
      bandPeriod: 5,
      bandTravel: 80,
      bandOffset: 15,
      bandWidth: 1.6,
      glyphs: GLYPHS,
    });
    if (t > 1.6) center(10, 'THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM', 1);
  } else if (layer === 'objects') {
    drawSphere(f, t, SPHERE_X);
    drawOctahedron(f, t, OCTAHEDRON_X);
    drawGateway(f, t);
    drawRails(f, t);
    text(f, SPHERE_X - 5, 35, '[ AI MODEL ]', 0);
    text(f, OCTAHEDRON_X - 7, 35, '[ ETHEREUM ]', 0);
  } else {
    const blk = (21004200 + Math.floor(t / 1.5)).toLocaleString('en-US');
    const ms = 18 + Math.floor(hash(Math.floor(t), 4, 4) * 30);
    center(38, `block #${blk}   ·   ${ms}ms   ·   flex.access`, 1);
  }
  return f;
}

/** The whole 120×40 scene at `t` seconds (already speed-scaled), exactly as the design draws it. */
export function renderScene(t: number, opts: SceneOptions = {}): Frame {
  const f = createFrame(SCENE_COLS, SCENE_ROWS);
  if (opts.starfield ?? true) drawStarfield(f, t);
  for (const layer of ['title', 'objects', 'footer'] as const) overlay(f, renderSceneLayer(t, layer));
  return f;
}

/** Lit sphere with a rotating lat/long grid and node markers. */
function drawSphere(f: Frame, t: number, scx: number): void {
  const scy = 24;
  const sry = 9;
  const srx = 17.5;
  const rot = t * 0.6;
  const step = Math.PI / 6;
  for (let y = Math.floor(scy - sry); y <= Math.ceil(scy + sry); y++)
    for (let x = Math.floor(scx - srx); x <= Math.ceil(scx + srx); x++) {
      const nx = (x - scx) / srx;
      const ny = -(y - scy) / sry;
      const q = nx * nx + ny * ny;
      if (q > 1) continue;
      const nz = Math.sqrt(1 - q);
      const lit = Math.max(0, dot([nx, ny, nz], LIGHT));
      const rx = nx * Math.cos(rot) + nz * Math.sin(rot);
      const rz = -nx * Math.sin(rot) + nz * Math.cos(rot);
      const lon = Math.atan2(rx, rz);
      const lat = Math.asin(ny);
      const fl = (((lon / step) % 1) + 1) % 1;
      const fa = (((lat / step) % 1) + 1) % 1;
      const grid = Math.abs(fl - 0.5) > 0.44 || Math.abs(fa - 0.5) > 0.42;
      const node = Math.abs(fl - 0.5) > 0.42 && Math.abs(fa - 0.5) > 0.4;
      if (node && lit > 0.25) put(f, x, y, 'o', 2);
      else if (grid) put(f, x, y, RAMP[Math.min(9, 2 + Math.floor(lit * 8))]!, lit > 0.45 ? 0 : 1);
      else put(f, x, y, RAMP[Math.min(9, Math.floor(lit * 5))]!, 1);
    }
}

/** Spinning, slightly tilted octahedron (the Ethereum diamond) with accent edges. */
function drawOctahedron(f: Frame, t: number, ocx: number): void {
  const ocy = 24;
  const ory = 10;
  const orx = 16;
  const a = t * 0.7;
  const tilt = 0.25;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const zb = new Float32Array(f.cols * f.rows).fill(-99);
  const tr = (v: Vec3): Vec3 => {
    const x = v[0] * ca + v[2] * sa;
    const z = -v[0] * sa + v[2] * ca;
    const y = v[1];
    return [x, y * ct - z * st, y * st + z * ct];
  };
  for (const sxn of [-1, 1])
    for (const syn of [-1, 1])
      for (const szn of [-1, 1]) {
        const n = tr(norm([sxn, syn / 1.7, szn]));
        const lit = Math.max(0, dot(n, LIGHT));
        for (let u = 0; u <= 1; u += 0.025)
          for (let v = 0; u + v <= 1.0001; v += 0.025) {
            const w = 1 - u - v;
            const p = tr([sxn * u * 0.62, syn * v * 1.05, szn * w * 0.62]);
            const X = Math.round(ocx + p[0] * orx);
            const Y = Math.round(ocy - p[1] * ory);
            if (X < 0 || Y < 0 || X >= f.cols || Y >= f.rows) continue;
            const i = Y * f.cols + X;
            if (p[2] <= zb[i]!) continue;
            zb[i] = p[2];
            const edge = u < 0.03 || v < 0.03 || w < 0.03;
            if (edge && n[2] > -0.1) {
              setCell(f, i, lit > 0.5 ? '#' : '+', 2);
            } else {
              setCell(f, i, RAMP[Math.min(9, 1 + Math.floor(lit * 8))]!, lit > 0.35 ? 0 : 1);
            }
          }
      }
}

/** The FLEX GATEWAY box with its scrolling request log. */
function drawGateway(f: Frame, t: number): void {
  const bx0 = 50;
  const bx1 = 70;
  const by0 = 17;
  const by1 = 31;
  for (let x = bx0; x <= bx1; x++) {
    put(f, x, by0, '-', 0);
    put(f, x, by1, '-', 0);
  }
  for (let y = by0; y <= by1; y++) {
    put(f, bx0, y, '|', 0);
    put(f, bx1, y, '|', 0);
  }
  for (const [x, y] of [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ] as const)
    put(f, x, y, '+', 2);
  text(f, bx0 + 2, by0, ' FLEX GATEWAY ', 2);
  const n = Math.floor(t / 0.55);
  const lines = by1 - by0 - 2;
  for (let i = 0; i < lines; i++) {
    const k = n - (lines - 1 - i);
    if (k < 0) continue;
    const s = LOGS[Math.floor(hash(k, 1, 9) * LOGS.length)]!.replace(
      '{h}',
      Math.floor(hash(k, 2, 9) * 65535)
        .toString(16)
        .padStart(4, '0'),
    )
      .replace('{b}', String(21004200 + Math.floor(k / 3)).slice(-5))
      .replace('{ms}', String(18 + Math.floor(hash(k, 3, 9) * 40)));
    text(f, bx0 + 1, by0 + 1 + i, s.slice(0, 19), i === lines - 1 ? 2 : i > lines - 5 ? 0 : 1);
  }
}

/** Two rails each way between the shapes and the gateway, with packets flowing along them. */
function drawRails(f: Frame, t: number): void {
  for (const [x0, x1, y] of [
    [39, 49, 22],
    [71, 82, 22],
    [39, 49, 26],
    [71, 82, 26],
  ] as const)
    for (let x = x0; x <= x1; x++) put(f, x, y, '-', 1);
  const span = 49 - 39 + 1 + (82 - 71 + 1);
  const mapX = (p: number): number => (p < 11 ? 39 + p : 71 + (p - 11));
  for (let k = 0; k < 3; k++) {
    const p = (t * 9 + (k * span) / 3) % span;
    for (let j = 0; j < 3; j++) {
      const pf = Math.floor(p) - j;
      if (pf >= 0) put(f, mapX(pf), 22, j === 0 ? '>' : '=', j === 0 ? 2 : 0);
      const pb = span - 1 - Math.floor(p) + j;
      if (pb < span) put(f, mapX(pb), 26, j === 0 ? '<' : '=', j === 0 ? 2 : 0);
    }
  }
  text(f, 39, 21, 'prompt', 1);
  text(f, 73, 21, 'tx/call', 1);
  text(f, 39, 27, 'state', 1);
  text(f, 73, 27, 'receipt', 1);
}
