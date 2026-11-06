// Implements SQ-CHAT-02: read-only wallet knowledge from §6.1 config, §8.1 DB4 refresh and §10.1 spendable math.
// Exact amounts only; no contact inventory, credentials, stale unavailable values, writes or model-generated facts.
import { getAddress } from 'viem';
import { fromBaseUnits } from '../contracts/money.js';
import type { StepContext } from '../contracts/step.js';
import { TOKEN_DECIMALS, type Address, type ChainId, type Token } from '../contracts/types.js';
import { WALLET_FACT } from '../messages/templates.js';
import { readBalances, TOKENS_ORDER } from '../plan/spendable.js';

export interface WalletTokenBalance {
  balance: string;
  spendable: string;
  pending: string;
  gas_reserve: string;
}

export interface WalletContext {
  address: Address;
  /** Oldest successful balance read in this snapshot; empty when no chain is readable. */
  refreshed_at: string;
  status: 'complete' | 'partial' | 'unavailable';
  chains: Array<{
    chain_id: ChainId;
    name: string;
    status: 'ok' | 'unavailable';
    tokens: Record<Token, WalletTokenBalance> | null;
  }>;
  totals: Record<Token, WalletTokenBalance> | null;
  facts: Record<string, string>;
}

/** Call after S0's cache read; the snapshot never treats unavailable DB4 rows as current balances. */
export function buildWalletContext(ctx: StepContext): WalletContext {
  const address = getAddress(ctx.config.wallet.address);
  const rows = readBalances(ctx);
  const readable = rows.filter((row) => row.ok);
  const refreshedAt =
    readable
      .flatMap((row) => TOKENS_ORDER.map((token) => ctx.repos.db4.get(row.chain_id, token)!.updated_at))
      .sort()[0] ?? '';
  const status = readable.length === 0 ? 'unavailable' : readable.length === rows.length ? 'complete' : 'partial';
  const facts: Record<string, string> = { wallet_address: WALLET_FACT.ADDRESS({ address }) };
  const total = {
    USDC: { balance: 0n, spendable: 0n, pending: 0n, gas_reserve: 0n },
    ETH: { balance: 0n, spendable: 0n, pending: 0n, gas_reserve: 0n },
  };
  const chains: WalletContext['chains'] = rows.map((row) => {
    const chain = ctx.config.chains.find((item) => item.chain_id === row.chain_id);
    if (!chain) throw new Error('Wallet chain is not configured');
    if (!row.ok) {
      facts[`unavailable_${row.chain_id}`] = WALLET_FACT.UNAVAILABLE({ chain: chain.name });
      return { chain_id: row.chain_id, name: chain.name, status: 'unavailable', tokens: null };
    }
    const tokens = {} as Record<Token, WalletTokenBalance>;
    for (const token of TOKENS_ORDER) {
      const units = {
        balance: row.raw[token],
        spendable: row.spendable[token],
        pending: row.pending[token],
        gas_reserve: token === 'ETH' ? row.reserve : 0n,
      };
      const values = {} as WalletTokenBalance;
      for (const field of ['balance', 'spendable', 'pending', 'gas_reserve'] as const) {
        values[field] = fromBaseUnits(units[field], TOKEN_DECIMALS[token]);
        total[token][field] += units[field];
      }
      tokens[token] = values;
      const p = { chain: chain.name, token };
      facts[`balance_${row.chain_id}_${token}`] = WALLET_FACT.BALANCE({ ...p, amount: values.balance });
      facts[`spendable_${row.chain_id}_${token}`] = WALLET_FACT.SPENDABLE({ ...p, amount: values.spendable });
      facts[`pending_${row.chain_id}_${token}`] = WALLET_FACT.PENDING({ ...p, amount: values.pending });
      if (token === 'ETH')
        facts[`gas_reserve_${row.chain_id}_ETH`] = WALLET_FACT.GAS_RESERVE({ ...p, amount: values.gas_reserve });
    }
    return { chain_id: row.chain_id, name: chain.name, status: 'ok', tokens };
  });
  let totals: WalletContext['totals'] = null;
  if (status === 'unavailable') {
    facts.balances_unavailable = WALLET_FACT.ALL_UNAVAILABLE();
  } else {
    totals = {} as Record<Token, WalletTokenBalance>;
    for (const token of TOKENS_ORDER) {
      const values = {} as WalletTokenBalance;
      for (const field of ['balance', 'spendable', 'pending', 'gas_reserve'] as const)
        values[field] = fromBaseUnits(total[token][field], TOKEN_DECIMALS[token]);
      totals[token] = values;
      facts[`total_${token}`] = (status === 'complete' ? WALLET_FACT.TOTAL : WALLET_FACT.SUBTOTAL)({
        token,
        amount: values.balance,
      });
      facts[`total_spendable_${token}`] = (
        status === 'complete' ? WALLET_FACT.TOTAL_SPENDABLE : WALLET_FACT.SUBTOTAL_SPENDABLE
      )({ token, amount: values.spendable });
    }
  }
  return { address, refreshed_at: refreshedAt, status, chains, totals, facts };
}
