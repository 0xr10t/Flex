// Character grid shared by the CLI's ASCII renderers. A frame holds one glyph and one tone per cell; painters turn the
// tones into colours. Ported from the Claude Design handoff "Flex animated ASCII art" (Flex ASCII / Flex Terminal).

/** 0 = foreground, 1 = dim, 2 = accent. */
export type Tone = 0 | 1 | 2;

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  readonly ch: string[];
  readonly tone: Uint8Array;
  /** 1 where something was drawn, spaces included (a dark patch of the globe still hides the stars behind it). */
  readonly written: Uint8Array;
}

export type Vec3 = readonly [number, number, number];

export function createFrame(cols: number, rows: number): Frame {
  const n = cols * rows;
  return { cols, rows, ch: new Array<string>(n).fill(' '), tone: new Uint8Array(n), written: new Uint8Array(n) };
}

/** Draws cell `i` (an index already known to be inside the frame). */
export function setCell(f: Frame, i: number, c: string, k: Tone): void {
  f.ch[i] = c;
  f.tone[i] = k;
  f.written[i] = 1;
}

/** Copies the drawn cells of `src` onto `dst` with `src`'s origin at (ox, oy); cells falling outside are dropped. */
export function overlay(dst: Frame, src: Frame, ox = 0, oy = 0): void {
  for (let y = 0; y < src.rows; y++) {
    const Y = y + oy;
    if (Y < 0 || Y >= dst.rows) continue;
    for (let x = 0; x < src.cols; x++) {
      const X = x + ox;
      const i = y * src.cols + x;
      if (X < 0 || X >= dst.cols || !src.written[i]) continue;
      setCell(dst, Y * dst.cols + X, src.ch[i]!, src.tone[i]! as Tone);
    }
  }
}

/** Writes one glyph at the rounded cell position; positions outside the grid are ignored. */
export function put(f: Frame, x: number, y: number, c: string, k: Tone = 0): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= f.cols || y >= f.rows) return;
  setCell(f, y * f.cols + x, c, k);
}

export function text(f: Frame, x: number, y: number, s: string, k: Tone = 0): void {
  [...s].forEach((c, i) => put(f, x + i, y, c, k));
}

/** A rectangle of cells. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Deterministic value in [0, 1) for a cell and a time bucket. Kept exactly as the designs wrote it (a float multiply,
 * not Math.imul) so the noise patterns match the prototypes.
 */
export function hash(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The rows of a frame as plain strings. */
export function frameLines(f: Frame): string[] {
  const out: string[] = [];
  for (let y = 0; y < f.rows; y++) out.push(f.ch.slice(y * f.cols, (y + 1) * f.cols).join(''));
  return out;
}

export type WordmarkLetter = 'F' | 'L' | 'E' | 'X';

/** 5×7 block font for the wordmark. */
export const FONT: Readonly<Record<WordmarkLetter, readonly string[]>> = {
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
};

/** Width in columns of a wordmark drawn with `pitch` between letters. */
export function wordmarkWidth(letters: number, pitch: number): number {
  return (letters - 1) * pitch + 10;
}

export interface WordmarkSpec {
  /** Letters to draw, each from FONT (10 columns wide at two cells per pixel). */
  word: readonly WordmarkLetter[];
  x: number;
  y: number;
  /** Columns between letter origins. */
  pitch: number;
  /** Width the reveal sweeps across. */
  revealSpan: number;
  revealScale: number;
  revealJitter: number;
  /** Seconds per shimmer pass and its travel. */
  bandPeriod: number;
  bandTravel: number;
  bandOffset: number;
  bandWidth: number;
  glyphs: string;
}

/** Draws the wordmark: glyphs scramble in left to right, then a diagonal shimmer band sweeps across. */
export function drawWordmark(f: Frame, t: number, s: WordmarkSpec): void {
  const band = ((t % s.bandPeriod) / s.bandPeriod) * s.bandTravel - s.bandOffset;
  for (let li = 0; li < s.word.length; li++) {
    const g = FONT[s.word[li]!];
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (g[r]![c] !== '#') continue;
        for (let d = 0; d < 2; d++) {
          const x = s.x + li * s.pitch + c * 2 + d;
          const y = s.y + r;
          const lx = x - s.x;
          const appear = 0.2 + (lx / s.revealSpan) * s.revealScale + hash(x, y, 3) * s.revealJitter;
          if (t < appear - 0.5) continue;
          const rnd = s.glyphs[Math.floor(hash(x, y, Math.floor(t * 14)) * s.glyphs.length)]!;
          if (t < appear || Math.abs(lx - band + (r - 3) * 0.8) < s.bandWidth) put(f, x, y, rnd, 2);
          else put(f, x, y, '█', 0);
        }
      }
  }
}

/**
 * The wordmark drawn solid at `scale`: 1 is full size (two columns and one row per font pixel, as `drawWordmark`
 * settles), 0.5 the small logo (one column and half a row per pixel, drawn with half blocks). `pitch` is the columns
 * between letter origins. In between it samples the font, so the mark can shrink smoothly.
 */
export function drawWordmarkScaled(
  f: Frame,
  word: readonly WordmarkLetter[],
  x: number,
  y: number,
  scale: number,
  pitch: number,
): void {
  const pxW = 2 * scale;
  const pxH = scale;
  const width = (word.length - 1) * pitch + 5 * pxW;
  const on = (u: number, v: number): boolean => {
    const li = Math.floor(u / pitch);
    if (li < 0 || li >= word.length) return false;
    const px = Math.floor((u - li * pitch) / pxW);
    const py = Math.floor(v / pxH);
    return px >= 0 && px < 5 && py >= 0 && py < 7 && FONT[word[li]!][py]![px] === '#';
  };
  for (let cy = Math.floor(y); cy < Math.ceil(y + 7 * pxH); cy++)
    for (let cx = Math.floor(x); cx < Math.ceil(x + width); cx++) {
      const u = cx + 0.5 - x;
      const top = on(u, cy + 0.25 - y);
      const bottom = on(u, cy + 0.75 - y);
      if (top || bottom) put(f, cx, cy, top && bottom ? '█' : top ? '▀' : '▄', 0);
    }
}
