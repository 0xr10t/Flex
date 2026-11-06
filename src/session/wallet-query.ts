// Common read-only wallet queries are answered locally, before either conversational model is called.
// Consume the entire message: mixed payment instructions and unfamiliar wording keep the normal routing.
import type { Address, ChainId, Token } from '../contracts/types.js';
import { WALLET_FACT } from '../messages/templates.js';
import type { WalletContext } from './wallet-context.js';

export interface WalletQuery {
  address: boolean;
  balances: boolean;
  spendable: boolean;
  chains: ChainId[];
  tokens: Token[];
}

export function parseWalletQuery(text: string): WalletQuery | null {
  if (text.length > 500) return null;
  let rest = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\b(wallet|account|metamask)'s\b/g, '$1')
    .trim()
    .replace(/[?!.]+$/, '')
    .trim();
  rest = rest.replace(/^please\s+/, '').replace(/\s+please$/, '');
  rest = rest.replace(/^(?:(?:can|could|would) you\s+)?(?:please\s+)?(?:show|display|tell|give|check)(?: me)?\s+/, '');
  rest = rest.replace(/^what(?:'s|s| is| are)\s+/, '');
  rest = rest.replace(
    /^how much (?:usdc|eth|ether) do i (?:currently )?have\b/,
    (phrase) => `my ${phrase.split(' ')[2]} balance`,
  );
  rest = rest.replace(/^how much do i (?:currently )?have\b/, 'my balance');
  rest = rest.replace(/^how much (?:can i (?:send|spend)|is (?:available|spendable))\b/, 'my spendable balance');
  rest = rest.replace(/^what can i (?:currently )?spend\b/, 'my spendable balance');
  const address = /\baddress(?:es)?\b/.test(rest);
  const spendable = /\b(?:spendable|available)\b/.test(rest);
  const balances = /\b(?:balances?|funds)\b/.test(rest) || spendable;
  if (!address && !balances) return null;
  const chains: ChainId[] = [];
  for (const [chain, pattern] of [
    [84532, /\bbase(?: sepolia)?\b/g],
    [421614, /\b(?:arbitrum(?: sepolia)?|arb)\b/g],
    [11155111, /\b(?:ethereum sepolia|sepolia)\b/g],
  ] as const) {
    rest = rest.replace(pattern, () => {
      if (!chains.includes(chain)) chains.push(chain);
      return ' ';
    });
  }
  const tokens: Token[] = [];
  for (const [token, pattern] of [
    ['USDC', /\b(?:usdc|usd coin)\b/g],
    ['ETH', /\b(?:eth|ether|ethereum)\b/g],
  ] as const) {
    rest = rest.replace(pattern, () => {
      if (!tokens.includes(token)) tokens.push(token);
      return ' ';
    });
  }
  // A token's contract address is a different question from the connected user's receiving address.
  if (address && tokens.length && !/\b(?:my|wallet|account|metamask)\b/.test(rest)) return null;
  rest = rest.replace(
    /\b(?:my|the|connected|metamask|wallet|account|addresses|address|balances|balance|funds|current|currently|cached|total|spendable|available|still|on|in|of|across|all|test|networks|network|chains|chain|and|now)\b/g,
    '',
  );
  if (rest.trim()) return null;
  return { address, balances, spendable, chains, tokens: tokens.length ? tokens : ['ETH', 'USDC'] };
}

export function renderWalletQuery(query: WalletQuery, address: Address, wallet?: WalletContext): string {
  const lines = query.address ? [WALLET_FACT.ADDRESS({ address })] : [];
  if (!query.balances || wallet === undefined) return lines.join('\n');
  const chains = query.chains.length
    ? wallet.chains.filter((chain) => query.chains.includes(chain.chain_id))
    : wallet.chains;
  if (chains.length === 0) {
    lines.push('That network is not enabled in this session.');
  } else if (wallet.status === 'unavailable') {
    lines.push(WALLET_FACT.ALL_UNAVAILABLE());
  } else {
    for (const chain of chains) {
      if (chain.status !== 'ok') {
        lines.push(wallet.facts[`unavailable_${chain.chain_id}`]!);
        continue;
      }
      for (const token of query.tokens)
        lines.push(wallet.facts[`${query.spendable ? 'spendable' : 'balance'}_${chain.chain_id}_${token}`]!);
    }
    if (!query.chains.length)
      for (const token of query.tokens)
        lines.push(wallet.facts[`${query.spendable ? 'total_spendable' : 'total'}_${token}`]!);
  }
  return lines.join('\n');
}
