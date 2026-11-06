// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen.
//
// The opening: across the top FLEXX and its tagline (the header); below it the gateway scene's globe, gateway and
// Ethereum diamond, with the footer under them.
//
// After it (the final layout): FLEXX shrinks into a bar along the top, a small cube appearing to its left, and the
// command box fills the screen under the bar, the footer under the box. The smallest terminals show the box alone.
//
// Below 120 × 43 there is no room for the opening's objects, so only the header plays before it shrinks; when even
// the header does not fit, the CLI starts on the final layout.

import { createFrame, overlay, type Frame, type Rect } from './frame.js';
import {
  drawStarfield,
  renderSceneLayer,
  SCENE_COLS,
  SCENE_FOOTER_ROW,
  SCENE_OBJECTS_BOTTOM,
  SCENE_OBJECTS_TOP,
} from './scene.js';
import {
  placeSplash,
  SMALL_PITCH,
  SPLASH_PITCH,
  SPLASH_TEXT_WIDTH,
  SPLASH_WORD,
  type LogoMorph,
  type SplashPlacement,
} from './splash.js';

/** Where a 120×40 scene layer's origin goes on screen. */
export interface Origin {
  x: number;
  y: number;
}

/** The small logo: the small cube, FLEXX at half size beside it, and the tagline after them. */
export interface SmallLogo {
  morph: LogoMorph;
  tagline: { x: number; y: number; lines: string[] } | null;
}

export interface FinalLayout {
  logo: SmallLogo | null;
  box: Rect;
  /** The block line under the box; null when there is no room. */
  footer: Origin | null;
}

export interface StageLayout {
  cols: number;
  rows: number;
  /** The opening's FLEXX and tagline; null when there is no room (the CLI then starts on `final`). */
  header: SplashPlacement | null;
  /** The opening's globe, gateway and diamond; null when the terminal is too small for them. */
  scene: Origin | null;
  /** The opening's block line; null without the objects. */
  footer: Origin | null;
  final: FinalLayout;
}

/** The opening's header: a row of margin, FLEXX (7 rows), its tagline two rows down, the rule two more. */
const HEADER_ROWS = 12;
const HEADER_TEXT_TOP = 1;
/** Header, a gap, the objects (rows 14–35 of the scene), the gap to the footer and the footer. */
const OPENING_ROWS = HEADER_ROWS + 1 + (SCENE_OBJECTS_BOTTOM - SCENE_OBJECTS_TOP + 1) + 2 + 1;

const TAGLINE = 'the access layer between AI and ethereum';
/** The top bar: the small cube on the left, the small FLEXX (five letters of five columns, six apart, four rows of
 * half blocks) beside it, the tagline after that when it fits. */
const SMALL_WORD_WIDTH = (SPLASH_WORD.length - 1) * SMALL_PITCH + 5;
const SMALL_CUBE_SCALE = 0.35;
const CUBE_X = 8;
const CUBE_Y = 3.5;
const WORD_X = 17;
const WORD_Y = 2;
const TAGLINE_X = WORD_X + SMALL_WORD_WIDTH + 4;
/** Rows the bar takes before the box: the small cube reaches about four rows either side of its centre. */
const BAR_ROWS = 8;
const BOX_MIN_ROWS = 6;
const BOX_MIN_COLS = 40;
/** The footer's line plus a column either side. */
const FOOTER_MIN_COLS = 58;

/** Smallest terminal that shows anything: the command box. */
export const MIN_COLS = BOX_MIN_COLS + 2;
export const MIN_ROWS = BOX_MIN_ROWS;

/** The footer centred under a box, on the screen's last row. */
function footerUnder(box: Rect, rows: number): Origin {
  return { x: box.x + Math.floor((box.w - SCENE_COLS) / 2), y: rows - 1 - SCENE_FOOTER_ROW };
}

/** Where everything goes once the opening is over: the bar on top, the box under it, the footer last. */
export function finalLayout(cols: number, rows: number): FinalLayout {
  if (cols < WORD_X + SMALL_WORD_WIDTH + 1 || rows < BAR_ROWS + BOX_MIN_ROWS)
    return { logo: null, box: { x: 0, y: 0, w: cols, h: rows }, footer: null };

  const w = cols - 2;
  const footer = rows >= BAR_ROWS + BOX_MIN_ROWS + 2 && w >= FOOTER_MIN_COLS;
  const box = { x: 1, y: BAR_ROWS, w, h: rows - BAR_ROWS - (footer ? 2 : 0) };
  return {
    logo: {
      morph: {
        cubeX: CUBE_X,
        cubeY: CUBE_Y,
        cubeScale: SMALL_CUBE_SCALE,
        wordX: WORD_X,
        wordY: WORD_Y,
        wordScale: 0.5,
        pitch: SMALL_PITCH,
      },
      tagline: cols - TAGLINE_X - 1 >= TAGLINE.length ? { x: TAGLINE_X, y: WORD_Y + 2, lines: [TAGLINE] } : null,
    },
    box,
    footer: footer ? footerUnder(box, rows) : null,
  };
}

