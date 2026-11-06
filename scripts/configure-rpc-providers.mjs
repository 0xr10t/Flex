// Read-only provider discovery and simulation probes. Credentials never enter output.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import process from 'node:process';
import console from 'node:console';
import { protectPrivateFile } from '../dist/src/util/private-file.js';
import { agreeSimulation, checkAnchor, parseSimulation } from '@flex/protocol/simulation';

export const networks = [
  { id: 11155111, name: 'SEPOLIA', alchemy: 'eth-sepolia', infura: 'sepolia', publicnode: 'ethereum-sepolia-rpc' },
  { id: 84532, name: 'BASE_SEPOLIA', alchemy: 'base-sepolia', infura: 'base-sepolia', publicnode: 'base-sepolia-rpc' },
  {
    id: 421614,
    name: 'ARBITRUM_SEPOLIA',
    alchemy: 'arb-sepolia',
    infura: 'arbitrum-sepolia',
    publicnode: 'arbitrum-sepolia-rpc',
  },
];
const suffixes = {
  alchemy: '.g.alchemy.com',
  quicknode: '.quiknode.pro',
  chainstack: '.chainstack.com',
  infura: '.infura.io',
  publicnode: '.publicnode.com',
};

export function providerOf(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash || (u.port && u.port !== '443')) return null;
    return Object.entries(suffixes).find(([, suffix]) => u.hostname.endsWith(suffix))?.[0] ?? null;
  } catch {
    return null;
  }
}

// Only controlled error codes are exposed. Remote errors can contain authenticated URLs.
async function jsonRequest(url, init = {}, fetcher = globalThis.fetch) {
  try {
    const response = await fetcher(url, { ...init, redirect: 'error', signal: globalThis.AbortSignal.timeout(15_000) });
    if (!response.ok) return { failure: `HTTP_${response.status}` };
    return { value: await response.json() };
  } catch {
    return { failure: 'NETWORK_OR_INVALID_JSON' };
  }
}

async function rpc(url, payload, fetcher) {
  const response = await jsonRequest(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    fetcher,
  );
  if (response.failure) throw new Error(response.failure);
  return response.value;
}
const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

export async function discover(env, fetcher = globalThis.fetch) {
  const candidates = [];
  const status = [];
  const add = (provider, value) => {
    if (providerOf(value) === provider && !candidates.some((c) => c.url === value))
      candidates.push({ provider, url: value });
  };
  for (const n of networks) {
    for (const provider of Object.keys(suffixes)) add(provider, env[`${provider.toUpperCase()}_${n.name}_RPC_URL`]);
    const value = env[`${n.name}_RPC_URL`];
    if (providerOf(value)) add(providerOf(value), value);
    try {
      const urls = JSON.parse(env[`${n.name}_SIMULATION_RPC_URLS`] || '[]');
      if (Array.isArray(urls)) for (const url of urls) if (providerOf(url)) add(providerOf(url), url);
    } catch {
      /* Existing malformed configuration is left untouched. */
    }
  }
  for (const provider of Object.keys(suffixes)) {
    if (provider === 'publicnode') {
      for (const n of networks) add(provider, `https://${n.publicnode}.publicnode.com`);
      continue;
    }
    const credential = env[`${provider.toUpperCase()}_API_KEY`]?.trim();
    if (!credential) {
      status.push({ provider, result: 'MISSING_CREDENTIAL_OR_URL' });
      continue;
    }
    if (providerOf(credential) === provider) {
      add(provider, credential);
      continue;
    }
    // Do not send an unknown URL or a different vendor's credential as an API key.
    if (/\s|:\/\//.test(credential)) {
      status.push({ provider, result: 'INVALID_CREDENTIAL_FORMAT' });
      continue;
    }
    if (provider === 'alchemy') {
      for (const n of networks)
        add(provider, `https://${n.alchemy}.g.alchemy.com/v2/${encodeURIComponent(credential)}`);
      continue;
    }
    if (provider === 'infura') {
      for (const n of networks) add(provider, `https://${n.infura}.infura.io/v3/${encodeURIComponent(credential)}`);
      continue;
    }
    if (provider === 'quicknode') {
      for (let offset = 0; offset < 1000; offset += 100) {
        const r = await jsonRequest(
          `https://api.quicknode.com/v0/endpoints?limit=100&offset=${offset}`,
          { headers: { 'x-api-key': credential } },
          fetcher,
        );
        if (r.failure) {
          status.push({ provider, result: r.failure });
          break;
        }
        if (!Array.isArray(r.value?.data)) {
          status.push({ provider, result: 'INVALID_ENDPOINT_LIST' });
          break;
        }
        for (const node of r.value.data) {
          if (node.status !== 'active') continue;
          if (/sepolia/i.test(node.network)) add(provider, node.http_url);
          if (node.is_multichain && /^[A-Za-z0-9_-]+$/.test(String(node.id))) {
            const urls = await jsonRequest(
              `https://api.quicknode.com/v0/endpoints/${encodeURIComponent(node.id)}/urls`,
              { headers: { 'x-api-key': credential } },
              fetcher,
            );
            if (urls.failure) {
              status.push({ provider, result: urls.failure });
              continue;
            }
            for (const [name, item] of Object.entries(urls.value?.data?.multichain_urls ?? {}))
              if (/sepolia/i.test(name)) add(provider, item.http_url);
          }
        }
        if (r.value.data.length < 100) break;
      }
    } else {
      for (let page = 1; page <= 10; page++) {
        const r = await jsonRequest(
          `https://api.chainstack.com/v2/nodes/?page=${page}`,
          { headers: { Authorization: `Bearer ${credential}` } },
          fetcher,
        );
        if (r.failure) {
          status.push({ provider, result: r.failure });
          break;
        }
        if (!Array.isArray(r.value?.results)) {
          status.push({ provider, result: 'INVALID_ENDPOINT_LIST' });
          break;
        }
        for (const node of r.value.results)
          if (node.status === 'running' && /sepolia/i.test(node.network)) add(provider, node.details?.https_endpoint);
        // Never follow an API-supplied URL with an authorization header.
        if (!r.value.next) break;
      }
    }
  }
  return { candidates, status };
}

