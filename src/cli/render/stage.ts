// Lays the CLI out over the whole terminal. The dark background and the starfield fill the screen.
//
// The opening: across the top FLEXX and its tagline (the header); below it the gateway scene's globe, gateway and
// Ethereum diamond, with the footer under them.
//
// After it (the final layout): FLEXX shrinks onto the top edge of the box, a small cube growing in to its left and
// the tagline under it; the conversation fills the box below them and the input line sits under the box between two
// rules, the footer last. Small terminals leave the logo out.
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

/** The small logo: the small cube, FLEXX at half size beside it, and the tagline under FLEXX. */
export interface SmallLogo {
  morph: LogoMorph;
  tagline: { x: number; y: number; text: string } | null;
}

export interface FinalLayout {
  /** The bordered box: the small logo sits on its top edge, the conversation inside under it. */
  frame: Rect;
  /** Columns of the top edge left open where the logo sits on it; null without the logo. */
  gap: { from: number; to: number } | null;
  logo: SmallLogo | null;
  conversation: Rect;
  /** The input line, between a rule on the row above and one on the row below. */
  input: { x: number; y: number; w: number };
  /** The block line on the last row; null when there is no room. */
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
/** Inside the box's top: the small cube, the small FLEXX (five letters of five columns, six apart, four rows of half
 * blocks) to its right, the tagline under FLEXX; offsets from the box's left edge and the screen's top. */
const SMALL_WORD_WIDTH = (SPLASH_WORD.length - 1) * SMALL_PITCH + 5;
const SMALL_CUBE_SCALE = 0.35;
const CUBE_DX = 8;
/** The box's top edge runs through the logo's middle row. */
const CUBE_Y = 3;
const WORD_DX = 17;
const WORD_Y = 1;
const TAGLINE_Y = WORD_Y + 5;
/** The conversation starts under the logo, or right under the border without it. */
const CONVERSATION_Y = TAGLINE_Y + 2;
const CONVERSATION_MIN_ROWS = 3;
const BOX_MIN_COLS = 40;
/** The footer's line plus a column either side. */
const FOOTER_MIN_COLS = 58;
const FOOTER_MIN_ROWS = 20;

/** Smallest terminal that shows anything: a box with a few rows of conversation, and the input under it. */
export const MIN_COLS = BOX_MIN_COLS + 2;
export const MIN_ROWS = 2 + CONVERSATION_MIN_ROWS + 1 + 3;

/** Where everything goes once the opening is over: the box from the top (logo, then conversation), the input line
 * between two rules under it, the footer last. */
export function finalLayout(cols: number, rows: number): FinalLayout {
  const footer = rows >= FOOTER_MIN_ROWS && cols >= FOOTER_MIN_COLS;
  const lowerRule = footer ? rows - 2 : rows - 1;
  const inputY = lowerRule - 1;
  // a blank row between the box and the input's upper rule
  const frameBottom = inputY - 3;
  const w = cols - 2;
  const withLogo = w >= WORD_DX + SMALL_WORD_WIDTH + 2 && frameBottom - CONVERSATION_Y >= CONVERSATION_MIN_ROWS;
  const frameTop = withLogo ? CUBE_Y : 0;
  const frame = { x: 1, y: frameTop, w, h: frameBottom - frameTop + 1 };
  const top = withLogo ? CONVERSATION_Y : 1;
  const tagFits = frame.w - 1 - WORD_DX >= TAGLINE.length;
  return {
    frame,
    gap: withLogo ? { from: frame.x + 2, to: frame.x + WORD_DX + SMALL_WORD_WIDTH + 1 } : null,
    logo: withLogo
      ? {
          morph: {
            cubeX: frame.x + CUBE_DX,
            cubeY: CUBE_Y,
            cubeScale: SMALL_CUBE_SCALE,
            wordX: frame.x + WORD_DX,
            wordY: WORD_Y,
            wordScale: 0.5,
            pitch: SMALL_PITCH,
          },
          tagline: tagFits ? { x: frame.x + WORD_DX, y: TAGLINE_Y, text: TAGLINE } : null,
        }
      : null,
    conversation: { x: frame.x + 2, y: top, w: frame.w - 4, h: frameBottom - top },
    input: { x: frame.x, y: inputY, w: frame.w },
    footer: footer ? { x: Math.floor((cols - SCENE_COLS) / 2), y: rows - 1 - SCENE_FOOTER_ROW } : null,
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
