// After a request goes to the wallet, the CLI follows it there and says what happened: green when a transaction went
// through, red when it did not. It reads GET /v1/intents/:request_id on the wallet with the token the agent submits
// with, and prints one block per step when that step's outcome is known.

import type { Line, Segment } from '../repl.js';

type State = 'preparing' | 'needs_setup' | 'awaiting_approval' | 'confirming' | 'confirmed' | 'completed' | 'failed';

export interface StepView {
  step: number;
  kind: 'i' | 'j' | 'k' | 'l';
  chain_id: number;
  dest_chain_id?: number;
  token?: string;
  recipients?: { address: string; amount: string }[];
  amount?: string;
  state: State;
  tx_hash: string | null;
  error_code: string | null;
}

const CHAINS: Record<number, { name: string; explorer: string }> = {
  11155111: { name: 'Ethereum Sepolia', explorer: 'https://sepolia.etherscan.io' },
  84532: { name: 'Base Sepolia', explorer: 'https://sepolia.basescan.org' },
  421614: { name: 'Arbitrum Sepolia', explorer: 'https://sepolia.arbiscan.io' },
};

/** Why a step did not go through, in words. Unknown codes are shown as they are. */
const REASONS: Record<string, string> = {
  USER_REJECTED: 'You rejected it in MetaMask.',
  TX_REVERTED: 'The transaction reverted on-chain.',
  TX_REPLACED: 'Another transaction from this account replaced it.',
  EFFECT_MISSING: 'The transaction was mined, but the transfer did not show up on-chain.',
  WOULD_FAIL: 'The wallet found it would fail, so it was not sent.',
  SIMULATION_FAILED: 'The simulation failed, so it was not sent.',
  SIMULATION_MISMATCH: 'The simulation did not match the request, so it was not sent.',
  SIMULATION_UNAVAILABLE: 'The wallet could not simulate it, so it was not sent.',
  DECODE_MISMATCH: 'The prepared calls did not match the request, so it was not sent.',
  FEE_TOO_HIGH: 'The bridge fee was above your limit, so it was not sent.',
  BRIDGE_ROUTE_UNAVAILABLE: 'That bridge route is not available right now.',
  BRIDGE_VERSION_UNSUPPORTED: 'The bridge on this route is a version Flex does not support.',
  ACCOUNT_DELEGATED_ELSEWHERE: 'This account points to a different smart-account implementation.',
  DELEGATOR_MISSING: 'The smart-account contract is missing on this network.',
  DEPENDENCY_FAILED: 'An earlier step it depends on did not go through.',
  START_PASSED: 'Its start time passed before it could be set up.',
  NOT_DEPLOYED: 'The recurring-payment contract is not deployed on this network.',
};

const chainName = (id: number | undefined) =>
  id === undefined ? 'an unknown network' : (CHAINS[id]?.name ?? `chain ${id}`);
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Names from the summary you confirmed, keyed by the short address it shows ("Soham (0x141A…ac78)"), so the result
 * reads like what you approved. Only a name next to the exact short form is used.
 */
export function namesFromSummary(lines: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const text of lines)
    for (const m of text.matchAll(/\bto ([^()]+?) \((0x[0-9a-fA-F]{4})…([0-9a-fA-F]{4})\)/g))
      names.set(`${m[2]}…${m[3]}`.toLowerCase(), m[1]!.trim());
  return names;
}

function payee(address: string, names: ReadonlyMap<string, string>): string {
  const name = names.get(short(address).toLowerCase());
  return name ? `${name} (${short(address)})` : short(address);
}

/** What the step does, e.g. "1 USDC to Soham (0x141A…ac78) on Arbitrum Sepolia". */
export function describeStep(s: StepView, names: ReadonlyMap<string, string> = new Map()): string {
  const on = chainName(s.chain_id);
  switch (s.kind) {
    case 'i':
    case 'k': {
      const recipients = s.recipients ?? [];
      const what =
        recipients.length === 1
          ? `${recipients[0]!.amount} ${s.token} to ${payee(recipients[0]!.address, names)}`
          : `${s.token} to ${recipients.length} recipients`;
      return s.kind === 'k' ? `Recurring ${what} on ${on}` : `${what} on ${on}`;
    }
    case 'j':
      return `${s.amount} ${s.token} from ${on} to ${chainName(s.dest_chain_id)}`;
    case 'l':
      return `Cancel a recurring payment on ${on}`;
  }
}

const OK = 5 as const;
const BAD = 6 as const;
const DIM = 1 as const;
const seg = (text: string, tone: Segment['tone']): Segment => ({ text, tone });