const from = '0x0000000000000000000000000000000000001001';
const to = '0x0000000000000000000000000000000000001002';
const contract = '0x0000000000000000000000000000000000001003';
const word = (n) => `0x${n.toString(16).padStart(64, '0')}`;

export async function probe(candidate, chainId, anchor, fetcher = globalThis.fetch) {
  try {
    const time = BigInt(anchor.timestamp) + 1n;
    const payload = {
      traceTransfers: true,
      validation: false,
      blockStateCalls: [
        {
          blockOverrides: { time: `0x${time.toString(16)}` },
          stateOverrides: {
            [from]: { balance: '0xffffffffffffffff' },
            [contract]: { code: '0x6000546000524260205260406000f3', stateDiff: { [word(0n)]: word(42n) } },
          },
          calls: [
            { from, to, value: '0x1', gas: '0x186a0' },
            { from, to: contract, gas: '0x186a0' },
          ],
        },
      ],
    };
    const batch = await rpc(
      candidate.url,
      [
        request(1, 'eth_chainId', []),
        request(2, 'eth_getBlockByNumber', [anchor.number, false]),
        request(3, 'eth_simulateV1', [payload, anchor.number]),
      ],
      fetcher,
    );
    if (!Array.isArray(batch) || batch.length !== 3 || new Set(batch.map((x) => x.id)).size !== 3) throw new Error();
    const rows = new Map(batch.map((x) => [x.id, x]));
    if ([1, 2, 3].some((id) => !rows.has(id) || rows.get(id).error)) {
      const errors = [1, 2, 3]
        .filter((id) => rows.get(id)?.error)
        .map((id) => {
          const error = rows.get(id).error;
          const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
          return {
            request: id,
            code: Number.isSafeInteger(error.code) ? error.code : null,
            reason: /not supported|not available|does not exist|not found/.test(message)
              ? 'METHOD_UNAVAILABLE'
              : /upgrade|plan|payment|subscription/.test(message)
                ? 'PLAN_RESTRICTION'
                : /invalid|unsupported/.test(message)
                  ? 'PARAMETER_REJECTED'
                  : 'RPC_ERROR',
          };
        });
      return { result: 'BATCH_OR_SIMULATION_REJECTED', errors };
    }
    if (BigInt(rows.get(1).result) !== BigInt(chainId)) return { result: 'WRONG_CHAIN' };
    checkAnchor(rows.get(2).result, anchor);
    const raw = rows.get(3).result;
    const parsed = parseSimulation(raw, [2]);
    if (parsed[0].some((c) => c.status !== '0x1') || parsed[0][0].logs.length !== 1)
      return { result: 'TRANSFER_TRACE_MISSING' };
    if (raw[0].calls[1].returnData?.toLowerCase() !== word(42n) + word(time).slice(2))
      return { result: 'STATE_OR_TIME_OVERRIDE_FAILED' };
    const post = await rpc(candidate.url, request(4, 'eth_getBlockByNumber', [anchor.number, false]), fetcher);
    checkAnchor(post.result, anchor);
    return { result: 'PASS', observation: parsed };
  } catch {
    return { result: 'UNAVAILABLE_OR_INVALID_RESPONSE' };
  }
}

