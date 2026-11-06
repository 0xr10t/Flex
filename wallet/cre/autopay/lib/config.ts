import { keccak256, type Hex } from 'viem';
import type { Plan } from './due';
import { SIMULATION_FORWARDERS } from '../../../src/autopay/local-cre';

export interface ChainSource {
  chainId: number;
  selector: string;
  simulation: { urlsSecret: string; quorum: number };
}
export interface PlanSnapshot {
  blockNumber: string;
  blockHash: Hex;
  plans: Array<
    Omit<Plan, 'startAt' | 'interval' | 'lateWindow' | 'maxRuns' | 'lastSlot'> & {
      startAt: string;
      interval: string;
      lateWindow: string;
      maxRuns: string;
      lastSlot: string;
    }
  >;
}
export interface ChainConfig extends ChainSource {
  executor: Hex;
  forwarder: Hex;
  deploymentBlock: string;
  /** Local indexer supplies complete historical plans; CRE checks the checkpoint and simulates exact calldata. */
  snapshot?: PlanSnapshot;
}
export interface PaymentConfig {
  mode: 'dry-run' | 'broadcast';
  schedule: string;
  maxSimulationsPerRun: number;
  workflow: { id: Hex; name: Hex; owner: Hex };
  chains: ChainConfig[];
}
export interface TestnetPaymentConfig {
  mode: 'testnet-dry-run' | 'testnet-broadcast';
  schedule: string;
  maxSimulationsPerRun: number;
  /** Only this wallet's registered, signed plans may spend the local transmitter's gas. */
  walletAddress: Hex;
  expectedRun?: { id: Hex; slot: string };
  chains: ChainConfig[];
}
export interface LocalConfig {
  mode: 'local-simulation';
  schedule: string;
  /** One chain per invocation keeps the live HTTP qualification within the CRE call budget. */
  chains: [ChainSource];
}
export type Config = PaymentConfig | TestnetPaymentConfig | LocalConfig;

const selectors: Record<number, string> = {
  11155111: '16015286601757825753',
  84532: '10344971235874465080',
  421614: '3478487238524512106',
};
const fail = (): never => {
  throw new Error('invalid CRE configuration');
};
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(v).some((key) => !allowed.includes(key))) fail();
};
const hex = (v: unknown, bytes: number) => {
  if (typeof v !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(v) || /^0x0+$/.test(v)) fail();
};
const uint = (v: unknown) => {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v) || BigInt(v) > (1n << 64n) - 1n) fail();
};

