// Envelopes for service tests. These addresses are public test values.
import { formatUnits, parseUnits, type Hex } from 'viem';
import { USDC } from '@flex/protocol/schemas/intent.v2';
import type { AutopayK, BridgeJ, CancelL, HandoffEnvelope, PaymentI } from '@flex/protocol/schemas/envelope';

export const WALLET: Hex = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
export const ALEX: Hex = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65';
export const BOB: Hex = '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc';
export const CARA: Hex = '0x976EA74026E726554dB657fA54763abd0C3a0aa9';
export const BASE = 84532 as const;
export const ARBITRUM = 421614 as const;

export const usdc = (value: string) => ({ value, base_units: parseUnits(value, 6).toString(), decimals: 6 as const });
export const eth = (value: string) => ({ value, base_units: parseUnits(value, 18).toString(), decimals: 18 as const });

export const payUsdc = (
  step: number,
  recipients: [Hex, string][],
  chain_id: 84532 | 421614 = BASE,
  depends_on: number[] = [],
): PaymentI => ({
  intent_id: 'i',
  step,
  depends_on,
  token: 'USDC',
  token_address: USDC[chain_id],
  chain_id,
  recipients: recipients.map(([recipient, value]) => ({ recipient, amount: usdc(value) })),
});

export const payEth = (step: number, recipients: [Hex, string][], chain_id: 84532 | 421614 = BASE): PaymentI => ({
  intent_id: 'i',
  step,
  depends_on: [],
  token: 'ETH',
  token_address: null,
  chain_id,
  recipients: recipients.map(([recipient, value]) => ({ recipient, amount: eth(value) })),
});

let counter = 0;
export const requestId = (): string => `req_${(++counter).toString(16).padStart(12, '0')}`;

export const envelope = (intents: HandoffEnvelope['intents'], request_id = requestId()): HandoffEnvelope => ({
  version: '2',
  request_id,
  wallet_address: WALLET,
  created_at: '2026-11-06T10:00:00Z',
  intents,
});

export const DB_KEY = 'ab'.repeat(32);

/** A weekly-style autopay. `start` should come from the chain's clock. */
export const autopay = (
  step: number,
  start: number,
  recipients: [Hex, string][],
  options: {
    autopayId?: string;
    runs?: number;
    interval?: number;
    late?: number;
    feeTo?: Hex;
    chainId?: 84532 | 421614;
  } = {},
): AutopayK => {
  const { runs = 3, interval = 86400, late = 3600, chainId = BASE } = options;
  const fee = parseUnits('0.05', 6);
  const perRun = recipients.reduce((sum, [, v]) => sum + parseUnits(v, 6), fee);
  return {
    intent_id: 'k',
    step,
    depends_on: [],
    autopay_id: options.autopayId ?? `ap_${(0xabc000 + step).toString(16).padStart(12, '0')}`,
    token: 'USDC',
    token_address: USDC[chainId],
    chain_id: chainId,
    recipients: recipients.map(([recipient, value]) => ({ recipient, amount: usdc(value) })),
    fee: { to: options.feeTo ?? '0x000000000000000000000000000000000000fee0', amount: usdc('0.05') },
    schedule: {
      start_at: start,
      interval_seconds: interval,
      max_runs: runs,
      late_window_seconds: late,
      end_at: start + interval * (runs - 1) + late,
    },
    limits: { max_per_run: usdc(formatUnits(perRun, 6)), max_total: usdc(formatUnits(perRun * BigInt(runs), 6)) },
    executor: 'chainlink-cre',
  };
};

export const cancelOf = (step: number, autopayId: string, planId: Hex, chainId: 84532 | 421614 = BASE): CancelL => ({
  intent_id: 'l',
  step,
  autopay_id: autopayId,
  chain_id: chainId,
  plan_id: planId,
});

export const bridge = (step: number, value: string, fundsSteps: number[], feeMax = '0.002'): BridgeJ => ({
  intent_id: 'j',
  step,
  token: 'USDC',
  source_token_address: USDC[ARBITRUM],
  dest_token_address: USDC[BASE],
  source_chain_id: ARBITRUM,
  dest_chain_id: BASE,
  amount: usdc(value),
  receiver: 'self',
  fee_max_eth: feeMax,
  funds_steps: fundsSteps,
});
