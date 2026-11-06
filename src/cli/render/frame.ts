// Character grid shared by the CLI's ASCII renderers. A frame holds one glyph and one tone per cell; painters turn the
// tones into colours. Ported from the Claude Design handoff "Flex animated ASCII art" (Flex ASCII / Flex Terminal).

/** 0 = foreground, 1 = dim, 2 = accent. */
export type Tone = 0 | 1 | 2;

export interface Frame {
  readonly cols: number;
  readonly rows: number;
  readonly ch: string[];
  readonly tone: Uint8Array;
}

export type Vec3 = readonly [number, number, number];

export function createFrame(cols: number, rows: number): Frame {
  return { cols, rows, ch: new Array<string>(cols * rows).fill(' '), tone: new Uint8Array(cols * rows) };
}

/** Writes one glyph at the rounded cell position; positions outside the grid are ignored. */
export function put(f: Frame, x: number, y: number, c: string, k: Tone = 0): void {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= f.cols || y >= f.rows) return;
  f.ch[y * f.cols + x] = c;
  f.tone[y * f.cols + x] = k;
}

export function text(f: Frame, x: number, y: number, s: string, k: Tone = 0): void {
  for (let i = 0; i < s.length; i++) put(f, x + i, y, s[i]!, k);
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
