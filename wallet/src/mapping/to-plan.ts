// Implements: AGENT_SPEC §12.5 mapping table (envelope -> verified schemas of intent.v2.ts and bridge.v2.ts).
// Ported from toPlan() in flex.handoff.test.ts, with two differences: amounts are summed as bigint (the test code used
// Number, which truncates ETH to 6 decimals), and delegationHash is the real hash, not the plan_id stand-in.

import { formatUnits, keccak256, parseUnits, toBytes } from 'viem';
import type {
  AutopayK,
  BridgeJ,
  CancelL,
  EnvelopeIntent,
  HandoffEnvelope,
  Hex,
  PaymentI,
  Token,
} from '../schemas/envelope.js';
import { USDC } from '../schemas/intent.v2.js';

export class MappingError extends Error {
  constructor(readonly path: string) {
    super(`envelope field is inconsistent: ${path}`);
    this.name = 'MappingError';
  }
}

export interface ToPlanOptions {
  /** step -> hash of the delegation read from the executor's Registered event. Required for every `l` (§12.5). */
  delegationHashes?: Readonly<Record<number, Hex>>;
}

const DECIMALS: Record<Token, 6 | 18> = { USDC: 6, ETH: 18 };

/**
 * `IntentSchema` needs a UUID and the envelope has none. Its hash becomes the delegation salt, so a repeat of the same
 * step must give the same id; a random id would let a re-sign after a crash create a second live plan.
 * Provisional: OQ-09 in docs/wallet/OPEN_QUESTIONS.md.
 */
