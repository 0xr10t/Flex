import { DateTime } from 'luxon';
import { fromBaseUnits } from '../contracts/money.js';
import { TOKEN_DECIMALS, type Address, type ChainConfig, type ChainId, type Token } from '../contracts/types.js';
import { HISTORY_MAX_AGE_MS, type ChainHistory, type HistoryReader } from '../history/types.js';
import { historyWindow, type HistoryPeriod } from '../history/window.js';

export interface ReceivedQuery { metric: 'count' | 'amount' | 'list'; chains: ChainId[]; tokens: Token[]; period: HistoryPeriod }

/** Whole-message grammar. A read-only question must never swallow a payment/cancellation instruction. */
export function parseReceivedQuery(text: string): ReceivedQuery | null {
  if (text.length > 500) return null;
  let rest = text.toLowerCase().replace(/[’‘]/g, "'").replace(/\b(?:recieve|recieved|received|receiving)\b/g, 'receive').replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '');
  if (!/\b(?:receive|incoming)\b/.test(rest) && !/\b(?:payment|transaction) history\b/.test(rest)) return null;
  const metric = /\bhow many\b|\b(?:number|count) of\b/.test(rest) ? 'count' : /\bhow much\b|\b(?:amount|total)\b/.test(rest) ? 'amount' : /\b(?:show|list|history)\b/.test(rest) ? 'list' : null;
  if (metric === null || (metric === 'count' && !/\b(?:transactions?|payments?|transfers?)\b/.test(rest))) return null;
  let period: HistoryPeriod = { kind: 'rolling', hours: 168 };
  let periods = 0;
  rest = rest.replace(/\b(this week|today|yesterday|(?:last|past|previous)\s+(?:(?:[0-9]+|one|two|three|four|five|six|seven|a)\s+)?(?:hours?|days?|weeks?|months?|years?)|this month|all time)\b/g, (phrase) => {
    periods++;
    if (phrase === 'this week') period = { kind: 'week' };
    else if (phrase === 'today' || phrase === 'yesterday') period = { kind: phrase };
    else if (phrase === 'last week' || phrase === 'past week') period = { kind: 'rolling', hours: 168 };
    else {
      const rolling = phrase.match(/^(?:last|past)\s+([0-9]+|one|two|three|four|five|six|seven|a)\s+(hours?|days?|week)$/);
      const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1 };
      period = rolling ? { kind: 'rolling', hours: (words[rolling[1]!] ?? Number(rolling[1])) * (rolling[2]!.startsWith('day') ? 24 : rolling[2] === 'week' ? 168 : 1) } : { kind: 'unsupported' };
    }
    return ' ';
  });
  if (periods > 1) period = { kind: 'unsupported' };
  const chains: ChainId[] = [];
  for (const [chain, pattern] of [
    [84532, /\bbase(?: sepolia)?\b/g], [421614, /\b(?:arbitrum(?: sepolia)?|arbi|arb)\b/g],
    [11155111, /\b(?:ethereum sepolia|eth sepolia|sepolia)\b/g],
  ] as const) rest = rest.replace(pattern, () => { if (!chains.includes(chain)) chains.push(chain); return ' '; });
  const tokens: Token[] = [];
  for (const [token, pattern] of [['USDC', /\b(?:usdc|usd coin)\b/g], ['ETH', /\b(?:eth|ether)\b/g]] as const)
    rest = rest.replace(pattern, () => { if (!tokens.includes(token)) tokens.push(token); return ' '; });
  rest = rest.replace(/\b(?:please|can|could|would|you|show|list|tell|give|check|me|what|is|was|are|how|many|much|number|count|of|amount|total|did|do|have|has|i|my|the|wallet|account|metamask|receive|incoming|transactions?|payments?|transfers?|history|for|over|during|so|far|on|in|across|all|networks?|chains?|and)\b/g, '');
  if (rest.trim()) return null;
  return { metric, chains, tokens: tokens.length ? tokens : ['ETH', 'USDC'], period };
}

export function usableHistory(snapshot: ChainHistory | undefined, address: Address, fromMs: number, nowMs: number): snapshot is ChainHistory {
  return snapshot !== undefined && snapshot.status === 'ok' && snapshot.address.toLowerCase() === address.toLowerCase() &&
    snapshot.fromMs <= fromMs && snapshot.throughMs >= fromMs && snapshot.throughMs <= nowMs &&
    nowMs - snapshot.throughMs <= HISTORY_MAX_AGE_MS;
}

