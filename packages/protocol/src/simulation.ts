// Provider agreement is a trust assumption, not a proof of execution. Keep the comparison identical in wallet and CRE.
export interface SimulationLog {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
}
export interface SimulationCall {
  status: '0x0' | '0x1';
  gasUsed: number;
  logs: SimulationLog[];
}
export type SimulationResult = SimulationCall[][];
export interface SimulationAnchor {
  number: string;
  hash: string;
  timestamp: string;
}

const unavailable = (): never => {
  throw new Error('simulation unavailable or providers disagree');
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return unavailable();
  return v as Record<string, unknown>;
};
const hex = (v: unknown, bytes?: number): `0x${string}` => {
  if (
    typeof v !== 'string' ||
    !/^0x(?:[a-fA-F0-9]{2})*$/.test(v) ||
    (bytes !== undefined && v.length !== 2 + bytes * 2)
  )
    return unavailable();
  return v.toLowerCase() as `0x${string}`;
};
export function quantity(v: unknown): bigint {
  if (typeof v !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(v)) return unavailable();
  return BigInt(v);
}

export function validateQuorum(count: number, quorum: number): void {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > 3 ||
    !Number.isInteger(quorum) ||
    quorum <= count / 2 ||
    quorum > count
  )
    unavailable();
}

/** Validate ALL calls and logs. Missing logs cannot be treated as an empty list: that could hide an extra transfer. */
export function parseSimulation(value: unknown, callCounts: readonly number[]): SimulationResult {
  if (!Array.isArray(value) || value.length !== callCounts.length) return unavailable();
  return value.map((block, i) => {
    const calls = object(block).calls;
    if (!Array.isArray(calls) || calls.length !== callCounts[i]) return unavailable();
    return calls.map((raw) => {
      const c = object(raw);
      if ((c.status !== '0x0' && c.status !== '0x1') || !Array.isArray(c.logs)) return unavailable();
      const gas = quantity(c.gasUsed);
      if (gas > BigInt(Number.MAX_SAFE_INTEGER)) return unavailable();
      return {
        status: c.status,
        gasUsed: Number(gas),
        logs: c.logs.map((rawLog) => {
          const l = object(rawLog);
          if (!Array.isArray(l.topics) || l.topics.length > 4) return unavailable();
          return { address: hex(l.address, 20), topics: l.topics.map((t) => hex(t, 32)), data: hex(l.data) };
        }),
      };
    });
  });
}

/** Compare the block header before/after simulation. This catches ordinary reorgs; it does not verify a state proof. */
export function checkAnchor(value: unknown, anchor: SimulationAnchor): void {
  const b = object(value);
  if (
    quantity(b.number) !== quantity(anchor.number) ||
    hex(b.hash, 32) !== hex(anchor.hash, 32) ||
    quantity(b.timestamp) !== quantity(anchor.timestamp)
  )
    unavailable();
}

/** Keep unavailable providers in the denominator. There is no automatic downgrade to one healthy response. */
export function agreeSimulation(observations: readonly (SimulationResult | null)[], quorum: number): SimulationResult {
  validateQuorum(observations.length, quorum);
  const groups = new Map<string, { count: number; value: SimulationResult }>();
  for (const value of observations) {
    if (value === null) continue;
    const key = JSON.stringify(value);
    const entry = groups.get(key) ?? { count: 0, value };
    entry.count++;
    groups.set(key, entry);
  }
  for (const group of groups.values()) if (group.count >= quorum) return group.value;
  return unavailable();
}
