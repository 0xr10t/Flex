import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, parseEther, toFunctionSelector } from 'viem';
import { bridgeHandler } from '../../src/bridge/bridge-j.js';
import type { HandlerContext } from '../../src/runner/handler.js';
import { WALLET, bridge } from '../support/envelopes.js';

describe('CCIP lane preflight', () => {
  it('rejects an unsupported lane before any fee quote or transaction preparation', async () => {
    const call = vi.fn().mockResolvedValue(encodeAbiParameters([{ type: 'bool' }], [false]));
    const ctx = { walletAddress: WALLET, gateway: { call } } as unknown as HandlerContext;
    await expect(bridgeHandler.plan(ctx, bridge(0, '1', []))).resolves.toEqual({
      kind: 'finished',
      outcome: { status: 'failed', error_code: 'BRIDGE_ROUTE_UNAVAILABLE' },
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![1].slice(0, 10)).toBe(toFunctionSelector('isChainSupported(uint64)'));
  });

  it('propagates an unavailable support check instead of guessing that the lane exists', async () => {
    const call = vi.fn().mockRejectedValue(new Error('offline'));
    const ctx = { walletAddress: WALLET, gateway: { call } } as unknown as HandlerContext;
    await expect(bridgeHandler.plan(ctx, bridge(0, '1', []))).rejects.toThrow('offline');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('still rejects a fee above the approved ceiling after support is confirmed', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(encodeAbiParameters([{ type: 'bool' }], [true]))
      .mockResolvedValueOnce(encodeAbiParameters([{ type: 'uint256' }], [parseEther('0.0031')]));
    const ctx = { walletAddress: WALLET, gateway: { call } } as unknown as HandlerContext;
    const intent = { ...bridge(0, '1', []), fee_max_eth: '0.003' };
    await expect(bridgeHandler.plan(ctx, intent)).resolves.toEqual({
      kind: 'finished',
      outcome: { status: 'failed', error_code: 'FEE_TOO_HIGH' },
    });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
