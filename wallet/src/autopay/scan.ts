// Public RPCs limit how many blocks one log query can cover, so long ranges go in pieces (OQ-15, provisional).

import type { ChainGateway, ChainLog, LogQuery } from '../chain/gateway.js';

export const SCAN_BLOCKS = 2000;

export async function scanLogs(gateway: ChainGateway, query: LogQuery, chunk = SCAN_BLOCKS): Promise<ChainLog[]> {
  const logs: ChainLog[] = [];
  for (let from = query.fromBlock; from <= query.toBlock; from += chunk) {
    logs.push(
      ...(await gateway.getLogs({ ...query, fromBlock: from, toBlock: Math.min(from + chunk - 1, query.toBlock) })),
    );
  }
  return logs;
}
