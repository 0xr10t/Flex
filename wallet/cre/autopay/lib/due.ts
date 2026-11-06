// The workflow's decisions, with no CRE imports, so they can be tested against the real contract.
//
// A.3 step 4: a plan list read from the chain, and a run written only if a simulation shows it paying. This mirrors
// `_processReport`, and the contract checks everything again, so a bug here can only miss a run. It can't pay wrongly (D11).

import {
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  getAbiItem,
  parseAbi,
  toEventSelector,
  type Hex,
} from 'viem';

export const EVENTS = parseAbi([
  'event Registered(bytes32 indexed intentId, address indexed delegator, uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, bytes redeem)',
  'event Executed(bytes32 indexed intentId, uint64 slot, uint64 paid)',
  'event Cancelled(bytes32 indexed intentId, address indexed delegator)',
]);

export const EXECUTED_TOPIC = toEventSelector(getAbiItem({ abi: EVENTS, name: 'Executed' }));

const ON_REPORT = parseAbi(['function onReport(bytes metadata, bytes report)']);

export interface Plan {
  id: Hex;
  startAt: bigint;
  interval: bigint;
  lateWindow: bigint;
  maxRuns: bigint;
  redeem: Hex;
  /** -1 until the first run is paid. */
  lastSlot: bigint;
  cancelled: boolean;
}

export type PlanEvent =
  | { name: 'Registered'; id: Hex; startAt: bigint; interval: bigint; lateWindow: bigint; maxRuns: bigint; redeem: Hex }
  | { name: 'Executed'; id: Hex; slot: bigint }
  | { name: 'Cancelled'; id: Hex };

/** Registered minus Cancelled, with each plan's last paid slot. One log query per chain, so no read per plan. */
export function plansFrom(events: readonly PlanEvent[]): Plan[] {
  const plans = new Map<Hex, Plan>();
  for (const e of events) {
    if (e.name === 'Registered') {
      const { startAt, interval, lateWindow, maxRuns, redeem } = e;
      plans.set(e.id, { id: e.id, startAt, interval, lateWindow, maxRuns, redeem, lastSlot: -1n, cancelled: false });
    }
  }
  for (const e of events) {
    const plan = plans.get(e.id);
    if (!plan) continue;
    if (e.name === 'Cancelled') plan.cancelled = true;
    if (e.name === 'Executed' && e.slot > plan.lastSlot) plan.lastSlot = e.slot;
  }
  return [...plans.values()].filter((p) => !p.cancelled);
}

/** The slot due now, or null. The same order of checks as `_processReport`. */
export function dueSlot(plan: Plan, now: bigint): bigint | null {
  if (plan.cancelled || now < plan.startAt) return null;
  const slot = (now - plan.startAt) / plan.interval;
  if (slot >= plan.maxRuns) return null;
  if (now > plan.startAt + slot * plan.interval + plan.lateWindow) return null;
  return slot <= plan.lastSlot ? null : slot;
}

const closesAt = (plan: Plan, slot: bigint) => plan.startAt + slot * plan.interval + plan.lateWindow;

export interface DueRun<T> {
  plan: Plan;
  slot: bigint;
  closesAt: bigint;
  chain: T;
}

/**
 * A.5 rule 10: only so many simulations fit in one execution. The runs whose window closes first go first. The rest stay due for
 * the next cron, so nothing is lost unless far more are due than the cron can get through inside their late windows (OQ-18).
 */
export function pickDue<T>(
  chains: readonly { chain: T; plans: readonly Plan[] }[],
  now: bigint,
  cap: number,
): DueRun<T>[] {
  const due: DueRun<T>[] = [];
  for (const { chain, plans } of chains) {
    for (const plan of plans) {
      const slot = dueSlot(plan, now);
      if (slot !== null) due.push({ plan, slot, chain, closesAt: closesAt(plan, slot) });
    }
  }
  due.sort((a, b) => (a.closesAt < b.closesAt ? -1 : a.closesAt > b.closesAt ? 1 : 0));
  return due.slice(0, cap);
}

export const reportOf = (redeem: Hex): Hex => encodeAbiParameters([{ type: 'bytes' }], [redeem]);

/** ReceiverTemplate reads `workflowId, name, owner` from these bytes once the executor expects a workflow id. */
export const metadataOf = (workflow: { id: Hex; name: Hex; owner: Hex }): Hex =>
  encodePacked(['bytes32', 'bytes10', 'address'], [workflow.id, workflow.name, workflow.owner]);

export const onReportCall = (metadata: Hex, report: Hex): Hex =>
  encodeFunctionData({ abi: ON_REPORT, functionName: 'onReport', args: [metadata, report] });

export interface Simulated {
  status: string;
  gasUsed: number;
  logs: readonly { address: string; topics?: readonly string[]; data?: string }[];
}

/**
 * Worth writing only if the executor's `Executed` shows up. Looking for ETH-transfer logs instead would skip every USDC autopay.
 * That was a bug in the old workflow, whose test only used ETH.
 */
export const simulationPaid = (sim: Simulated, executor: Hex, expected?: { id: Hex; slot: bigint }): boolean =>
  sim.status === '0x1' &&
  sim.logs.some((l) => {
    if (l.address.toLowerCase() !== executor.toLowerCase() || l.topics?.[0] !== EXECUTED_TOPIC) return false;
    if (!expected) return true;
    try {
      const event = decodeEventLog({ abi: EVENTS, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      return (
        event.eventName === 'Executed' &&
        event.args.intentId.toLowerCase() === expected.id.toLowerCase() &&
        event.args.slot === expected.slot &&
        event.args.paid > 0n
      );
    } catch {
      return false;
    }
  });

/** Simulated gas x2 for the forwarder's overhead, capped at CRE's 10 M, with a floor. From the tested workflow. */
export const gasFor = (simulated: number): number => Math.min(10_000_000, Math.max(500_000, simulated * 2));
