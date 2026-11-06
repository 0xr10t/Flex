// Read-only, bounded discovery for the local CRE runner. No signing or transaction methods exist here.
import { decodeEventLog, keccak256, parseAbi, toEventSelector } from 'viem';
export const EVENTS = parseAbi([
  'event Registered(bytes32 indexed intentId,address indexed delegator,uint64 startAt,uint64 interval,uint64 lateWindow,uint64 maxRuns,bytes redeem)',
  'event Executed(bytes32 indexed intentId,uint64 slot,uint64 paid)',
  'event Cancelled(bytes32 indexed intentId,address indexed delegator)',
]);
const topics = EVENTS.map(toEventSelector);
const hex = (n) => `0x${BigInt(n).toString(16)}`;

export function rpcClient(url, fetcher = globalThis.fetch, signal) {
  return async (method, params) => {
    let response;
    let http;
    try {
      http = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: signal
          ? globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(20_000)])
          : globalThis.AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      // Some providers return JSON-RPC range rejections with HTTP 400.
      if (!http.ok && http.status !== 400) throw new Error('RPC_UNAVAILABLE');
      response = await http.json();
    } catch {
      throw new Error('RPC_UNAVAILABLE');
    }
    if (response?.jsonrpc !== '2.0' || response.id !== 1)
      throw new Error(http.ok ? 'RPC_INVALID_RESPONSE' : 'RPC_UNAVAILABLE');
    if (response.error) {
      // Inspect remote text internally; never surface credentials that providers may include in their errors.
      if (
        method === 'eth_getLogs' &&
        [-32600, -32602, -32000, -32005].includes(response.error.code) &&
        /block.{0,30}range|range.{0,30}block|limited to.{0,20}blocks/i.test(String(response.error.message))
      )
        throw new Error('RPC_LOG_RANGE');
      throw new Error(http.ok ? 'RPC_REJECTED' : 'RPC_UNAVAILABLE');
    }
    if (!http.ok) throw new Error('RPC_UNAVAILABLE');
    if (!Object.hasOwn(response, 'result')) throw new Error('RPC_INVALID_RESPONSE');
    return response.result;
  };
}

function header(value) {
  if (!value || !/^0x[0-9a-f]+$/i.test(value.number) || !/^0x[0-9a-f]{64}$/i.test(value.hash))
    throw new Error('RPC_INVALID_HEADER');
  return { number: BigInt(value.number), hash: value.hash.toLowerCase() };
}

export function applyLogs(plans, logs, executor, from, to) {
  const next = new Map(plans.map((p) => [p.id.toLowerCase(), { ...p }]));
  if (!Array.isArray(logs)) throw new Error('RPC_INVALID_LOGS');
  const sorted = [...logs].sort((a, b) => {
    const block = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    return block === 0n ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : block < 0n ? -1 : 1;
  });
  for (const log of sorted) {
    if (
      log.removed ||
      log.address?.toLowerCase() !== executor.toLowerCase() ||
      BigInt(log.blockNumber) < from ||
      BigInt(log.blockNumber) > to
    )
      throw new Error('RPC_INVALID_LOGS');
    const event = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics });
    const id = event.args.intentId.toLowerCase();
    if (event.eventName === 'Registered') {
      const { startAt, interval, lateWindow, maxRuns, redeem } = event.args;
      if (keccak256(redeem).toLowerCase() !== id || next.has(id)) throw new Error('INVALID_PLAN_EVENT');
      next.set(id, {
        id,
        startAt: String(startAt),
        interval: String(interval),
        lateWindow: String(lateWindow),
        maxRuns: String(maxRuns),
        redeem,
        lastSlot: '-1',
        cancelled: false,
      });
    } else if (event.eventName === 'Cancelled') next.delete(id);
    else {
      const plan = next.get(id);
      if (plan && event.args.slot > BigInt(plan.lastSlot)) plan.lastSlot = String(event.args.slot);
    }
  }
  return [...next.values()];
}

/** Incremental finalized scan. On outage/catch-up the caller saves progress but does NOT invoke CRE with a partial index. */
export async function indexPlans(chain, cached, rpc, { maxPages = 200, onCheckpoint = async () => {} } = {}) {
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) throw new Error('INVALID_SCAN_BUDGET');
  if (BigInt(await rpc('eth_chainId', [])) !== BigInt(chain.chainId)) throw new Error('RPC_WRONG_CHAIN');
  const head = header(await rpc('eth_getBlockByNumber', ['finalized', false]));
  const deployment = BigInt(chain.deploymentBlock);
  if (deployment > head.number) throw new Error('EXECUTOR_NOT_FINALIZED');
  const key = `${chain.chainId}:${chain.executor.toLowerCase()}:${deployment}`;
  let state = cached?.key === key ? cached : null;
  if (state) {
    const current = await rpc('eth_getBlockByNumber', [hex(state.snapshot.blockNumber), false]);
    if (
      !current ||
      header(current).hash !== state.snapshot.blockHash.toLowerCase() ||
      BigInt(state.snapshot.blockNumber) > head.number
    )
      state = null;
  }
  let from = state ? BigInt(state.snapshot.blockNumber) + 1n : deployment;
  let plans = state ? state.snapshot.plans : [];
  let range = BigInt(state?.range ?? 2000);
  if (range < 1n || range > 2000n) range = 2000n;
  let pages = 0;
  while (from <= head.number && pages < maxPages) {
    const to = from + range - 1n > head.number ? head.number : from + range - 1n;
    pages++;
    let logs;
    try {
      logs = await rpc('eth_getLogs', [
        { address: chain.executor, topics: [topics], fromBlock: hex(from), toBlock: hex(to) },
      ]);
    } catch (error) {
      if (error.message !== 'RPC_LOG_RANGE' || range === 1n) throw error;
      range = range > 10n ? 10n : range / 2n;
      continue;
    }
    const next = applyLogs(plans, logs, chain.executor, from, to);
    const checkpoint = header(await rpc('eth_getBlockByNumber', [hex(to), false]));
    if (checkpoint.number !== to) throw new Error('RPC_INVALID_HEADER');
    // Re-check the pinned finalized head before committing each checkpoint.
    if (header(await rpc('eth_getBlockByNumber', [hex(head.number), false])).hash !== head.hash)
      throw new Error('DISCOVERY_REORG');
    state = {
      key,
      range: Number(range),
      snapshot: { blockNumber: String(to), blockHash: checkpoint.hash, plans: next },
    };
    await onCheckpoint(state);
    plans = next;
    from = to + 1n;
  }
  return { state, caughtUp: from > head.number, pages, finalizedBlock: String(head.number) };
}
