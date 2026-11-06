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
  CreJob,
  EnvelopeAmount,
  EnvelopeIntent,
  HandoffEnvelope,
  InternalIntent,
  Schedule,
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

function scheduleOf(s: Schedule): Schedule {
  return {
    frequency: s.frequency,
    interval: s.interval,
    days_of_week: s.days_of_week,
    day_of_month: s.day_of_month,
    time_of_day: s.time_of_day,
    timezone: s.timezone,
    start_date: s.start_date,
    first_occurrence: s.first_occurrence,
    end: s.end,
  };
}

function creJobOf(j: CreJob): CreJob {
  return { trigger: j.trigger, cron: j.cron, timezone: j.timezone, interval: j.interval };
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
        amount: amountOf(ctx, it.amount),
        recipient: addressOf(ctx, it.recipient),
      };
    case 'j':
      return {
        intent_id: 'j',
        step: it.step,
        token: it.token,
        source_token_address: tokenAddress(ctx, it.token, it.source_chain_id),
        dest_token_address: tokenAddress(ctx, it.token, it.dest_chain_id),
        source_chain_id: it.source_chain_id,
        dest_chain_id: it.dest_chain_id,
        amount: amountOf(ctx, it.amount),
        receiver: 'self',
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
        recipient: addressOf(ctx, it.recipient),
        amount_per_payment: amountOf(ctx, it.amount_per_payment),
        prefund: amountOf(ctx, it.limits.total_cap),
        schedule: scheduleOf(it.schedule),
        limits: {
          per_period_cap: amountOf(ctx, it.limits.per_period_cap),
          total_cap: amountOf(ctx, it.limits.total_cap),
          expires_at: it.limits.expires_at,
        },
        cre_job: creJobOf(it.cre_job),
      };
    case 'l':
      return {
        intent_id: 'l',
        step: it.step,
        autopay_id: it.autopay_id,
        chain_id: it.chain_id,
        delegate_address: getAddress(it.delegate_address),
        recipient: addressOf(ctx, it.recipient),
        refund_remaining: true,
      };
  }
}

export function swapBack(ctx: StepContext, plan: InternalIntent[]): HandoffEnvelope {
  return {
    version: '1',
    request_id: ctx.req.request_id,
    wallet_address: getAddress(ctx.config.wallet.address),
    created_at: ctx.now().toUTC().toISO({ suppressMilliseconds: true }) as string,
    intents: plan.map((it) => intentOf(ctx, it)),
  };
}
