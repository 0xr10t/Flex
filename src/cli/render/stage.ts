// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen. Across the top sits
// the header: the steerable cube beside FLEXX and its tagline, which never moves. Below it the opening shows the
// gateway scene's globe, gateway and Ethereum diamond, with the footer under them; after the snap the command box
// takes their place. The layout follows the terminal's size: below 120 × 43 there is no opening, a narrow or short
// terminal drops the cube, then the header, leaving the command box alone.

import { createFrame, overlay, type Frame, type Rect } from './frame.js';
import {
  drawStarfield,
  renderSceneLayer,
  SCENE_COLS,
  SCENE_FOOTER_ROW,
  SCENE_OBJECTS_BOTTOM,
  SCENE_OBJECTS_TOP,
} from './scene.js';
import { placeSplash, SPLASH_GROUP_WIDTH, SPLASH_TEXT_WIDTH, type SplashPlacement } from './splash.js';

/** Where a 120×40 scene layer's origin goes on screen. */
export interface Origin {
  x: number;
  y: number;
}

export interface StageLayout {
  cols: number;
  rows: number;
  /** Cube, FLEXX and tagline; null when there is no room. */
  header: SplashPlacement | null;
  /** The opening's globe, gateway and diamond; null when the terminal is too small for them. */
  scene: Origin | null;
  /** The block line under the opening; null without the opening. */
  footer: Origin | null;
  /** The command box. */
  box: Rect;
}

/** Header rows with the cube (it reaches eight rows either side of its centre) and with the text alone. */
const HEADER_ROWS = 17;
const HEADER_TEXT_ROWS = 12;
/** The header's text block starts this far below its top, with and without the cube. */
const HEADER_TEXT_TOP = 3;
const HEADER_TEXT_ONLY_TOP = 1;
/** Header, a gap, the objects (rows 14–35 of the scene), the gap to the footer and the footer. */
const OPENING_ROWS = HEADER_ROWS + 1 + (SCENE_OBJECTS_BOTTOM - SCENE_OBJECTS_TOP + 1) + 2 + 1;
const BOX_MIN_ROWS = 6;
const BOX_MIN_COLS = 40;
const BOX_MAX_COLS = 100;

/** Smallest terminal that shows anything: the command box. */
export const MIN_COLS = BOX_MIN_COLS + 2;
export const MIN_ROWS = BOX_MIN_ROWS;

/** The layout for a `cols` × `rows` terminal; null when even the command box does not fit. */
export function stageLayout(cols: number, rows: number): StageLayout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const boxW = Math.min(BOX_MAX_COLS, cols - 4);
  const boxX = Math.floor((cols - boxW) / 2);

  if (cols >= SCENE_COLS && rows >= OPENING_ROWS) {
    const top = Math.floor((rows - OPENING_ROWS) / 2);
    // the scene's objects start on the row after the header
    const scene = { x: Math.floor((cols - SCENE_COLS) / 2), y: top + HEADER_ROWS + 1 - SCENE_OBJECTS_TOP };
    const footerRow = scene.y + SCENE_FOOTER_ROW;
    return {
      cols,
      rows,
      header: placeSplash(cols, top + HEADER_TEXT_TOP, true),
      scene,
      footer: scene,
      box: { x: boxX, y: top + HEADER_ROWS + 1, w: boxW, h: footerRow - 1 - (top + HEADER_ROWS + 1) },
    };
  }

  const cube = cols >= SPLASH_GROUP_WIDTH && rows >= HEADER_ROWS + BOX_MIN_ROWS;
  const headerRows = cube ? HEADER_ROWS : HEADER_TEXT_ROWS;
  if (cols >= SPLASH_TEXT_WIDTH + 2 && rows >= headerRows + BOX_MIN_ROWS) {
    return {
      cols,
      rows,
      header: placeSplash(cols, cube ? HEADER_TEXT_TOP : HEADER_TEXT_ONLY_TOP, cube),
      scene: null,
      footer: null,
      box: { x: boxX, y: headerRows, w: boxW, h: rows - headerRows - 1 },
    };
  }
  return { cols, rows, header: null, scene: null, footer: null, box: { x: boxX, y: 0, w: boxW, h: rows } };
}

/** Stars and footer: the backdrop behind everything else. */
export function drawBackdrop(f: Frame, t: number, layout: StageLayout, starfield: boolean): void {
  if (starfield) drawStarfield(f, t);
  if (layout.footer) overlay(f, renderSceneLayer(t, 'footer'), layout.footer.x, layout.footer.y);
}

/** The opening's globe, gateway and diamond as a full-screen layer, or null when they do not fit. */
export function objectsLayer(t: number, layout: StageLayout): Frame | null {
  if (!layout.scene) return null;
  const f = createFrame(layout.cols, layout.rows);
  overlay(f, renderSceneLayer(t, 'objects'), layout.scene.x, layout.scene.y);
  return f;
}
