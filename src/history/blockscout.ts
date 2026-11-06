// Blockscout API v2 address history: external ETH, internal ETH and the configured USDC contract.
// Configured endpoints only; pagination never supplies a URL. This is informational indexer data, not execution proof.
import type { Address, ChainId, Config } from '../contracts/types.js';
import { isolatedFetch } from '../util/isolated-fetch.js';
import type { HistorySource, ReceivedTransfer } from './types.js';
import { HISTORY_LOOKBACK_MS } from './types.js';

const MAX_PAGES = 50;
const MAX_REQUESTS = 200;
const MAX_BYTES = 2 * 1024 * 1024;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CURSOR_FIELDS = new Set(['block_number', 'index', 'items_count', 'transaction_index']);
type Row = Record<string, unknown>;
type Kind = 'transactions' | 'internal-transactions' | 'token-transfers';

function object(value: unknown): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid history');
  return value as Row;
}
function hash(value: unknown): `0x${string}` {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('invalid history hash');
  return value.toLowerCase() as `0x${string}`;
}
function address(value: unknown): Address {
  const raw = object(value).hash;
  if (typeof raw !== 'string' || !ADDRESS.test(raw)) throw new Error('invalid history address');
  return raw.toLowerCase() as Address;
}
function units(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('invalid history amount');
  return BigInt(value);
}
function index(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid history index');
  return value;
}
function timestamp(value: unknown): number {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('invalid history time');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('invalid history time');
  return ms;
}
function successful(tx: Row): boolean {
  if (tx.status === 'error') return false;
  if (tx.status !== 'ok') throw new Error('unconfirmed history');
  return true;
}