function txLine(s: StepView, tone: Segment['tone']): Line[] {
  const explorer = CHAINS[s.chain_id]?.explorer;
  if (!s.tx_hash) return [];
  return [[seg(explorer ? `  ${explorer}/tx/${s.tx_hash}` : `  Transaction ${s.tx_hash}`, tone)]];
}

/** The green block for a step that went through. `delivered` is a bridge's second, final message. */
function wentThrough(s: StepView, names: ReadonlyMap<string, string>, delivered = false): Line[] {
  const what = describeStep(s, names);
  if (s.kind === 'j' && delivered)
    return [[seg(`✓ Delivered · ${s.amount} ${s.token} arrived on ${chainName(s.dest_chain_id)}`, OK)]];
  const lines: Line[] = [[seg(`✓ Went through · ${what}`, OK)], ...txLine(s, OK)];
  if (s.kind === 'j' && !delivered)
    lines.push([seg('  Sent on the source network. I will tell you when the bridge delivers it.', DIM)]);
  return lines;
}

function didNotGoThrough(s: StepView, names: ReadonlyMap<string, string>): Line[] {
  const code = s.error_code ?? 'UNKNOWN';
  return [
    [seg(`✗ Did not go through · ${describeStep(s, names)}`, BAD)],
    [seg(`  ${REASONS[code] ?? `The wallet stopped it (${code}).`}`, BAD)],
    ...txLine(s, BAD),
  ];
}

/**
 * Turns one poll into lines, remembering per step what was already said. Exposed for tests; `watchRequest` is the
 * caller in the CLI.
 */
export function progressLines(
  steps: readonly StepView[],
  said: Map<number, 'setup' | 'ok' | 'delivered' | 'failed'>,
  names: ReadonlyMap<string, string>,
): Line[] {
  const out: Line[] = [];
  for (const s of steps) {
    const before = said.get(s.step);
    if (before === 'failed' || before === 'delivered') continue;
    if (s.state === 'failed') {
      out.push(...didNotGoThrough(s, names));
      said.set(s.step, 'failed');
    } else if (s.state === 'confirmed' || s.state === 'completed') {
      if (before !== 'ok') out.push(...wentThrough(s, names));
      said.set(s.step, 'ok');
      if (s.state === 'completed') {
        if (s.kind === 'j') out.push(...wentThrough(s, names, true));
        said.set(s.step, 'delivered');
      }
    } else if (s.state === 'needs_setup' && before === undefined) {
      out.push([seg(`Waiting for the smart-account setup on ${chainName(s.chain_id)} in your wallet page.`, DIM)]);
      said.set(s.step, 'setup');
    }
  }
  return out;
}

export interface WatchOptions {
  /** The wallet's base URL, e.g. http://127.0.0.1:8788/ */
  walletUrl: string;
  /** The token the agent submits requests with; the wallet answers status only with it. */
  token: string;
  requestId: string;
  names?: ReadonlyMap<string, string>;
  onLines: (lines: Line[]) => void;
  fetchImpl?: typeof fetch;
  /** How often to ask while something is still waiting on you or on the next block. */
  intervalMs?: number;
  /** How often to ask once every step went through and only finality or delivery remains. */
  slowIntervalMs?: number;
  /** When to give up following the request. */
  maxMs?: number;
}

export interface Watch {
  stop(): void;
  /** Resolves when every step has a final outcome, the watch timed out, or it was stopped. */
  done: Promise<void>;
}

export function watchRequest(opts: WatchOptions): Watch {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const names = opts.names ?? new Map<string, string>();
  const said = new Map<number, 'setup' | 'ok' | 'delivered' | 'failed'>();
  const url = `${opts.walletUrl.replace(/\/+$/, '')}/v1/intents/${encodeURIComponent(opts.requestId)}`;
  const started = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  const poll = async (): Promise<StepView[] | null> => {
    try {
      const res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { steps?: unknown };
      return Array.isArray(body.steps) ? (body.steps as StepView[]) : null;
    } catch {
      return null;
    }
  };

  const done = (async () => {
    while (!stopped) {
      const steps = await poll();
      if (stopped) return;
      if (steps) {
        const lines = progressLines(steps, said, names);
        if (lines.length) opts.onLines(lines);
        if (steps.length && steps.every((s) => s.state === 'completed' || s.state === 'failed')) return;
      }
      if (Date.now() - started > (opts.maxMs ?? 2 * 60 * 60_000)) {
        opts.onLines([[seg('Stopped following this request. The wallet page shows where it is.', DIM)]]);
        return;
      }
      const settled = steps?.length && steps.every((s) => ['confirmed', 'completed', 'failed'].includes(s.state));
      await sleep(settled ? (opts.slowIntervalMs ?? 15_000) : (opts.intervalMs ?? 2_000));
    }
  })();

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
    },
    done,
  };
}
