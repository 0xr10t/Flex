// Implements: OQ-15 (provisional): the wallet's own config file. It holds paths and URLs, never keys or tokens.

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
  chains: {
    chain_id: 11155111 | 84532 | 421614;
    rpc_url: string;
    /** Separate, provider-neutral simulation backends. Omission preserves the legacy single-RPC mode. */
    simulation?: SimulationConfig;
    /** Absent until `IntentExecutorV3` is deployed on that chain. Autopay and cancel are refused without it. */
    executor?: { address: Hex; deployment_block: number };
  }[];
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['server', 'agent', 'auth', 'db', 'approval', 'chains'],
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

export const expandHome = (path: string): string => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

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
  return raw;
}

export const loadConfig = (path: string): WalletConfig =>
  parseConfig(JSON.parse(readFileSync(expandHome(path), 'utf8')) as unknown);

export const readToken = (path: string): string => readFileSync(expandHome(path), 'utf8').trim();
