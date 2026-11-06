// Implements: §8.14 step 1 `swap_back`: builds the §12.5 envelope from the internal plan with an allowlist of fields,
// `amount_` → {value, base_units, decimals} from DB1, `address_` → EIP-55 address from DB3; §12.5 hand-off rules
// (token_address, base_units with bigint, no trailing zeros, checksums, prefund = total_cap); §16.2 no names, ENS names,
// prompt text, placeholders or summary in the envelope. Throws on any missing value: S12 reports HANDOFF_INVALID.

import { getAddress } from 'viem';
import { fromBaseUnits, toBaseUnits } from '../contracts/money.js';
import type { StepContext } from '../contracts/step.js';
import type {
  Address,
  AddressPh,
  AmountPh,
  ChainId,
  EnvelopeAmount,
  EnvelopeIntent,
  HandoffEnvelope,
  InternalIntent,
  Token,
} from '../contracts/types.js';
import { TOKEN_DECIMALS } from '../contracts/types.js';

function amountOf(ctx: StepContext, ph: AmountPh): EnvelopeAmount {
  const row = ctx.repos.db1.get(ph);
  if (!row) throw new Error('db1 row missing');
  const decimals = TOKEN_DECIMALS[row.token];
  const units = toBaseUnits(row.amount, decimals);
  return { value: fromBaseUnits(units, decimals), base_units: units.toString(), decimals };
}

function addressOf(ctx: StepContext, ph: AddressPh): Address {
  const address = ctx.repos.db3.get(ph)?.address;
  if (!address) throw new Error('db3 address missing');
  return getAddress(address);
}

function tokenAddress(ctx: StepContext, token: Token, chain_id: ChainId): Address | null {
  if (token === 'ETH') return null;
  const chain = ctx.config.chains.find((c) => c.chain_id === chain_id);
  if (!chain) throw new Error('chain not configured');
  return getAddress(chain.usdc_address);
}

function intentOf(ctx: StepContext, it: InternalIntent): EnvelopeIntent {
  switch (it.intent_id) {
    case 'i':
      return {
        intent_id: 'i',
        step: it.step,
        depends_on: it.depends_on,
        token: it.token,
        token_address: tokenAddress(ctx, it.token, it.chain_id),
        chain_id: it.chain_id,
        recipients: it.recipients.map((p) => ({
          recipient: addressOf(ctx, p.recipient),
          amount: amountOf(ctx, p.amount),
        })),
      };
    case 'j':
      return {
        intent_id: 'j',
        step: it.step,
        token: it.token,
        source_token_address: tokenAddress(ctx, it.token, it.source_chain_id) as Address,
        dest_token_address: tokenAddress(ctx, it.token, it.dest_chain_id) as Address,
        source_chain_id: it.source_chain_id,
        dest_chain_id: it.dest_chain_id,
        amount: amountOf(ctx, it.amount),
        receiver: 'self',
        fee_max_eth: it.fee_max_eth,
        funds_steps: it.funds_steps,
      };
    case 'k':
      return {
        intent_id: 'k',
        step: it.step,
        depends_on: it.depends_on,
        autopay_id: it.autopay_id,
        token: it.token,
        token_address: tokenAddress(ctx, it.token, it.chain_id),
        chain_id: it.chain_id,
        recipients: it.recipients.map((p) => ({
          recipient: addressOf(ctx, p.recipient),
          amount: amountOf(ctx, p.amount),
        })),
        fee: { to: getAddress(it.fee.to), amount: amountOf(ctx, it.fee.amount) },
        schedule: {
          start_at: it.schedule.start_at,
          interval_seconds: it.schedule.interval_seconds,
          max_runs: it.schedule.max_runs,
          late_window_seconds: it.schedule.late_window_seconds,
          end_at: it.schedule.end_at,
        },
        limits: {
          max_per_run: amountOf(ctx, it.limits.max_per_run),
          max_total: amountOf(ctx, it.limits.max_total),
        },
        executor: 'chainlink-cre',
      };
    case 'l':
      return {
        intent_id: 'l',
        step: it.step,
        autopay_id: it.autopay_id,
        chain_id: it.chain_id,
        plan_id: it.plan_id,
      };
  }
}

export function swapBack(ctx: StepContext, plan: InternalIntent[]): HandoffEnvelope {
  return {
    version: '2',
    request_id: ctx.req.request_id,
    wallet_address: getAddress(ctx.config.wallet.address),
    created_at: ctx.now().toUTC().toISO({ suppressMilliseconds: true }) as string,
    intents: plan.map((it) => intentOf(ctx, it)),
  };
}
