// Implements: OQ-15 (provisional): the wallet's own config file. It holds paths and URLs, never keys or tokens.
// Privacy fixes 1 and 10: chain RPC URLs are https (the anon-rpc endpoints) or http://127.0.0.1 (your own node); there is
// no fallback RPC. agent.url is http://127.0.0.1 only. anon-rpc over Tor: `network.socks_proxy` (Tor's SOCKS port) sends
// every remote RPC request through Tor, one circuit per chain.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { isAddress, parseEther, type Hex } from 'viem';
import { validateSimulationConfig, type SimulationConfig } from './chain/simulation.js';

export type ApprovalMode = 'reject_all' | 'auto_approve_testnets' | 'metamask';

export interface WalletConfig {
  server: { host: '127.0.0.1'; port: number };
  agent: { url: string };
  auth: { inbound_token_file: string; report_token_file: string };
  db: { path: string };
  approval: { mode: ApprovalMode; wallet_address?: Hex };
  bridge?: { ccip_fee_max_eth: string };
  /** anon-rpc over Tor: `socks5h://127.0.0.1:<port>`, or null for direct connections. Required, so direct is a choice. */
  network: { socks_proxy: string | null };
  chains: {
    chain_id: 11155111 | 84532 | 421614;
    rpc_url: string;
    /** Separate, provider-neutral simulation backends. Omission preserves the legacy single-RPC mode. */
    simulation?: SimulationConfig;
    /** Absent until `IntentExecutorV4` is deployed on that chain. Autopay and cancel are refused without it. */
    executor?: { address: Hex; deployment_block: number };
  }[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['server', 'agent', 'auth', 'db', 'approval', 'network', 'chains'],
  properties: {
    // §16.4: local only. The envelope is the user's financial data, so this can't be pointed at a network interface.
    server: {
      type: 'object',
      additionalProperties: false,
      required: ['host', 'port'],
      properties: { host: { const: '127.0.0.1' }, port: { type: 'integer', minimum: 1, maximum: 65535 } },
    },
    agent: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: { url: { type: 'string', pattern: '^https?://' } },
    },
    auth: {
      type: 'object',
      additionalProperties: false,
      required: ['inbound_token_file', 'report_token_file'],
      properties: {
        inbound_token_file: { type: 'string', minLength: 1 },
        report_token_file: { type: 'string', minLength: 1 },
      },
    },
    db: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1 } },
    },
    approval: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { enum: ['reject_all', 'auto_approve_testnets', 'metamask'] },
        wallet_address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
      },
    },
    bridge: {
      type: 'object',
      additionalProperties: false,
      required: ['ccip_fee_max_eth'],
      properties: { ccip_fee_max_eth: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,18})?$' } },
    },
    network: {
      type: 'object',
      additionalProperties: false,
      required: ['socks_proxy'],
      properties: { socks_proxy: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] } },
    },
    chains: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chain_id', 'rpc_url'],
        properties: {
          chain_id: { enum: [11155111, 84532, 421614] },
          rpc_url: { type: 'string', pattern: '^https?://' },
          simulation: {
            type: 'object',
            additionalProperties: false,
            required: ['rpc_urls', 'quorum'],
            properties: {
              rpc_urls: {
                type: 'array',
                minItems: 1,
                maxItems: 3,
                uniqueItems: true,
                items: { type: 'string', pattern: '^https?://' },
              },
              quorum: { type: 'integer', minimum: 1, maximum: 3 },
            },
          },
          executor: {
            type: 'object',
            additionalProperties: false,
            required: ['address', 'deployment_block'],
            properties: {
              address: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
              deployment_block: { type: 'integer', minimum: 0 },
            },
          },
        },
      },
    },
  },
} as const;

const validate = new Ajv2020({ strict: true }).compile<WalletConfig>(SCHEMA);

const expandHome = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** http on 127.0.0.1 with no credentials in the URL. */
const isLoopbackHttp = (u: URL): boolean =>
  u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.username === '' && u.password === '';

const parse = (url: string): URL | null => (URL.canParse(url) ? new URL(url) : null);

/** `socks5h://127.0.0.1:<port>`: no credentials (one is set per circuit), no path. */
const isTorSocks = (url: string): boolean => {
  const u = parse(url);
  return (
    u !== null &&
    u.protocol === 'socks5h:' &&
    u.hostname === '127.0.0.1' &&
    u.port !== '' &&
    u.username === '' &&
    u.password === '' &&
    (u.pathname === '' || u.pathname === '/') &&
    u.search === '' &&
    u.hash === ''
  );
};

export function parseConfig(raw: unknown): WalletConfig {
  if (!validate(raw)) throw new Error('wallet config is invalid');
  if (
    raw.approval.mode === 'metamask' &&
    (!raw.approval.wallet_address ||
      !isAddress(raw.approval.wallet_address) ||
      /^0x0{40}$/.test(raw.approval.wallet_address))
  )
    throw new Error('MetaMask requires a public wallet address');
  if (
    raw.bridge &&
    (parseEther(raw.bridge.ccip_fee_max_eth) <= 0n || parseEther(raw.bridge.ccip_fee_max_eth) > parseEther('0.01'))
  )
    throw new Error('invalid CCIP fee ceiling');
  for (const chain of raw.chains)
    if (chain.simulation) {
      try {
        validateSimulationConfig(chain.simulation);
      } catch {
        throw new Error('wallet simulation config is invalid');
      }
    }
  // Privacy fix 10: reports carry tx hashes and amounts, so the agent is reached on this machine only.
  const agent = parse(raw.agent.url);
  if (!agent || !isLoopbackHttp(agent)) throw new Error('wallet config: agent.url must be http://127.0.0.1');
  // anon-rpc over Tor: Tor's SOCKS port on this machine, with hostnames resolved by Tor.
  const proxy = raw.network.socks_proxy;
  if (proxy !== null && !isTorSocks(proxy)) {
    throw new Error('wallet config: network.socks_proxy must be socks5h://127.0.0.1:<port> or null');
  }
  // Privacy fix 1: chain traffic goes over TLS to anon-rpc, or in plain http only to a node on this machine.
  for (const c of raw.chains) {
    const u = parse(c.rpc_url);
    if (!u || !(u.protocol === 'https:' || isLoopbackHttp(u))) {
      throw new Error(`wallet config: chain ${c.chain_id} rpc_url must be https (anon-rpc), or http://127.0.0.1`);
    }
  }
  return raw;
}

export const loadConfig = (path: string): WalletConfig =>
  parseConfig(JSON.parse(readFileSync(expandHome(path), 'utf8')) as unknown);

export const readToken = (path: string): string => readFileSync(expandHome(path), 'utf8').trim();
