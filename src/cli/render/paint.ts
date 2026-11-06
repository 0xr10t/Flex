// Turns frames into coloured terminal rows. Colours come from the two designs: the splash sits in a warm dark terminal
// window (#1b1918) with a gold accent, the gateway scene on near-black (#0b0c0a) with an amber accent.

import type { Frame } from './frame.js';

export type ColorMode = 'truecolor' | '256' | 'basic' | 'none';

export type Ink = 'fg' | 'dim' | 'accent' | 'chrome' | 'rule';

export interface Palette {
  bg: string;
  fg: string;
  dim: string;
  accent: string;
  /** Title bar text. */
  chrome: string;
  /** Title bar divider. */
  rule: string;
}

/** "Flex Terminal": window #1b1918, text #f3f2f2, dim #7d7979, accent #e1ad66, title #9b9797. */
export const SPLASH_PALETTE: Palette = {
  bg: '#1b1918',
  fg: '#f3f2f2',
  dim: '#7d7979',
  accent: '#e1ad66',
  chrome: '#9b9797',
  // rgba(243,242,242,0.10) over the window background
  rule: '#312f2e',
};

/** "Flex ASCII": page #0b0c0a, text #d9d6cc, dim #5f6159, accent #f2b45a. */
export const SCENE_PALETTE: Palette = {
  bg: '#0b0c0a',
  fg: '#d9d6cc',
  dim: '#5f6159',
  accent: '#f2b45a',
  chrome: '#5f6159',
  rule: '#1d1e1b',
};

/** Accent swatches each design offers. */
export const SPLASH_ACCENTS = ['#e1ad66', '#c28d41', '#facb8d'] as const;
export const SCENE_ACCENTS = ['#f2b45a', '#7fd1b9', '#9aa8ff', '#ff7a6b'] as const;

export interface Run {
  text: string;
  ink: Ink;
}

export type Row = Run[];

const TONE_INK: readonly Ink[] = ['fg', 'dim', 'accent'];
const HEX_RE = /^#([0-9a-fA-F]{6})$/;
const ESC = '\u001b[';

export function isHexColor(s: string): boolean {
  return HEX_RE.test(s);
}

function rgb(hex: string): [number, number, number] {
  const m = HEX_RE.exec(hex);
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 index (6×6×6 cube or the 24-step grey ramp). */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  if (Math.max(r, g, b) - Math.min(r, g, b) < 12) {
    const avg = (r + g + b) / 3;
    if (avg < 8) return 16;
    if (avg > 238) return 231;
    return 232 + Math.round(((avg - 8) / 230) * 23);
  }
  const q = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

const BASIC_FG: Record<Ink, number> = { fg: 97, dim: 90, accent: 33, chrome: 37, rule: 90 };

function fgCode(mode: ColorMode, palette: Palette, ink: Ink): string {
  if (mode === 'none') return '';
  if (mode === 'basic') return `${ESC}${BASIC_FG[ink]}m`;
  if (mode === '256') return `${ESC}38;5;${to256(palette[ink])}m`;
  return `${ESC}38;2;${rgb(palette[ink]).join(';')}m`;
}

function bgCode(mode: ColorMode, palette: Palette): string {
  if (mode === '256') return `${ESC}48;5;${to256(palette.bg)}m`;
  if (mode === 'truecolor') return `${ESC}48;2;${rgb(palette.bg).join(';')}m`;
  return '';
}

/** Splits each frame row into runs of one ink. Spaces keep the current ink, as the designs' painters do. */
export function frameRows(f: Frame): Row[] {
  const rows: Row[] = [];
  for (let y = 0; y < f.rows; y++) {
    const row: Row = [];
    let cur: Run | undefined;
    for (let x = 0; x < f.cols; x++) {
      const i = y * f.cols + x;
      const c = f.ch[i]!;
      const ink = c === ' ' && cur ? cur.ink : TONE_INK[f.tone[i]!]!;
      if (cur && cur.ink === ink) cur.text += c;
      else {
        cur = { text: c, ink };
        row.push(cur);
      }
    }
    rows.push(row);
  }
  return rows;
}

/** Visible width of a row (all glyphs used here are one cell wide). */
export function rowWidth(row: Row): number {
  return row.reduce((n, r) => n + [...r.text].length, 0);
}

/**
 * Paints one row padded to `width` cells; ends with an attribute reset. `background: false` leaves the terminal's own
 * background (for captions outside the panel).
 */
export function paintRow(row: Row, width: number, palette: Palette, mode: ColorMode, background = true): string {
  const pad = Math.max(0, width - rowWidth(row));
  if (mode === 'none') return row.map((r) => r.text).join('') + ' '.repeat(pad);
  let out = background ? bgCode(mode, palette) : '';
  let ink: Ink | undefined;
  for (const r of row) {
    if (r.ink !== ink) {
      out += fgCode(mode, palette, r.ink);
      ink = r.ink;
    }
    out += r.text;
  }
  return out + ' '.repeat(pad) + `${ESC}0m`;
}
