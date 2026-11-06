// Implements: §10.4 bridges (`j`) — short/surplus per chain, deliverable = floor(surplus × 100 / (100 + b)),
// x = min(remaining, deliverable), padded = ceil(x × (100 + b) / 100) in base units; INSUFFICIENT_FUNDS when no
// source or x = 0. Pure: S9 mints the DB1 `bridge_padded` rows. §10.5 rule 2 ordering helper.

import { mulDivCeil, mulDivFloor, toBaseUnits, fractionDigits } from '../contracts/money.js';
import type { ChainId, Token } from '../contracts/types.js';

export interface PlannedBridge {
  token: Token;
  source: ChainId;
  dest: ChainId;
  /** Amount moved (base units), DB1 `bridge_padded`. */
  padded: bigint;
  /** x: what this bridge must deliver (PlanJ.deliverable_base_units, SQ-17). */
  deliverable: bigint;
}

/** (100 + b) / 100 as an exact fraction, for a decimal-string percentage b. */
export function bufferFraction(bufferPct: string): { num: bigint; den: bigint } {
  const fd = fractionDigits(bufferPct);
  const scale = 10n ** BigInt(fd);
  const b = toBaseUnits(bufferPct, fd);
  return { num: 100n * scale + b, den: 100n * scale };
}

/**
 * R4-F4: the total that would have to exist for `need`: Σ need plus, for every chain short of its need, the padding a
 * bridge delivering that shortfall adds (ceil(short × (100 + b) / 100) − short). INSUFFICIENT_FUNDS shows it as {need},
 * so the message never reads "you need 100, and can use 101" when only the padding is missing.
 */
export function neededWithPadding(
  chains: ChainId[],
  spendable: Map<ChainId, bigint>,
  need: Map<ChainId, bigint>,
  bufferPct: string,
): bigint {
  const { num, den } = bufferFraction(bufferPct);
  let total = chains.reduce((sum, c) => sum + (need.get(c) ?? 0n), 0n);
  const surplus = new Map(chains.map((c) => [c, (spendable.get(c) ?? 0n) - (need.get(c) ?? 0n)]));
  const short = chains
    .filter((c) => (surplus.get(c) ?? 0n) < 0n)
    .sort((a, b) => {
      const x = surplus.get(a) ?? 0n;
      const y = surplus.get(b) ?? 0n;
      return x === y ? chains.indexOf(a) - chains.indexOf(b) : x < y ? -1 : 1;
    });
  for (const dest of short) {
    let remaining = -(surplus.get(dest) ?? 0n);
    while (remaining > 0n) {
      const donors = chains
        .filter((c) => c !== dest && (surplus.get(c) ?? 0n) > 0n && mulDivFloor(surplus.get(c) ?? 0n, den, num) > 0n)
        .sort((a, b) => {
          const x = surplus.get(a) ?? 0n;
          const y = surplus.get(b) ?? 0n;
          return x === y ? chains.indexOf(a) - chains.indexOf(b) : x > y ? -1 : 1;
        });
      const source = donors[0];
      const available = source === undefined ? 0n : (surplus.get(source) ?? 0n);
      const deliverable = mulDivFloor(available, den, num);
      // The final source would need to supply the rest. Round that actual bridge, instead of pooling
      // all sources' buffers or adding another synthetic bridge for the missing few base units.
      const x = donors.length <= 1 || remaining < deliverable ? remaining : deliverable;
      const padded = mulDivCeil(x, num, den);
      total += padded - x;
      if (source !== undefined) surplus.set(source, available > padded ? available - padded : 0n);
      remaining -= x;
    }
  }
  return total;
}

/**
 * §10.4 for one token. `spendable` and `need` are per chain (only `ok` allowed chains, in allowed order).
 * Returns the bridges in emission order, or null for INSUFFICIENT_FUNDS.
 */
export function planBridges(
  token: Token,
  chains: ChainId[],
  spendable: Map<ChainId, bigint>,
  need: Map<ChainId, bigint>,
  bufferPct: string,
): PlannedBridge[] | null {
  const { num, den } = bufferFraction(bufferPct);
  const short = new Map<ChainId, bigint>();
  const surplus = new Map<ChainId, bigint>();
  for (const c of chains) {
    const d = (need.get(c) ?? 0n) - (spendable.get(c) ?? 0n);
    if (d > 0n) short.set(c, d);
    else if (d < 0n) surplus.set(c, -d);
  }
  const order = [...short.keys()].sort((a, b) => {
    const sa = short.get(a) ?? 0n;
    const sb = short.get(b) ?? 0n;
    if (sa !== sb) return sa > sb ? -1 : 1;
    return chains.indexOf(a) - chains.indexOf(b);
  });
  const out: PlannedBridge[] = [];
  for (const c of order) {
    let remaining = short.get(c) ?? 0n;
    while (remaining > 0n) {
      let s: ChainId | null = null;
      for (const cand of chains) {
        if (cand === c) continue;
        const v = surplus.get(cand) ?? 0n;
        if (v > 0n && (s === null || v > (surplus.get(s) ?? 0n))) s = cand;
      }
      if (s === null) return null;
      const deliverable = mulDivFloor(surplus.get(s) ?? 0n, den, num);
      const x = remaining < deliverable ? remaining : deliverable;
      if (x === 0n) return null;
      const padded = mulDivCeil(x, num, den);
      out.push({ token, source: s, dest: c, padded, deliverable: x });
      surplus.set(s, (surplus.get(s) ?? 0n) - padded);
      remaining -= x;
    }
  }
  return out;
}