export function renderReceivedQuery(query: ReceivedQuery, options: {
  address: Address; chains: readonly ChainConfig[]; now: DateTime; history?: HistoryReader;
}): string {
  const { now, history, address } = options;
  const window = historyWindow(query.period, now);
  if (!window) return 'I can show received-payment history only within the last 7 days (168 hours). Ask for today, yesterday, this week, or the last 1–7 days; I will not fetch older records.';
  const chains = options.chains.filter((chain) => !query.chains.length || query.chains.includes(chain.chain_id));
  if (!chains.length) return 'That network is not enabled in this session.';
  const lines = [window.label];
  const totals: Record<Token, bigint> = { ETH: 0n, USDC: 0n };
  let count = 0;
  let readable = 0;
  const listed: Array<{ name: string; hash: string; time: number; amounts: Record<Token, bigint> }> = [];
  for (const chain of chains) {
    const snapshot = history?.snapshot(chain.chain_id);
    if (!usableHistory(snapshot, address, window.fromMs, now.toMillis())) {
      lines.push(`${chain.name}: received-payment history is unavailable or still syncing.`);
      continue;
    }
    readable++;
    const txs = new Set<string>();
    const seen = new Set<string>();
    const amounts: Record<Token, bigint> = { ETH: 0n, USDC: 0n };
    const perTx = new Map<string, { time: number; amounts: Record<Token, bigint> }>();
    for (const transfer of snapshot.transfers) {
      if (transfer.timestampMs < window.fromMs || transfer.timestampMs > Math.min(snapshot.throughMs, window.throughMs) ||
          transfer.to.toLowerCase() !== address.toLowerCase() || transfer.from.toLowerCase() === address.toLowerCase() ||
          transfer.units <= 0n || !query.tokens.includes(transfer.token) || seen.has(transfer.id)) continue;
      seen.add(transfer.id);
      txs.add(transfer.hash.toLowerCase());
      amounts[transfer.token] += transfer.units;
      const item = perTx.get(transfer.hash.toLowerCase()) ?? { time: transfer.timestampMs, amounts: { ETH: 0n, USDC: 0n } };
      item.amounts[transfer.token] += transfer.units;
      perTx.set(transfer.hash.toLowerCase(), item);
    }
    for (const [hash, item] of perTx) listed.push({ name: chain.name, hash, ...item });
    count += txs.size;
    for (const token of query.tokens) totals[token] += amounts[token];
    const value = query.metric !== 'amount' ? `${txs.size} incoming transaction${txs.size === 1 ? '' : 's'}` : query.tokens.map((t) => `${fromBaseUnits(amounts[t], TOKEN_DECIMALS[t])} ${t}`).join(' and ');
    lines.push(`${chain.name}: ${value}; history checked ${DateTime.fromMillis(snapshot.throughMs, { zone: now.zoneName! }).toFormat('d LLL, HH:mm')}.`);
  }
  if (!readable) {
    lines.push('I cannot calculate received totals from your balance or outgoing spend log. An account-history source must be enabled and synced first.');
  } else {
    const label = readable === chains.length ? 'Total' : 'Subtotal for available networks only';
    if (query.metric !== 'amount') lines.push(`${label}: ${count} distinct incoming transaction${count === 1 ? '' : 's'}.`);
    else lines.push(`${label}: ${query.tokens.map((t) => `${fromBaseUnits(totals[t], TOKEN_DECIMALS[t])} ${t}`).join(' and ')} received.`);
    if (query.metric === 'list') {
      listed.sort((a, b) => b.time - a.time);
      for (const item of listed.slice(0, 20)) lines.push(`${DateTime.fromMillis(item.time, { zone: now.zoneName! }).toFormat('d LLL, HH:mm')} · ${item.name} · ${query.tokens.filter((t) => item.amounts[t] > 0n).map((t) => `${fromBaseUnits(item.amounts[t], TOKEN_DECIMALS[t])} ${t}`).join(' and ')} · ${item.hash}`);
      if (listed.length > 20) lines.push(`Showing the 20 most recent of ${listed.length} incoming transactions in this range. Narrow the time range to see fewer results.`);
    }
    lines.push(`Counts successful, nonzero incoming ${query.tokens.join('/')} transfers, including contract transfers; self-transfers and other assets are excluded. Multiple transfers in one transaction count once per network. These are indexed receipts, not a finality guarantee.`);
  }
  return lines.join('\n');
}
