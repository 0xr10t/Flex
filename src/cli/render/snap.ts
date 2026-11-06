// The "snap": the opening scene's globe, gateway and Ethereum diamond disintegrate into dust while the title and the
// stars stay. Each drawn cell holds on for a moment, dims, then breaks off as a particle that drifts right and upward
// on the wind while it crumbles through finer glyphs and fades out; whatever it was covering (stars) shows through
// again. The right side goes first, so the dust blows off the edge rather than across what is still standing. A pure
// function of the source layer and elapsed time.

import { createFrame, hash, setCell, type Frame, type Tone } from './frame.js';

/** Glyphs a particle crumbles through, coarse to fine. */
const DUST = '%#*+=-:.';
/** Latest a cell starts to go: base jitter plus the right-to-left sweep. */
const MAX_START = 0.1 + 0.9 + 0.7;
/** Longest a particle lives. */
const MAX_LIFE = 0.55 + 0.5;
/** How long a cell dims before it breaks off. */
const CRACK = 0.18;

/** Seconds from the snap to the last speck of dust. */
export const SNAP_SECONDS = MAX_START + MAX_LIFE;

/** When the cell at (x, y) breaks off, in seconds after the snap; `from`..`to` is the span the sweep crosses. */
function breakAt(x: number, y: number, from: number, to: number): number {
  const across = to > from ? (x - from) / (to - from) : 0;
  return 0.1 + hash(x, y, 11) * 0.9 + (1 - across) * 0.7;
}

/**
 * `layer` disintegrating, `s` seconds after the snap. Only the layer's own cells take part; the result is a layer too,
 * to overlay on whatever stays.
 */
export function snap(layer: Frame, s: number): Frame {
  const f = createFrame(layer.cols, layer.rows);
  let from = layer.cols;
  let to = 0;
  for (let i = 0; i < layer.written.length; i++)
    if (layer.written[i]) {
      const x = i % layer.cols;
      from = Math.min(from, x);
      to = Math.max(to, x);
    }

  const standing = new Uint8Array(layer.written.length);
  const dust: { x: number; y: number; age: number; life: number }[] = [];
  for (let y = 0; y < layer.rows; y++)
    for (let x = 0; x < layer.cols; x++) {
      const i = y * layer.cols + x;
      if (!layer.written[i]) continue;
      const age = s - breakAt(x, y, from, to);
      if (age < 0) {
        setCell(f, i, layer.ch[i]!, age > -CRACK ? 1 : (layer.tone[i]! as Tone));
        if (layer.ch[i] !== ' ') standing[i] = 1;
        continue;
      }
      // a blank cell (a dark patch of the globe) simply goes; only glyphs leave dust
      if (layer.ch[i] === ' ') continue;
      const life = 0.55 + hash(x, y, 13) * 0.5;
      if (age < life) dust.push({ x, y, age, life });
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
    setCell(f, j, DUST[Math.min(DUST.length - 1, Math.floor(progress * DUST.length))]!, progress < 0.25 ? 0 : 1);
  }
  return f;
}
