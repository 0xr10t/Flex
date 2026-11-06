// Frames the rendered art the way the designs present it: the splash inside a terminal window with a title bar
// ("flex — splash" · its size), the scene on its own dark field, both centred. Falls back to the bare frame when the
// window chrome does not fit.

import type { Frame } from './frame.js';
import { frameRows, type Row } from './paint.js';
import { SPLASH_COLS, SPLASH_ROWS } from './splash.js';
import { SCENE_COLS, SCENE_ROWS } from './scene.js';

export type View = 'splash' | 'scene';

export interface Panel {
  rows: Row[];
  width: number;
}

/** Where a panel goes on screen (1-based terminal cells). */
export interface Placement {
  left: number;
  top: number;
  width: number;
  height: number;
  chrome: boolean;
}

const PAD_X = 2;

const SIZE: Record<View, { cols: number; rows: number; chromeCols: number; chromeRows: number }> = {
  // title bar + divider + padding row above and below the frame
  splash: { cols: SPLASH_COLS, rows: SPLASH_ROWS, chromeCols: SPLASH_COLS + 2 * PAD_X, chromeRows: SPLASH_ROWS + 4 },
  // padding row above and below
  scene: { cols: SCENE_COLS, rows: SCENE_ROWS, chromeCols: SCENE_COLS + 2 * PAD_X, chromeRows: SCENE_ROWS + 2 },
};

/** Smallest terminal that shows the view at all. */
export function minimumSize(view: View): { cols: number; rows: number } {
  return { cols: SIZE[view].cols, rows: SIZE[view].rows };
}

/** Centres the view in a `cols`×`rows` terminal; null when even the bare frame does not fit. */
export function place(view: View, cols: number, rows: number): Placement | null {
  const s = SIZE[view];
  const chrome = cols >= s.chromeCols && rows >= s.chromeRows;
  const width = chrome ? s.chromeCols : s.cols;
  const height = chrome ? s.chromeRows : s.rows;
  if (cols < width || rows < height) return null;
  return {
    left: Math.floor((cols - width) / 2) + 1,
    top: Math.floor((rows - height) / 2) + 1,
    width,
    height,
    chrome,
  };
}

function pad(row: Row): Row {
  return [{ text: ' '.repeat(PAD_X), ink: 'fg' }, ...row, { text: ' '.repeat(PAD_X), ink: 'fg' }];
}

/** The panel rows for a rendered frame. */
export function panel(view: View, frame: Frame, chrome: boolean): Panel {
  const body = frameRows(frame);
  if (!chrome) return { rows: body, width: frame.cols };
  const width = frame.cols + 2 * PAD_X;
  const blank: Row = [{ text: ' '.repeat(width), ink: 'fg' }];
  if (view === 'scene') return { rows: [blank, ...body.map(pad), blank], width };

  const title = 'flex — splash';
  const size = `${frame.cols} × ${frame.rows}`;
  const header: Row = pad([
    { text: title, ink: 'chrome' },
    { text: ' '.repeat(frame.cols - title.length - size.length), ink: 'chrome' },
    { text: size, ink: 'accent' },
  ]);
  const rule: Row = [{ text: '─'.repeat(width), ink: 'rule' }];
  return { rows: [header, rule, blank, ...body.map(pad), blank], width };
}
