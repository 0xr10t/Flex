// Public RPCs limit how many blocks one log query can cover, so long ranges go in pieces (OQ-15, provisional).

import { LogRangeLimitError, type ChainGateway, type ChainLog, type LogQuery } from '../chain/gateway.js';

export const SCAN_BLOCKS = 2000;
const learnedLimits = new WeakMap<ChainGateway, number>();

export async function scanLogs(gateway: ChainGateway, query: LogQuery, chunk = SCAN_BLOCKS): Promise<ChainLog[]> {
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error('invalid log scan size');
  const logs: ChainLog[] = [];
  let size = Math.min(chunk, learnedLimits.get(gateway) ?? chunk);
  for (let from = query.fromBlock; from <= query.toBlock;) {
    const to = Math.min(from + size - 1, query.toBlock);
    try {
      logs.push(...(await gateway.getLogs({ ...query, fromBlock: from, toBlock: to })));
      from = to + 1;
    } catch (error) {
      // Shrink only for an explicit range rejection. Authentication, rate limits and outages propagate normally.
      if (!(error instanceof LogRangeLimitError) || from === to) throw error;
      size = Math.max(1, Math.min(size - 1, error.maxBlocks ?? Math.floor((to - from + 1) / 2)));
      learnedLimits.set(gateway, size);
    }
  }
  return logs;
}
