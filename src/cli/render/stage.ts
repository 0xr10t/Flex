// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen; the opening scene
// sits centred on it; after the snap the splash takes the space the globe, gateway and diamond leave, under the FLEX
// title. The layout adapts to the terminal: below 120 × 40 there is no room for the opening scene, below 58 × 30 the
// title and footer go too, and a short terminal drops the splash's logo.

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
  /** The opening scene's objects; null when the terminal is too small for them. */
  scene: Origin | null;
  /** The FLEX title and tagline; null when there is no room. */
  title: Origin | null;
  /** The block line; null when there is no room. */
  footer: Origin | null;
  splash: SplashPlacement;
}

/** The title layer's widest line (the tagline) plus a column either side. */
const TITLE_MIN_COLS = 58;
/** Title (wordmark, gap, tagline), gap, splash with its logo, gap, footer. */
const COMPACT_ROWS = 30;

/** Smallest terminal that shows anything: the splash's text block. */
export const MIN_COLS = SPLASH_TEXT_WIDTH + 2;
export const MIN_ROWS = SPLASH_TEXT_ROWS + 1;

/**
 * The layout for a `cols` × `rows` terminal; null when even the splash's text does not fit. `opening` false lays out
 * the splash alone (no title, footer or scene).
 */
export function stageLayout(cols: number, rows: number, opening = true): StageLayout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const logo = rows >= SPLASH_GROUP_ROWS;
  const centreX = Math.floor((cols - SCENE_COLS) / 2);

  if (opening && cols >= SCENE_COLS && rows >= SCENE_ROWS) {
    const o = { x: centreX, y: Math.floor((rows - SCENE_ROWS) / 2) };
    // the splash text centred between the tagline (row 10) and the footer (row 38)
    return { cols, rows, scene: o, title: o, footer: o, splash: placeSplash(cols, o.y + 18, logo) };
  }
  if (opening && cols >= TITLE_MIN_COLS && rows >= COMPACT_ROWS) {
    const top = Math.floor((rows - COMPACT_ROWS) / 2);
    return {
      cols,
      rows,
      scene: null,
      // the title layer's wordmark starts on its row 2
      title: { x: centreX, y: top - 2 },
      footer: { x: centreX, y: top + COMPACT_ROWS - 1 - SCENE_FOOTER_ROW },
      splash: placeSplash(cols, top + 13, logo),
    };
  }
  return {
    cols,
    rows,
    scene: null,
    title: null,
    footer: null,
    splash: placeSplash(cols, Math.floor((rows - SPLASH_TEXT_ROWS) / 2), logo),
  };
}

/** Stars, title and footer: everything that stays through the snap. */
export function drawBackdrop(f: Frame, t: number, layout: StageLayout, starfield: boolean): void {
  if (starfield) drawStarfield(f, t);
  if (layout.title) overlay(f, renderSceneLayer(t, 'title'), layout.title.x, layout.title.y);
  if (layout.footer) overlay(f, renderSceneLayer(t, 'footer'), layout.footer.x, layout.footer.y);
}

/** The opening's globe, gateway and diamond as a full-screen layer, or null when they do not fit. */
export function objectsLayer(t: number, layout: StageLayout): Frame | null {
  if (!layout.scene) return null;
  const f = createFrame(layout.cols, layout.rows);
  overlay(f, renderSceneLayer(t, 'objects'), layout.scene.x, layout.scene.y);
  return f;
}
