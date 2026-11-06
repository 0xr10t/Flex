// Privacy fix 3 in the wallet: viem never follows an offchain lookup, which would fetch a URL outside the RPC.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { encodeErrorResult, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainGateway } from '../../src/chain/gateway.js';
import { BASE } from '../support/envelopes.js';

afterEach(() => vi.restoreAllMocks());

describe('privacy fix 3: the chain gateway never follows CCIP-Read', () => {
  it('a call answered with an offchain lookup fails, and no gateway URL is fetched', async () => {
    const target = '0x000000000000000000000000000000000000c0de' as Hex;
    const revert = encodeErrorResult({
      abi: [
        {
          type: 'error',
          name: 'OffchainLookup',
          inputs: [
            { name: 'sender', type: 'address' },
            { name: 'urls', type: 'string[]' },
            { name: 'callData', type: 'bytes' },
            { name: 'callbackFunction', type: 'bytes4' },
            { name: 'extraData', type: 'bytes' },
          ],
        },
      ],
      errorName: 'OffchainLookup',
      args: [target, ['https://gateway.attacker.invalid/{sender}/{data}'], '0x', '0x12345678', '0x'],
    });
    const methods: string[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        const body = JSON.parse(raw) as { id: number; method: string };
        methods.push(body.method);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: 3, message: 'execution reverted', data: revert },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const realFetch = globalThis.fetch;
    const outside: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const u = String(input instanceof Request ? input.url : input);
      if (!u.startsWith(url)) outside.push(u);
      return realFetch(input, init);
    });
    try {
      const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
      const gateway = createChainGateway(BASE, url, account);
      await expect(gateway.call(target, '0x12345678')).rejects.toThrow();
      expect(outside).toEqual([]);
      expect(methods).toEqual(['eth_call']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