export function intentIdFor(requestId: string, step: number): string {
  const h = keccak256(toBytes(`flex-wallet/intent/${requestId}/${step}`)).slice(2);
  const variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * §12.5 "base_units = decimal x 10^decimals". The verified schemas only read `value`, while calldata is built from
 * amounts, so a disagreement must stop here rather than reach a signature.
 */
function assertAmount(a: { value: string; base_units: string; decimals: number }, token: Token, path: string): void {
  if (a.decimals !== DECIMALS[token]) throw new MappingError(`${path}.decimals`);
  const fraction = a.value.split('.')[1] ?? '';
  if (fraction.length > a.decimals) throw new MappingError(`${path}.value`);
  if (parseUnits(a.value, a.decimals).toString() !== a.base_units) throw new MappingError(`${path}.base_units`);
}

function assertTokenAddress(token: Token, tokenAddress: Hex | null, path: string): void {
  // `asset` below ignores the address for ETH, so an ETH intent carrying one would otherwise pass unnoticed.
  if (token === 'ETH' && tokenAddress !== null) throw new MappingError(path);
}

const asset = (token: Token, tokenAddress: Hex | null) =>
  token === 'ETH'
    ? { type: 'native' as const, token: null, decimals: 18 as const }
    : { type: 'erc20' as const, token: tokenAddress, decimals: 6 as const };

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

function mapPayment(env: HandoffEnvelope, x: PaymentI, path: string) {
  assertTokenAddress(x.token, x.token_address, `${path}.token_address`);
  x.recipients.forEach((r, k) => assertAmount(r.amount, x.token, `${path}.recipients[${k}].amount`));
  const total = x.recipients.reduce((sum, r) => sum + BigInt(r.amount.base_units), 0n);
  return {
    step: x.step,
    kind: 'payment' as const,
    dependsOn: x.depends_on,
    intent: {
      intentId: intentIdFor(env.request_id, x.step),
      version: 1,
      chainId: x.chain_id,
      from: env.wallet_address,
      asset: asset(x.token, x.token_address),
      recipients: x.recipients.map((r) => ({ to: r.recipient, amount: r.amount.value })),
      atomic: true,
      schedule: { type: 'once', startAt: null, interval: null, maxRuns: null, endAt: null, lateWindow: null },
      execution: { mode: 'immediate', executor: null, fee: null },
      limits: { maxPerRun: formatUnits(total, DECIMALS[x.token]), maxTotal: null },
    },
  };
}

function mapAutopay(env: HandoffEnvelope, x: AutopayK, path: string) {
  assertTokenAddress(x.token, x.token_address, `${path}.token_address`);
  x.recipients.forEach((r, k) => assertAmount(r.amount, x.token, `${path}.recipients[${k}].amount`));
  assertAmount(x.fee.amount, x.token, `${path}.fee.amount`);
  assertAmount(x.limits.max_per_run, x.token, `${path}.limits.max_per_run`);
  assertAmount(x.limits.max_total, x.token, `${path}.limits.max_total`);
  const s = x.schedule;
  return {
    step: x.step,
    kind: 'payment' as const,
    dependsOn: x.depends_on,
    intent: {
      intentId: intentIdFor(env.request_id, x.step),
      version: 1,
      chainId: x.chain_id,
      from: env.wallet_address,
      asset: asset(x.token, x.token_address),
      recipients: x.recipients.map((r) => ({ to: r.recipient, amount: r.amount.value })),
      atomic: true,
      schedule: {
        type: 'recurring',
        startAt: iso(s.start_at),
        interval: s.interval_seconds,
        maxRuns: s.max_runs,
        endAt: iso(s.end_at),
        lateWindow: s.late_window_seconds,
      },
      execution: { mode: 'automated', executor: x.executor, fee: { to: x.fee.to, amount: x.fee.amount.value } },
      limits: { maxPerRun: x.limits.max_per_run.value, maxTotal: x.limits.max_total.value },
    },
  };
}

function mapBridge(env: HandoffEnvelope, x: BridgeJ, path: string) {
  assertAmount(x.amount, 'USDC', `${path}.amount`);
  // BridgeSchema only sees the source token. The destination token is checked here so the envelope has no unread field.
  if (x.dest_token_address.toLowerCase() !== USDC[x.dest_chain_id].toLowerCase()) {
    throw new MappingError(`${path}.dest_token_address`);
  }
  return {
    step: x.step,
    kind: 'bridge' as const,
    funds: x.funds_steps,
    intent: {
      intentId: intentIdFor(env.request_id, x.step),
      version: 1,
      from: env.wallet_address,
      sourceChainId: x.source_chain_id,
      destChainId: x.dest_chain_id,
      asset: { type: 'erc20', token: x.source_token_address, decimals: 6 },
      amount: x.amount.value,
      receiver: env.wallet_address,
      fee: { payIn: 'native', max: x.fee_max_eth },
      execution: { mode: 'immediate' },
    },
  };
}

function mapCancel(env: HandoffEnvelope, x: CancelL, path: string, options: ToPlanOptions) {
  const delegationHash = options.delegationHashes?.[x.step];
  if (delegationHash === undefined) throw new MappingError(`${path}.plan_id`);
  return {
    step: x.step,
    kind: 'cancel' as const,
    intent: {
      intentId: intentIdFor(env.request_id, x.step),
      version: 1,
      from: env.wallet_address,
      chainId: x.chain_id,
      autopayId: x.autopay_id,
      delegationHash,
      execution: { mode: 'immediate' },
    },
  };
}

function mapIntent(env: HandoffEnvelope, x: EnvelopeIntent, k: number, options: ToPlanOptions) {
  const path = `/intents/${k}`;
  switch (x.intent_id) {
    case 'i':
      return mapPayment(env, x, path);
    case 'k':
      return mapAutopay(env, x, path);
    case 'j':
      return mapBridge(env, x, path);
    case 'l':
      return mapCancel(env, x, path, options);
  }
}

/**
 * The real hash of an `l` needs a chain read, which the intake can't wait for. So the intake checks everything else with
 * this stand-in, and the cancel step reads the real one before anything is signed.
 */
export function placeholderHashes(env: HandoffEnvelope): Record<number, Hex> {
  const zero = `0x${'00'.repeat(32)}` as Hex;
  return Object.fromEntries(env.intents.filter((x) => x.intent_id === 'l').map((x) => [x.step, zero]));
}

/** Returns the input for `PlanSchema`, which is what decides whether it is valid. Throws MappingError. */
export function toPlan(env: HandoffEnvelope, options: ToPlanOptions = {}) {
  return {
    requestId: env.request_id,
    steps: env.intents.map((x, k) => mapIntent(env, x, k, options)),
  };
}