// Append only new/empty settings, preserving every existing assignment and comment.
export function updatedEnv(original, updates) {
  const before = parseEnv(original);
  const lines = [];
  for (const [name, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || /[\r\n']/.test(value)) throw new Error('Invalid generated setting');
    if (before[name]?.trim() && before[name].trim() !== '[]') continue;
    lines.push(`${name}='${value}'`);
  }
  const text = lines.length
    ? original.trimEnd() + '\n\n# Verified provider setup\n' + lines.join('\n') + '\n'
    : original;
  const after = parseEnv(text);
  for (const [name, value] of Object.entries(before))
    if (!(name in updates) && after[name] !== value) throw new Error('Existing setting changed');
  return text;
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (arg) => !['--two-provider-quorum', '--third-provider=infura', '--third-provider=publicnode'].includes(arg),
    ) ||
    args.length > 1
  )
    throw new Error('Unknown argument');
  const third = args.find((arg) => arg.startsWith('--third-provider='))?.split('=')[1] ?? 'chainstack';
  const providers = args.includes('--two-provider-quorum') ? ['alchemy', 'quicknode'] : ['alchemy', 'quicknode', third];
  const root = fileURLToPath(new URL('../', import.meta.url));
  const path = resolve(root, '.env');
  protectPrivateFile(path);
  const original = readFileSync(path, 'utf8');
  const env = { ...parseEnv(original), ...process.env };
  const { candidates, status } = await discover(env);
  for (const item of status) console.log(JSON.stringify(item));
  const verified = [];
  for (const c of candidates.filter((c) => providers.includes(c.provider))) {
    try {
      const r = await rpc(c.url, request(1, 'eth_chainId', []));
      const n = networks.find((n) => BigInt(n.id) === BigInt(r.result));
      if (n) verified.push({ ...c, network: n });
      else console.log(JSON.stringify({ provider: c.provider, result: 'NOT_A_TARGET_TESTNET' }));
    } catch {
      console.log(JSON.stringify({ provider: c.provider, result: 'CHAIN_ID_CHECK_FAILED' }));
    }
  }
  const updates = {};
  let ready = 0;
  for (const n of networks) {
    const nodes = providers.map((p) => verified.find((c) => c.network.id === n.id && c.provider === p)).filter(Boolean);
    if (!nodes.length) {
      console.log(JSON.stringify({ chain: n.name, result: 'NO_VERIFIED_ENDPOINT' }));
      continue;
    }
    updates[`${n.name}_RPC_URL`] = nodes[0].url;
    for (const c of nodes) updates[`${c.provider.toUpperCase()}_${n.name}_RPC_URL`] = c.url;
    let anchor;
    try {
      const head = await rpc(nodes[0].url, request(2, 'eth_getBlockByNumber', ['latest', false]));
      // A recent common parent reduces transient tip lag during capability qualification.
      const block = await rpc(
        nodes[0].url,
        request(3, 'eth_getBlockByNumber', [`0x${(BigInt(head.result.number) - 8n).toString(16)}`, false]),
      );
      anchor = block.result;
      checkAnchor(anchor, anchor);
    } catch {
      console.log(JSON.stringify({ chain: n.name, result: 'ANCHOR_UNAVAILABLE' }));
      continue;
    }
    const results = await Promise.all(nodes.map((c) => probe(c, n.id, anchor)));
    results.forEach((r, i) =>
      console.log(
        JSON.stringify({
          chain: n.name,
          provider: nodes[i].provider,
          simulation: r.result,
          ...(r.errors ? { errors: r.errors } : {}),
        }),
      ),
    );
    // Two providers require explicit operator selection; both must agree.
    if (nodes.length !== providers.length || results.some((r) => r.result !== 'PASS')) continue;
    try {
      agreeSimulation(
        results.map((r) => r.observation),
        2,
      );
    } catch {
      console.log(JSON.stringify({ chain: n.name, result: 'NO_SIMULATION_AGREEMENT' }));
      continue;
    }
    updates[`${n.name}_SIMULATION_RPC_URLS`] = JSON.stringify(nodes.map((c) => c.url));
    updates[`${n.name}_SIMULATION_QUORUM`] = '2';
    ready++;
  }
  const next = updatedEnv(original, updates);
  if (readFileSync(path, 'utf8') !== original) throw new Error('Configuration changed during discovery');
  if (next !== original) writeFileSync(path, next);
  console.log(
    JSON.stringify({
      qualifiedSimulationChains: ready,
      required: 3,
      providersPerChain: providers.length,
      existingSettingsPreserved: true,
    }),
  );
  if (ready !== 3) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Provider configuration stopped; existing configuration was preserved.');
    process.exitCode = 1;
  });
}
