// Implements: OQ-15 (provisional): the wallet's own config file. It holds paths and URLs, never keys or tokens.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Hex } from 'viem';

export type ApprovalMode = 'reject_all' | 'auto_approve_testnets';

export interface WalletConfig {
  server: { host: '127.0.0.1'; port: number };
  agent: { url: string };
  auth: { inbound_token_file: string; report_token_file: string };
  db: { path: string };
  approval: { mode: ApprovalMode };
  chains: {
    chain_id: 11155111 | 84532 | 421614;
    rpc_url: string;
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
      properties: { mode: { enum: ['reject_all', 'auto_approve_testnets'] } },
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
  return raw;
}

export const loadConfig = (path: string): WalletConfig =>
  parseConfig(JSON.parse(readFileSync(expandHome(path), 'utf8')) as unknown);

export const readToken = (path: string): string => readFileSync(expandHome(path), 'utf8').trim();
