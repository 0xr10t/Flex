// The check before anything is signed. The decoder and `eth_simulateV1` run at the same moment on the same transaction, and the
// intent, what the bytes say, and what the simulation shows must all agree. If they don't, or if simulation isn't available, the
// step stops: this check has no fallback. It reuses nothing from the code that built the batch.

import { UPGRADED_CODE } from '../chain/addresses.js';
import { type ChainGateway, type SimBlock, type SimCallResult } from '../chain/gateway.js';
import { eventsOfLogs, movementsOfLogs, type Movement, type SeenEvent } from './decode.js';
import type { Hex } from 'viem';

export interface ExpectedEvent {
  name: string;
  planId?: Hex;
  address: Hex;
}

export interface Check {
  /** The transactions to simulate, in order. */
  blocks: SimBlock[];
  /** Reads the raw bytes that would be signed, and returns what they would move. Null means they don't decode as expected. */
  decode: () => Movement[] | null;
  /** Exactly what the intent says should move out of the wallet. */
  movements: Movement[];
  /** Events the simulation must show. */
  events: ExpectedEvent[];
  /** Events it must not show, such as a run paying after a cancel. */
  forbidden?: ExpectedEvent[];
  /** Readable lines for the approval. */
  summary: string[];
}

export type CheckFailure = 'DECODE_MISMATCH' | 'SIMULATION_FAILED' | 'SIMULATION_MISMATCH' | 'SIMULATION_UNAVAILABLE';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const movementMatches = (want: Movement, got: Movement) =>
  (want.token === 'ETH' || got.token === 'ETH' ? want.token === got.token : same(want.token, got.token)) &&
  same(want.from, got.from) &&
  (want.to === null || got.to === null || same(want.to, got.to)) &&
  want.value === got.value;

/** Exact: every expected movement once, and nothing else. Extra money leaving is as wrong as money missing. */
export function sameMovements(want: readonly Movement[], got: readonly Movement[]): boolean {
  if (want.length !== got.length) return false;
  const left = [...got];
  return want.every((w) => {
    const at = left.findIndex((g) => movementMatches(w, g));
    if (at === -1) return false;
    left.splice(at, 1);
    return true;
  });
}

const eventMatches = (want: ExpectedEvent, got: SeenEvent) =>
  want.name === got.name &&
  same(want.address, got.address) &&
  (want.planId === undefined || want.planId === got.planId);

/** Compares a finished simulation with the intent. A separate function, so each way of disagreeing can be tested. */
export function judge(
  check: Check,
  decoded: Movement[] | null,
  results: readonly SimCallResult[][],
  wallet: Hex,
): CheckFailure | null {
  if (decoded === null || !sameMovements(check.movements, decoded)) return 'DECODE_MISMATCH';

  const moved: Movement[] = [];
  const seen: SeenEvent[] = [];
  let failed = false;
  check.blocks.forEach((block, b) => {
    for (const call of results[b] ?? []) {
      // A probe is allowed to fail: "a run after a cancel doesn't pay" is what it's there to show.
      if (call.status !== 'success' && !block.probe) failed = true;
      if (call.status === 'success') {
        moved.push(...movementsOfLogs(call.logs));
        seen.push(...eventsOfLogs(call.logs));
      }
    }
    if ((results[b]?.length ?? 0) !== block.calls.length && !block.probe) failed = true;
  });
  if (failed) return 'SIMULATION_FAILED';

  const fromWallet = moved.filter((m) => same(m.from, wallet));
  if (!sameMovements(check.movements, fromWallet)) return 'SIMULATION_MISMATCH';
  if (!check.events.every((want) => seen.some((got) => eventMatches(want, got)))) return 'SIMULATION_MISMATCH';
  if ((check.forbidden ?? []).some((no) => seen.some((got) => eventMatches(no, got)))) return 'SIMULATION_MISMATCH';
  return null;
}

/** So a first-time account simulates as it will run, once upgraded. Harmless on an account that already is. */
export const asUpgraded = (wallet: Hex): SimBlock['stateOverrides'] => ({ [wallet]: { code: UPGRADED_CODE as Hex } });

/**
 * Runs the decoder and the simulation together. Throws ChainUnavailableError or SimulationUnavailableError when the chain can't
 * answer, so the caller can try again and then stop.
 */
export async function runCheck(gateway: ChainGateway, check: Check, wallet: Hex): Promise<CheckFailure | null> {
  const [decoded, results] = await Promise.all([Promise.resolve().then(check.decode), gateway.simulate(check.blocks)]);
  return judge(check, decoded, results, wallet);
}