export function createBlockscoutSource(
  config: Config,
  fetcher = isolatedFetch({
    proxy: config.network.socks_proxy,
    isolation: 'history',
  }),
): HistorySource {
  return {
    async read(chainId: ChainId, fromMs: number, throughMs: number, signal: AbortSignal): Promise<ReceivedTransfer[]> {
      if (
        !Number.isSafeInteger(fromMs) ||
        !Number.isSafeInteger(throughMs) ||
        throughMs < fromMs ||
        throughMs - fromMs > HISTORY_LOOKBACK_MS
      )
        throw new Error('history is limited to seven days');
      const source = config.history?.enabled && config.history.sources.find((s) => s.chain_id === chainId);
      const chain = config.chains.find((c) => c.chain_id === chainId);
      if (!source || !chain) throw new Error('history not configured');
      const base = source.api_url.replace(/\/$/, '');
      const legacyBase = base.replace(/\/v2$/, '');
      const wallet = config.wallet.address.toLowerCase();
      const usdc = chain.usdc_address.toLowerCase();
      const controller = new AbortController();
      const abort = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(90_000)]);
      let requests = 0;

      const get = async (url: URL): Promise<Row> => {
        if (++requests > MAX_REQUESTS) throw new Error('history request limit');
        const response = await fetcher(url, {
          signal: AbortSignal.any([abort, AbortSignal.timeout(10_000)]),
          redirect: 'error',
          headers: { accept: 'application/json' },
        });
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error('history unavailable');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.length;
            if (size > MAX_BYTES) throw new Error('history response too large');
            chunks.push(next.value);
          }
          return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      };

      const parents = new Map<string, Promise<Row>>();
      const parent = (txHash: string): Promise<Row> => {
        let result = parents.get(txHash);
        if (!result) {
          result = get(new URL(`${base}/transactions/${txHash}`)).then((tx) => {
            if (hash(tx.hash) !== txHash) throw new Error('mismatched history transaction');
            const ms = timestamp(tx.timestamp);
            if (ms < fromMs || ms > throughMs) throw new Error('history outside requested window');
            return tx;
          });
          parents.set(txHash, result);
        }
        return result;
      };

      const legacyUrl = (params: Record<string, string>): URL => {
        const url = new URL(legacyBase);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        return url;
      };
      // The address-list v2 API has no time-bound filter. Use bounded legacy discovery first; only then inspect
      // individual public transactions from that interval with v2. Never page backward through all account history.
      const bound = async (ms: number, closest: 'before' | 'after'): Promise<bigint> => {
        const reply = await get(
          legacyUrl({
            module: 'block',
            action: 'getblocknobytime',
            timestamp: String(closest === 'after' ? Math.ceil(ms / 1000) : Math.floor(ms / 1000)),
            closest,
          }),
        );
        if (reply.status !== '1') throw new Error('history time bounds unavailable');
        return units(typeof reply.result === 'string' ? reply.result : object(reply.result).blockNumber);
      };
      const discover = async (kind: Kind, startBlock: bigint, endBlock: bigint): Promise<string[]> => {
        const action =
          kind === 'transactions' ? 'txlist' : kind === 'internal-transactions' ? 'txlistinternal' : 'tokentx';
        const found = new Set<string>();
        const pages = new Set<string>();
        const pageSize = 100;
        for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
          const body = await get(
            legacyUrl({
              module: 'account',
              action,
              address: wallet,
              startblock: String(startBlock),
              endblock: String(endBlock),
              start_timestamp: String(Math.ceil(fromMs / 1000)),
              end_timestamp: String(Math.floor(throughMs / 1000)),
              page: String(pageNumber),
              offset: String(pageSize),
              sort: 'desc',
              ...(kind === 'token-transfers' ? { contractaddress: usdc } : {}),
            }),
          );
          if (!Array.isArray(body.result)) throw new Error('invalid history discovery');
          if (
            body.status === '0' &&
            body.result.length === 0 &&
            ['No transactions found', 'No internal transactions found', 'No token transfers found'].includes(
              String(body.message),
            )
          )
            return [...found];
          if (body.status !== '1' || body.result.length > pageSize) throw new Error('history discovery unavailable');
          const fingerprint = JSON.stringify(body.result);
          if (pages.has(fingerprint)) throw new Error('repeated history page');
          pages.add(fingerprint);
          for (const item of body.result) {
            const row = object(item);
            const ms = Number(units(row.timeStamp)) * 1000;
            const block = units(row.blockNumber);
            if (!Number.isSafeInteger(ms) || ms < fromMs || ms > throughMs || block < startBlock || block > endBlock)
              throw new Error('history outside requested window');
            if (typeof row.to !== 'string' || typeof row.from !== 'string')
              throw new Error('invalid history discovery address');
            if (row.to.toLowerCase() !== wallet || row.from.toLowerCase() === wallet || units(row.value) === 0n)
              continue;
            found.add(hash(kind === 'internal-transactions' ? row.transactionHash : row.hash));
          }
          if (body.result.length < pageSize) return [...found];
        }
        throw new Error('history page limit');
      };

      const readPages = async (kind: Kind, txHash: string): Promise<ReceivedTransfer[]> => {
        const tx = await parent(txHash);
        if (!successful(tx)) return [];
        const endpoint = new URL(`${base}/transactions/${txHash}/${kind}`);
        if (kind === 'token-transfers') endpoint.searchParams.set('type', 'ERC-20');
        let url = endpoint;
        let previousTime = Infinity;
        const cursors = new Set<string>();
        const transfers = new Map<string, ReceivedTransfer>();
        for (let page = 0; page < MAX_PAGES; page++) {
          const body = kind === 'transactions' ? { items: [tx], next_page_params: null } : await get(url);
          if (!Array.isArray(body.items) || body.items.length > 1000 || !('next_page_params' in body))
            throw new Error('invalid history page');
          // Blockscout reports incomplete internal indexing via meta.status=2. Never report a partial page as complete.
          if (body.meta !== undefined && object(body.meta).status !== 1) throw new Error('history still indexing');
          for (const value of body.items) {
            const row = object(value);
            if (kind === 'transactions' && row.status === null && row.block_number === null) continue; // pending
            const ms = timestamp(row.timestamp);
            if (ms > previousTime) throw new Error('unordered history');
            previousTime = ms;
            if (ms < fromMs || ms > throughMs) throw new Error('history outside requested window');
            const to = address(row.to);
            const from = address(row.from);
            if (to !== wallet || from === wallet) continue;
            if (hash(kind === 'transactions' ? row.hash : row.transaction_hash) !== txHash)
              throw new Error('mismatched history transaction');
            let token: 'USDC' | 'ETH' = 'ETH';
            let amount: bigint;
            let suffix: string;
            if (kind === 'token-transfers') {
              const contract = object(row.token);
              if (typeof contract.address_hash !== 'string') throw new Error('invalid history token');
              if (contract.address_hash.toLowerCase() !== usdc || contract.type !== 'ERC-20') continue;
              const total = object(row.total);
              if (total.decimals !== '6') throw new Error('unexpected history decimals');
              amount = units(total.value);
              token = 'USDC';
              suffix = String(index(row.log_index));
            } else {
              amount = units(row.value);
              suffix = kind === 'transactions' ? 'external' : String(index(row.index));
              if (kind === 'transactions' && !successful(row)) continue;
              if (kind === 'internal-transactions') {
                if (row.success === false) continue;
                if (row.success !== true) throw new Error('unknown internal status');
                if (row.type === 'delegatecall' || row.type === 'callcode' || row.type === 'staticcall') continue;
                if (!['call', 'create', 'create2', 'selfdestruct', 'suicide'].includes(String(row.type)))
                  throw new Error('unknown internal transfer');
              }
            }
            if (amount === 0n) continue;
            // A successful inner call does not prove its outer transaction committed.
            if (kind !== 'transactions') {
              const tx = await parent(txHash);
              if (!successful(tx)) continue;
              if (timestamp(tx.timestamp) !== ms) throw new Error('history timestamp mismatch');
              // Some indexers expose the top-level value again as trace zero.
              if (
                kind === 'internal-transactions' &&
                row.index === 0 &&
                tx.to !== null &&
                address(tx.from) === from &&
                address(tx.to) === to &&
                units(tx.value) === amount
              )
                continue;
            }
            const id = `${kind}:${txHash}:${suffix}`;
            const transfer = { id, hash: txHash, from, to, token, units: amount, timestampMs: ms };
            const existing = transfers.get(id);
            if (existing && (existing.units !== amount || existing.timestampMs !== ms || existing.from !== from))
              throw new Error('conflicting history duplicate');
            transfers.set(id, transfer);
          }
          if (body.next_page_params === null) return [...transfers.values()];
          const cursor = object(body.next_page_params);
          if (!Object.keys(cursor).length || !body.items.length) throw new Error('invalid history pagination');
          const next = new URL(endpoint);
          for (const [key, value] of Object.entries(cursor)) {
            if (!CURSOR_FIELDS.has(key) || !/^[0-9]{1,16}$/.test(String(value)))
              throw new Error('invalid history cursor');
            next.searchParams.set(key, String(value));
          }
          if (cursors.has(next.href)) throw new Error('repeated history page');
          cursors.add(next.href);
          url = next;
        }
        throw new Error('history page limit');
      };

      try {
        const [startBlock, endBlock] = await Promise.all([bound(fromMs, 'after'), bound(throughMs, 'before')]);
        if (startBlock > endBlock) return [];
        const results: ReceivedTransfer[] = [];
        for (const kind of ['transactions', 'internal-transactions', 'token-transfers'] as const) {
          const hashes = await discover(kind, startBlock, endBlock);
          for (const txHash of hashes) results.push(...(await readPages(kind, txHash)));
        }
        return results;
      } finally {
        controller.abort();
      }
    },
  };
}
