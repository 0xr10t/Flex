// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen; the opening scene
// sits centred on it; after the snap (which takes the FLEX title, globe, gateway and diamond) the splash comes up
// centred above the footer that stays. The layout adapts to the terminal: below 120 × 40 there is no room for the
// opening scene, below 58 × 24 the footer goes too, and a short terminal drops the splash's logo.

import { createFrame, overlay, type Frame } from './frame.js';
import { drawStarfield, renderSceneLayer, SCENE_COLS, SCENE_FOOTER_ROW, SCENE_ROWS } from './scene.js';
import { placeSplash, SPLASH_GROUP_ROWS, SPLASH_TEXT_ROWS, SPLASH_TEXT_WIDTH, type SplashPlacement } from './splash.js';

/** Where a 120×40 scene layer's origin goes on screen. */
export interface Origin {
  x: number;
  y: number;
}

export interface StageLayout {
  cols: number;
  rows: number;
  /** The opening scene's title and objects (what the snap takes); null when the terminal is too small for them. */
  scene: Origin | null;
  /** The block line, which stays; null when there is no room. */
  footer: Origin | null;
  splash: SplashPlacement;
}

/** The footer line plus a column either side. */
const FOOTER_MIN_COLS = 58;
/** Splash with its logo, a gap and the footer. */
const FOOTER_MIN_ROWS = 24;

/** Smallest terminal that shows anything: the splash's text block. */
export const MIN_COLS = SPLASH_TEXT_WIDTH + 2;
export const MIN_ROWS = SPLASH_TEXT_ROWS + 1;

/**
 * The layout for a `cols` × `rows` terminal; null when even the splash's text does not fit. `opening` false lays out
 * the splash alone (no footer or scene).
 */
export function stageLayout(cols: number, rows: number, opening = true): StageLayout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const logo = rows >= SPLASH_GROUP_ROWS;
  const centreX = Math.floor((cols - SCENE_COLS) / 2);

  // the splash centred in the rows above the footer (or in all of them)
  const splashAbove = (footerRow: number): SplashPlacement =>
    placeSplash(cols, Math.floor((footerRow - SPLASH_TEXT_ROWS) / 2), logo);

  if (opening && cols >= SCENE_COLS && rows >= SCENE_ROWS) {
    const o = { x: centreX, y: Math.floor((rows - SCENE_ROWS) / 2) };
    return { cols, rows, scene: o, footer: o, splash: splashAbove(o.y + SCENE_FOOTER_ROW) };
  }
  if (opening && cols >= FOOTER_MIN_COLS && rows >= FOOTER_MIN_ROWS) {
    const footerRow = rows - 2;
    return {
      cols,
      rows,
      scene: null,
      footer: { x: centreX, y: footerRow - SCENE_FOOTER_ROW },
      splash: splashAbove(footerRow),
    };
  }
  return { cols, rows, scene: null, footer: null, splash: splashAbove(rows) };
}

/** Stars and footer: what stays through the snap. */
export function drawBackdrop(f: Frame, t: number, layout: StageLayout, starfield: boolean): void {
  if (starfield) drawStarfield(f, t);
  if (layout.footer) overlay(f, renderSceneLayer(t, 'footer'), layout.footer.x, layout.footer.y);
}

/** The opening's title, globe, gateway and diamond as a full-screen layer, or null when they do not fit. */
export function objectsLayer(t: number, layout: StageLayout): Frame | null {
  if (!layout.scene) return null;
  const f = createFrame(layout.cols, layout.rows);
  overlay(f, renderSceneLayer(t, 'title'), layout.scene.x, layout.scene.y);
  overlay(f, renderSceneLayer(t, 'objects'), layout.scene.x, layout.scene.y);
  return f;
}
