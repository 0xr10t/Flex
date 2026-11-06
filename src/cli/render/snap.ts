// The "snap": the opening scene disintegrates into dust before the splash comes up. Each cell holds on for a moment,
// dims, then breaks off as a particle that drifts right and upward on the wind while it crumbles through finer glyphs
// and fades out. The dark backdrop flakes away cell by cell behind it. The right side goes first, so the dust blows
// off the edge rather than across what is still standing. A pure function of the source frame and elapsed time.

import { createFrame, hash, type Frame, type Tone } from './frame.js';

/** Glyphs a particle crumbles through, coarse to fine. */
const DUST = '%#*+=-:.';
/** Latest a cell starts to go: base jitter plus the right-to-left sweep. */
const MAX_START = 0.1 + 0.9 + 0.7;
/** Longest a particle lives. */
const MAX_LIFE = 0.55 + 0.5;
/** How long a cell dims before it breaks off. */
const CRACK = 0.18;
/** How long after a cell breaks off its backdrop goes. */
const BACKDROP_LAG = 0.2;

/** Seconds from the snap to the last speck of dust. */
export const SNAP_SECONDS = MAX_START + Math.max(MAX_LIFE, BACKDROP_LAG);

/** When the cell at (x, y) breaks off, in seconds after the snap. */
function breakAt(x: number, y: number, cols: number): number {
  return 0.1 + hash(x, y, 11) * 0.9 + (1 - x / Math.max(1, cols - 1)) * 0.7;
}

/** `src` disintegrating, `s` seconds after the snap. The returned frame marks its vanished backdrop as clear. */
export function snap(src: Frame, s: number): Frame {
  const f = createFrame(src.cols, src.rows);
  const clear = new Uint8Array(src.cols * src.rows);
  const standing = new Uint8Array(src.cols * src.rows);
  const dust: { i: number; x: number; y: number; age: number; life: number }[] = [];

  for (let y = 0; y < src.rows; y++)
    for (let x = 0; x < src.cols; x++) {
      const i = y * src.cols + x;
      const at = breakAt(x, y, src.cols);
      const age = s - at;
      if (age > BACKDROP_LAG) clear[i] = 1;
      const c = src.ch[i]!;
      if (c === ' ') continue;
      if (age < 0) {
        f.ch[i] = c;
        f.tone[i] = age > -CRACK ? 1 : (src.tone[i]! as Tone);
        standing[i] = 1;
        continue;
      }
      const life = 0.55 + hash(x, y, 13) * 0.5;
      if (age < life) dust.push({ i, x, y, age, life });
    }

  for (const p of dust) {
    const vx = 10 + hash(p.x, p.y, 17) * 18;
    const vy = 1.5 + hash(p.x, p.y, 19) * 4;
    const wobble = Math.sin(p.age * 7 + hash(p.x, p.y, 23) * 6.28) * 0.6;
    const X = Math.round(p.x + vx * p.age + wobble);
    const Y = Math.round(p.y - vy * p.age);
    if (X < 0 || Y < 0 || X >= f.cols || Y >= f.rows) continue;
    const j = Y * f.cols + X;
    // dust never paints over what is still standing
    if (standing[j]) continue;
    const progress = p.age / p.life;
    f.ch[j] = DUST[Math.min(DUST.length - 1, Math.floor(progress * DUST.length))]!;
    f.tone[j] = progress < 0.25 ? 0 : 1;
  }
  return { ...f, clear };
}