/** The layout for a `cols` × `rows` terminal; null when even the command box does not fit. */
export function stageLayout(cols: number, rows: number): StageLayout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const final = finalLayout(cols, rows);
  const header = (top: number): SplashPlacement => placeSplash(cols, top + HEADER_TEXT_TOP, false);

  if (cols >= SCENE_COLS && rows >= OPENING_ROWS) {
    const top = Math.floor((rows - OPENING_ROWS) / 2);
    // the scene's objects start on the row after the header
    const scene = { x: Math.floor((cols - SCENE_COLS) / 2), y: top + HEADER_ROWS + 1 - SCENE_OBJECTS_TOP };
    return { cols, rows, header: header(top), scene, footer: scene, final };
  }

  // no room for the objects: FLEXX alone plays (centred) before it shrinks, if it fits and has a bar to go to
  const fits = cols >= SPLASH_TEXT_WIDTH + 2 && rows >= HEADER_ROWS && final.logo !== null;
  const top = Math.floor((rows - HEADER_ROWS) / 2);
  return { cols, rows, header: fits ? header(top) : null, scene: null, footer: null, final };
}

/** The opening's full-size logo as a morph, the starting point of the shrink. */
export function headerMorph(h: SplashPlacement): LogoMorph {
  return {
    cubeX: h.objectX,
    cubeY: h.objectY,
    cubeScale: 1,
    wordX: h.textX,
    wordY: h.textY,
    wordScale: 1,
    pitch: SPLASH_PITCH,
  };
}

/** Share of the shrink each part uses: the cube flies to the corner first, FLEXX follows once it is out of the way. */
const CUBE_SPAN = [0, 0.6] as const;
const WORD_SPAN = [0.4, 1] as const;
/** A cube that only exists at the end grows in as FLEXX settles beside it. */
const CUBE_GROW_SPAN = [0.5, 1] as const;

const ease = (p: number, [from, to]: readonly [number, number]): number => {
  const q = Math.min(1, Math.max(0, (p - from) / (to - from)));
  return q * q * (3 - 2 * q);
};

/** Eased blend of two logo morphs at `p` in [0, 1]. A cube missing at one end grows or shrinks in place. */
export function blendMorph(a: LogoMorph, b: LogoMorph, p: number): LogoMorph {
  const ec = ease(p, a.cubeX === null ? CUBE_GROW_SPAN : CUBE_SPAN);
  const ew = ease(p, WORD_SPAN);
  const cubeMix = (x: number, y: number): number => x + (y - x) * ec;
  const wordMix = (x: number, y: number): number => x + (y - x) * ew;
  const ax = a.cubeX ?? b.cubeX;
  const bx = b.cubeX ?? a.cubeX;
  const ay = a.cubeX === null ? b.cubeY : a.cubeY;
  const by = b.cubeX === null ? a.cubeY : b.cubeY;
  return {
    cubeX: ax === null || bx === null ? null : cubeMix(ax, bx),
    cubeY: cubeMix(ay, by),
    cubeScale: cubeMix(a.cubeX === null ? 0 : a.cubeScale, b.cubeX === null ? 0 : b.cubeScale),
    wordX: wordMix(a.wordX, b.wordX),
    wordY: wordMix(a.wordY, b.wordY),
    wordScale: wordMix(a.wordScale, b.wordScale),
    pitch: wordMix(a.pitch, b.pitch),
  };
}

/** Stars and, when given, the footer at `footer`. */
export function drawBackdrop(f: Frame, t: number, footer: Origin | null, starfield: boolean): void {
  if (starfield) drawStarfield(f, t);
  if (footer) overlay(f, renderSceneLayer(t, 'footer'), Math.round(footer.x), Math.round(footer.y));
}

/** The opening's globe, gateway and diamond as a full-screen layer, or null when they do not fit. */
export function objectsLayer(t: number, layout: StageLayout): Frame | null {
  if (!layout.scene) return null;
  const f = createFrame(layout.cols, layout.rows);
  overlay(f, renderSceneLayer(t, 'objects'), layout.scene.x, layout.scene.y);
  return f;
}