export function validateConfig(input: unknown): Config {
  const c = record(input);
  if (!['local-simulation', 'dry-run', 'broadcast', 'testnet-dry-run', 'testnet-broadcast'].includes(String(c.mode)))
    fail();
  const local = c.mode === 'local-simulation';
  const testnet = c.mode === 'testnet-dry-run' || c.mode === 'testnet-broadcast';
  keys(
    c,
    local
      ? ['mode', 'schedule', 'chains']
      : [
          'mode',
          'schedule',
          'maxSimulationsPerRun',
          ...(testnet ? ['walletAddress', 'expectedRun'] : ['workflow']),
          'chains',
        ],
  );
  if (typeof c.schedule !== 'string' || !/^[0-9*,/-]+(?:\s+[0-9*,/-]+){5}$/.test(c.schedule)) fail();
  if (!Array.isArray(c.chains) || c.chains.length < 1 || c.chains.length > (local ? 1 : 3)) fail();
  if (!local) {
    if (
      !Number.isInteger(c.maxSimulationsPerRun) ||
      Number(c.maxSimulationsPerRun) < 1 ||
      Number(c.maxSimulationsPerRun) > 2
    )
      fail();
    if (testnet) {
      hex(c.walletAddress, 20);
      // One native invocation has at most one write. The host journals that exact slot before starting it.
      if (c.maxSimulationsPerRun !== 1 || (c.chains as unknown[]).length !== 1) fail();
      if (c.mode === 'testnet-broadcast' || c.expectedRun !== undefined) {
        const expected = record(c.expectedRun);
        keys(expected, ['id', 'slot']);
        hex(expected.id, 32);
        uint(expected.slot);
      }
    } else {
      const w = record(c.workflow);
      keys(w, ['id', 'name', 'owner']);
      hex(w.id, 32);
      hex(w.name, 10);
      hex(w.owner, 20);
    }
  }
  const seen = new Set<number>();
  for (const raw of c.chains as unknown[]) {
    const chain = record(raw);
    keys(
      chain,
      local
        ? ['chainId', 'selector', 'simulation']
        : ['chainId', 'selector', 'simulation', 'executor', 'forwarder', 'deploymentBlock', 'snapshot'],
    );
    const id = Number(chain.chainId);
    if (!Number.isInteger(chain.chainId) || selectors[id] !== chain.selector || seen.has(id)) fail();
    seen.add(id);
    const sim = record(chain.simulation);
    keys(sim, ['urlsSecret', 'quorum']);
    if (
      typeof sim.urlsSecret !== 'string' ||
      !/^[A-Z][A-Z0-9_]{0,99}$/.test(sim.urlsSecret) ||
      ![2, 3].includes(Number(sim.quorum)) ||
      typeof sim.quorum !== 'number'
    )
      fail();
    if (local) continue;
    hex(chain.executor, 20);
    hex(chain.forwarder, 20);
    if (testnet && String(chain.forwarder).toLowerCase() !== SIMULATION_FORWARDERS[id]?.toLowerCase()) fail();
    uint(chain.deploymentBlock);
    if (chain.snapshot !== undefined) {
      const snapshot = record(chain.snapshot);
      keys(snapshot, ['blockNumber', 'blockHash', 'plans']);
      uint(snapshot.blockNumber);
      hex(snapshot.blockHash, 32);
      if (
        BigInt(snapshot.blockNumber as string) < BigInt(chain.deploymentBlock as string) ||
        !Array.isArray(snapshot.plans) ||
        snapshot.plans.length > 10_000
      )
        fail();
      const ids = new Set<string>();
      for (const rawPlan of snapshot.plans as unknown[]) {
        const p = record(rawPlan);
        keys(p, ['id', 'startAt', 'interval', 'lateWindow', 'maxRuns', 'redeem', 'lastSlot', 'cancelled']);
        hex(p.id, 32);
        for (const field of ['startAt', 'interval', 'lateWindow', 'maxRuns']) uint(p[field]);
        if (
          typeof p.redeem !== 'string' ||
          !/^0x(?:[0-9a-fA-F]{2}){4,50000}$/.test(p.redeem) ||
          keccak256(p.redeem as Hex).toLowerCase() !== String(p.id).toLowerCase()
        )
          fail();
        if (
          typeof p.cancelled !== 'boolean' ||
          typeof p.lastSlot !== 'string' ||
          !/^(?:-1|0|[1-9][0-9]*)$/.test(p.lastSlot)
        )
          fail();
        if (
          BigInt(p.interval as string) === 0n ||
          BigInt(p.lateWindow as string) === 0n ||
          BigInt(p.lateWindow as string) > BigInt(p.interval as string) ||
          BigInt(p.maxRuns as string) === 0n ||
          BigInt(p.lastSlot as string) >= BigInt(p.maxRuns as string)
        )
          fail();
        if (ids.has(String(p.id).toLowerCase())) fail();
        ids.add(String(p.id).toLowerCase());
      }
    }
  }
  return input as Config;
}

export const configSchema = {
  '~standard': {
    version: 1 as const,
    vendor: 'flex',
    validate(value: unknown) {
      try {
        return { value: validateConfig(value) };
      } catch {
        return { issues: [{ message: 'invalid CRE configuration' }] };
      }
    },
  },
};

export const snapshotPlans = (snapshot: PlanSnapshot): Plan[] =>
  snapshot.plans.map((p) => ({
    ...p,
    startAt: BigInt(p.startAt),
    interval: BigInt(p.interval),
    lateWindow: BigInt(p.lateWindow),
    maxRuns: BigInt(p.maxRuns),
    lastSlot: BigInt(p.lastSlot),
  }));
