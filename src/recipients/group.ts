// Implements: §9.6 steps 6–7 (resolve each subname for the group's chain with the §9.3 step 3 rules, 8 in parallel,
// 10 s timeout each, unresolvable → can't pay; drop the wallet's own address; duplicate addresses keep the
// alphabetically first subname), I-25.

import type { EnsClient } from '../contracts/io.js';
import type { Address, ChainId, Config } from '../contracts/types.js';
import { isSelf } from './address.js';
import { normalizeEns, resolveOnChain } from './ens.js';

export const MEMBER_CONCURRENCY = 8;
export const MEMBER_TIMEOUT_MS = 10_000;

export interface MemberLookup {
  subname: string;
  address: Address | null;
}

/** Resolves one subname; any failure, missing record or timeout yields null ("can't pay"). */
async function lookup(
  ens: EnsClient,
  config: Config,
  subname: string,
  chain_id: ChainId,
  timeoutMs: number,
): Promise<Address | null> {
  const name = normalizeEns(subname);
  if (name === null) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([resolveOnChain(ens, config, name, chain_id).catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** §9.6 step 6: at most `concurrency` lookups in flight; results in input order. */
export async function resolveMembers(
  ens: EnsClient,
  config: Config,
  subnames: string[],
  chain_id: ChainId,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<MemberLookup[]> {
  const concurrency = opts.concurrency ?? MEMBER_CONCURRENCY;
  const timeoutMs = opts.timeoutMs ?? MEMBER_TIMEOUT_MS;
  const out: MemberLookup[] = subnames.map((subname) => ({ subname, address: null }));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < subnames.length) {
      const i = next++;
      const subname = subnames[i] as string;
      out[i] = { subname, address: await lookup(ens, config, subname, chain_id, timeoutMs) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, subnames.length) }, worker));
  return out;
}

export interface MemberTriage {
  /** Payable and unpayable members, alphabetical by subname (self and duplicates removed). */
  members: MemberLookup[];
  /** Subnames removed because they resolve to the wallet's own address (§9.6 step 7 note). */
  self: string[];
  /** Subnames removed as duplicates of an alphabetically earlier subname's address (SQ-07: no note wording). */
  duplicates: string[];
}

/** §9.6 step 7. */
export function triageMembers(lookups: MemberLookup[], wallet: Address): MemberTriage {
  const sorted = [...lookups].sort((a, b) => (a.subname < b.subname ? -1 : a.subname > b.subname ? 1 : 0));
  const members: MemberLookup[] = [];
  const self: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const m of sorted) {
    if (m.address === null) {
      members.push(m);
      continue;
    }
    if (isSelf(m.address, wallet)) {
      self.push(m.subname);
      continue;
    }
    const key = m.address.toLowerCase();
    if (seen.has(key)) {
      duplicates.push(m.subname);
      continue;
    }
    seen.add(key);
    members.push(m);
  }
  return { members, self, duplicates };
}
