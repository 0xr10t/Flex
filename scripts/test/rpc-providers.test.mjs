import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv } from 'node:util';
import { URL } from 'node:url';
import { discover, probe, providerOf, updatedEnv } from '../configure-rpc-providers.mjs';

const ok = (value) => ({ ok: true, json: async () => value });

test('Infura URLs use the documented testnet networks', async () => {
  const result = await discover({ INFURA_API_KEY: 'test-key' }, async () => {
    throw new Error('Unexpected request');
  });
  assert.deepEqual(
    result.candidates.filter((c) => c.provider === 'infura').map((c) => new URL(c.url).hostname),
    ['sepolia.infura.io', 'base-sepolia.infura.io', 'arbitrum-sepolia.infura.io'],
  );
});

test('provider endpoints reject credential forwarding to lookalike domains and insecure URLs', () => {
  for (const url of [
    'http://x.quiknode.pro/key',
    'https://quiknode.pro.evil.test/key',
    'https://x.chainstack.com@evil.test/key',
    'https://x.chainstack.com:8443/key',
    'https://x.quiknode.pro/key#fragment',
  ])
    assert.equal(providerOf(url), null);
  assert.equal(providerOf('https://eth-sepolia.g.alchemy.com/v2/test'), 'alchemy');
});

test('discovery consumes keys opaquely and ignores foreign endpoint URLs', async () => {
  const seen = [];
  const result = await discover(
    { ALCHEMY_API_KEY: 'test-only', QUICKNODE_API_KEY: 'test-admin' },
    async (url, init) => {
      seen.push({ url, init });
      return ok({
        data: [
          { status: 'active', network: 'ethereum-sepolia', http_url: 'https://evil.test/stolen' },
          { status: 'active', network: 'base-sepolia', http_url: 'https://test.base-sepolia.quiknode.pro/test/' },
        ],
      });
    },
  );
  assert.equal(result.candidates.length, 7);
  assert.equal(result.candidates.filter((c) => c.provider === 'quicknode').length, 1);
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers['x-api-key'], 'test-admin');
  assert.equal(JSON.stringify(result.status).includes('test-admin'), false);
});

test('management response pagination cannot send a credential to a foreign server', async () => {
  const origins = [];
  const result = await discover({ CHAINSTACK_API_KEY: 'test-admin' }, async (url, init) => {
    origins.push(new URL(url).origin);
    assert.equal(init.redirect, 'error');
    return ok({ results: [], next: origins.length === 1 ? 'https://evil.test/' : null });
  });
  assert.deepEqual(origins, ['https://api.chainstack.com', 'https://api.chainstack.com']);
  assert.equal(
    result.candidates.every((c) => c.provider === 'publicnode'),
    true,
  );
});

test('provider errors never expose response bodies or exception messages', async () => {
  const result = await discover(
    { QUICKNODE_API_KEY: 'test-secret', CHAINSTACK_API_KEY: 'test-secret' },
    async (url) => {
      if (url.includes('quicknode')) throw new Error('secret echoed: test-secret');
      return { ok: false, status: 401, json: async () => ({ error: 'test-secret' }) };
    },
  );
  assert.equal(JSON.stringify(result).includes('test-secret'), false);
  assert.equal(result.status.find((x) => x.provider === 'quicknode').result, 'NETWORK_OR_INVALID_JSON');
  assert.equal(result.status.find((x) => x.provider === 'chainstack').result, 'HTTP_401');
});

test('configuration writes preserve existing credentials and explicit operator configuration', () => {
  const original = 'TOKEN="two\nlines"\nSEPOLIA_RPC_URL=https://existing.test/key\nSEPOLIA_SIMULATION_RPC_URLS=[]\n';
  const updated = updatedEnv(original, {
    SEPOLIA_RPC_URL: 'https://replacement.test',
    SEPOLIA_SIMULATION_RPC_URLS: '["https://one.test","https://two.test"]',
  });
  assert.equal(parseEnv(updated).TOKEN, 'two\nlines');
  assert.equal(parseEnv(updated).SEPOLIA_RPC_URL, 'https://existing.test/key');
  assert.equal(JSON.parse(parseEnv(updated).SEPOLIA_SIMULATION_RPC_URLS).length, 2);
  assert.equal(updatedEnv(updated, { SEPOLIA_RPC_URL: 'https://replacement.test' }), updated);
  assert.throws(() => updatedEnv(original, { BAD: "cannot'escape" }));
});

const anchor = { number: '0x64', timestamp: '0x100', hash: `0x${'ab'.repeat(32)}` };
const zeroAddress = `0x${'00'.repeat(20)}`;
function simulationFetcher(mutator = () => {}) {
  return async (_url, init) => {
    const body = JSON.parse(init.body);
    if (!Array.isArray(body)) return ok({ result: anchor });
    const rows = [
      { id: 1, result: '0xaa36a7' },
      { id: 2, result: anchor },
      {
        id: 3,
        result: [
          {
            calls: [
              { status: '0x1', gasUsed: '0x5208', logs: [{ address: zeroAddress, topics: [], data: '0x' }] },
              {
                status: '0x1',
                gasUsed: '0x6000',
                logs: [],
                returnData: `0x${'2a'.padStart(64, '0')}${'101'.padStart(64, '0')}`,
              },
            ],
          },
        ],
      },
    ];
    mutator(rows);
    return ok(rows);
  };
}

test('qualification requires transfer tracing plus executed storage and time overrides', async () => {
  const candidate = { url: 'https://unused.test' };
  assert.equal((await probe(candidate, 11155111, anchor, simulationFetcher())).result, 'PASS');
  for (const mutate of [
    (rows) => {
      rows[2].result[0].calls[0].logs = [];
    },
    (rows) => {
      rows[2].result[0].calls[1].returnData = '0x';
    },
    (rows) => {
      rows[1].result = { ...anchor, hash: `0x${'cd'.repeat(32)}` };
    },
    (rows) => {
      rows[2].id = 1;
    },
  ])
    assert.notEqual((await probe(candidate, 11155111, anchor, simulationFetcher(mutate))).result, 'PASS');
});
