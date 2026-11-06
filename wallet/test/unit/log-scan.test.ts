import { describe, expect, it, vi } from 'vitest';
import { erc20Abi, getAbiItem } from 'viem';
import { scanLogs } from '../../src/autopay/scan.js';
import { ChainUnavailableError, LogRangeLimitError } from '../../src/chain/gateway.js';
import { FakeChain } from '../support/fake-chain.js';
import { WALLET } from '../support/envelopes.js';

const query = { address: WALLET, event: getAbiItem({ abi: erc20Abi, name: 'Transfer' }), fromBlock: 100, toBlock: 124 };
describe('provider log range limits', () => {
  it('learns a stated limit, covers every block once, and reuses the limit on the next scan', async () => {
    const gateway = new FakeChain();
    const accepted: number[][] = [];
    const read = vi.spyOn(gateway, 'getLogs').mockImplementation(async (q) => {
      if (q.toBlock - q.fromBlock + 1 > 10) throw new LogRangeLimitError(10);
      accepted.push([q.fromBlock, q.toBlock]);
      return [];
    });
    expect(await scanLogs(gateway, query)).toEqual([]);
    expect(accepted).toEqual([
      [100, 109],
      [110, 119],
      [120, 124],
    ]);
    expect(read).toHaveBeenCalledTimes(4);
    read.mockClear();
    await scanLogs(gateway, { ...query, fromBlock: 125, toBlock: 130 });
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('bisects an unspecified range rejection without gaps or duplicates', async () => {
    const gateway = new FakeChain();
    const blocks: number[] = [];
    vi.spyOn(gateway, 'getLogs').mockImplementation(async (q) => {
      if (q.toBlock - q.fromBlock + 1 > 3) throw new LogRangeLimitError();
      for (let n = q.fromBlock; n <= q.toBlock; n++) blocks.push(n);
      return [];
    });
    await scanLogs(gateway, query);
    expect(blocks).toEqual(Array.from({ length: 25 }, (_, i) => 100 + i));
  });
  it('does not fan out an outage into smaller requests', async () => {
    const gateway = new FakeChain();
    const read = vi.spyOn(gateway, 'getLogs').mockRejectedValue(new ChainUnavailableError());
    await expect(scanLogs(gateway, query)).rejects.toBeInstanceOf(ChainUnavailableError);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('stops when even one block is rejected', async () => {
    const gateway = new FakeChain();
    const read = vi.spyOn(gateway, 'getLogs').mockRejectedValue(new LogRangeLimitError(1));
    await expect(scanLogs(gateway, { ...query, toBlock: 100 })).rejects.toBeInstanceOf(LogRangeLimitError);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
