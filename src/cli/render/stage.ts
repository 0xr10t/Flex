// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen.
//
// The opening: across the top the steerable cube beside FLEXX and its tagline (the header); below it the gateway
// scene's globe, gateway and Ethereum diamond, with the footer under them.
//
// After it (the final layout): the cube and FLEXX shrink into a small logo on the left and the command box runs from
// the top of the screen down the rest of it, the footer under the box. A narrower terminal puts the small FLEXX in a
// bar above the box instead; the smallest shows the box alone.
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
  SPLASH_GROUP_WIDTH,
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

/** The small logo: cube and FLEXX at half size, and the tagline under (or beside) them. */
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
  /** The opening's cube, FLEXX and tagline; null when there is no room (the CLI then starts on `final`). */
  header: SplashPlacement | null;
  /** The opening's globe, gateway and diamond; null when the terminal is too small for them. */
  scene: Origin | null;
  /** The opening's block line; null without the objects. */
  footer: Origin | null;
  final: FinalLayout;
}

/** Header rows with the cube (it reaches eight rows either side of its centre) and with the text alone. */
const HEADER_ROWS = 17;
const HEADER_TEXT_ROWS = 12;
/** The header's text block starts this far below its top, with and without the cube. */
const HEADER_TEXT_TOP = 3;
const HEADER_TEXT_ONLY_TOP = 1;
/** Header, a gap, the objects (rows 14–35 of the scene), the gap to the footer and the footer. */
const OPENING_ROWS = HEADER_ROWS + 1 + (SCENE_OBJECTS_BOTTOM - SCENE_OBJECTS_TOP + 1) + 2 + 1;

const TAGLINE = 'the access layer between AI and ethereum';
/** The small FLEXX: five letters of five columns, six apart, in four rows of half blocks. */
const SMALL_WORD_WIDTH = (SPLASH_WORD.length - 1) * SMALL_PITCH + 5;
const SMALL_WORD_ROWS = 4;
/** The sidebar: two columns of margin, the small logo, three columns of gap before the box. */
const SIDEBAR_X = 2;
const SIDEBAR_COLS = SIDEBAR_X + SMALL_WORD_WIDTH + 3;
/** Small cube, a gap, small FLEXX, a gap, two tagline rows. */
const SIDEBAR_ROWS = 10 + 1 + SMALL_WORD_ROWS + 1 + 2;
const BOX_MIN_ROWS = 6;
const BOX_MIN_COLS = 40;
/** The footer's line plus a column either side. */
const FOOTER_MIN_COLS = 58;

/** Smallest terminal that shows anything: the command box. */
export const MIN_COLS = BOX_MIN_COLS + 2;
export const MIN_ROWS = BOX_MIN_ROWS;

/** Word-wraps `s` to lines of at most `width` columns. */
function wrapWords(s: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of s.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= width) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
}

/** The footer centred under a box, on the screen's last row. */
function footerUnder(box: Rect, rows: number): Origin {
  return { x: box.x + Math.floor((box.w - SCENE_COLS) / 2), y: rows - 1 - SCENE_FOOTER_ROW };
}

/** Where everything goes once the opening is over. */
export function finalLayout(cols: number, rows: number): FinalLayout {
  const footerRoom = rows >= BOX_MIN_ROWS + 2;

  if (cols >= SIDEBAR_COLS + BOX_MIN_COLS && rows >= SIDEBAR_ROWS) {
    const w = cols - SIDEBAR_COLS - 1;
    const footer = footerRoom && w >= FOOTER_MIN_COLS;
    const box = { x: SIDEBAR_COLS, y: 0, w, h: footer ? rows - 2 : rows };
    const wordY = 11;
    return {
      logo: {
        morph: {
          cubeX: SIDEBAR_X + Math.floor(SMALL_WORD_WIDTH / 2),
          cubeY: 5,
          cubeScale: 0.5,
          wordX: SIDEBAR_X,
          wordY,
          wordScale: 0.5,
          pitch: SMALL_PITCH,
        },
        tagline: { x: SIDEBAR_X, y: wordY + SMALL_WORD_ROWS + 1, lines: wrapWords(TAGLINE, SMALL_WORD_WIDTH) },
      },
      box,
      footer: footer ? footerUnder(box, rows) : null,
    };
  }

  if (rows >= SMALL_WORD_ROWS + 1 + BOX_MIN_ROWS) {
    const tagX = 1 + SMALL_WORD_WIDTH + 3;
    return {
      logo: {
        morph: { cubeX: null, cubeY: 0, cubeScale: 0, wordX: 1, wordY: 0, wordScale: 0.5, pitch: SMALL_PITCH },
        tagline: cols - tagX >= TAGLINE.length ? { x: tagX, y: 1, lines: [TAGLINE] } : null,
      },
      box: { x: 0, y: SMALL_WORD_ROWS + 1, w: cols, h: rows - SMALL_WORD_ROWS - 1 },
      footer: null,
    };
  }

  return { logo: null, box: { x: 0, y: 0, w: cols, h: rows }, footer: null };
}

/** The layout for a `cols` × `rows` terminal; null when even the command box does not fit. */
export function stageLayout(cols: number, rows: number): StageLayout | null {
  if (cols < MIN_COLS || rows < MIN_ROWS) return null;
  const final = finalLayout(cols, rows);

  if (cols >= SCENE_COLS && rows >= OPENING_ROWS) {
    const top = Math.floor((rows - OPENING_ROWS) / 2);
    // the scene's objects start on the row after the header
    const scene = { x: Math.floor((cols - SCENE_COLS) / 2), y: top + HEADER_ROWS + 1 - SCENE_OBJECTS_TOP };
    return { cols, rows, header: placeSplash(cols, top + HEADER_TEXT_TOP, true), scene, footer: scene, final };
  }

  // no room for the objects: the header alone plays (centred) before it shrinks, if it fits and has a logo to become
  const cube = cols >= SPLASH_GROUP_WIDTH && rows >= HEADER_ROWS;
  const headerRows = cube ? HEADER_ROWS : HEADER_TEXT_ROWS;
  const textTop = Math.floor((rows - headerRows) / 2) + (cube ? HEADER_TEXT_TOP : HEADER_TEXT_ONLY_TOP);
  const fits = cols >= SPLASH_TEXT_WIDTH + 2 && rows >= headerRows && final.logo !== null;
  return { cols, rows, header: fits ? placeSplash(cols, textTop, cube) : null, scene: null, footer: null, final };
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

const ease = (p: number, [from, to]: readonly [number, number]): number => {
  const q = Math.min(1, Math.max(0, (p - from) / (to - from)));
  return q * q * (3 - 2 * q);
};

/** Eased blend of two logo morphs at `p` in [0, 1]. A cube missing at one end grows or shrinks in place. */
export function blendMorph(a: LogoMorph, b: LogoMorph, p: number): LogoMorph {
  const ec = ease(p, CUBE_SPAN);
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
