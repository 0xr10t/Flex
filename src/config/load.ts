// Implements: §6.1 config.json (path from env AGENT_CONFIG, default ~/.agent-layer/config.json; validated at
// startup), §16.4 server bound to 127.0.0.1 only, NFR-01 Ollama on 127.0.0.1 only, §5 stack (Ajv draft 2020-12 shared instance).
// Owner: Lane A.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { IANAZone } from 'luxon';
import { ajv } from '../schemas/index.js';
import { CHAIN_IDS, type ChainId, type Config } from '../contracts/types.js';

/** §6.1 default config location. */
export const DEFAULT_CONFIG_PATH = '~/.agent-layer/config.json';

/** Expands a leading `~` to the user's home directory (config paths in §6.1 use `~/.agent-layer/…`). */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** Path from env `AGENT_CONFIG`, default `~/.agent-layer/config.json` (§6.1). */
export function configPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const fromEnv = env.AGENT_CONFIG;
  return expandHome(fromEnv !== undefined && fromEnv !== '' ? fromEnv : DEFAULT_CONFIG_PATH, home);
}

const ADDRESS = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } as const;
const NON_EMPTY = { type: 'string', minLength: 1 } as const;
const POS_INT = { type: 'integer', minimum: 1 } as const;

/** JSON Schema of §6.1 (every key required, no extra keys). */
const CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['wallet', 'server', 'auth', 'db', 'llm', 'chains', 'ens', 'execution', 'fetch', 'defaults'],
  properties: {
    wallet: {
      type: 'object',
      additionalProperties: false,
      required: ['address'],
      properties: { address: ADDRESS },
    },
    server: {
      type: 'object',
      additionalProperties: false,
      required: ['host', 'port'],
      // §5 / §16.4: bound to 127.0.0.1 only.
      properties: { host: { const: '127.0.0.1' }, port: { type: 'integer', minimum: 1, maximum: 65535 } },
    },
    auth: {
      type: 'object',
      additionalProperties: false,
      required: ['ui_token_file', 'execution_report_token_file'],
      properties: { ui_token_file: NON_EMPTY, execution_report_token_file: NON_EMPTY },
    },
    db: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: NON_EMPTY },
    },
    llm: {
      type: 'object',
      additionalProperties: false,
      required: ['ollama_url', 'model', 'temperature', 'seed', 'num_ctx', 'timeout_ms'],
      properties: {
        ollama_url: NON_EMPTY,
        model: NON_EMPTY,
        temperature: { type: 'number', minimum: 0 },
        seed: { type: 'integer' },
        num_ctx: POS_INT,
        timeout_ms: POS_INT,
      },
    },
    chains: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chain_id', 'name', 'is_l2', 'aliases', 'rpc_url', 'usdc_address'],
        properties: {
          chain_id: { enum: [...CHAIN_IDS] },
          name: NON_EMPTY,
          is_l2: { type: 'boolean' },
          aliases: { type: 'array', items: NON_EMPTY },
          rpc_url: NON_EMPTY,
          usdc_address: ADDRESS,
        },
      },
    },
    ens: {
      type: 'object',
      additionalProperties: false,
      required: ['rpc_chain_id', 'universal_resolver_address', 'indexer_url', 'indexer_kind'],
      properties: {
        rpc_chain_id: { enum: [...CHAIN_IDS] },
        universal_resolver_address: ADDRESS,
        indexer_url: { oneOf: [NON_EMPTY, { type: 'null' }] },
        indexer_kind: { enum: ['ens-subgraph', 'ensnode-omnigraph'] },
      },
    },
    execution: {
      type: 'object',
      additionalProperties: false,
      required: ['url', 'outbound_token_file', 'timeout_ms'],
      properties: { url: NON_EMPTY, outbound_token_file: NON_EMPTY, timeout_ms: POS_INT },
    },
    fetch: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'max_bytes', 'timeout_ms', 'max_redirects'],
      properties: {
        enabled: { type: 'boolean' },
        max_bytes: POS_INT,
        timeout_ms: POS_INT,
        max_redirects: { type: 'integer', minimum: 0 },
      },
    },
    defaults: {
      type: 'object',
      additionalProperties: false,
      required: ['timezone', 'autopay_time_of_day'],
      properties: {
        timezone: NON_EMPTY,
        autopay_time_of_day: { type: 'string', pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' },
      },
    },
  },
} as const;

const validateConfigSchema = ajv.compile(CONFIG_SCHEMA);

/** Thrown when config.json is missing, unparsable or invalid. `errors` lists field paths only (no values). */
export class ConfigError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`invalid config: ${errors.join('; ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

/** Validates a parsed config object (§6.1). Returns the typed config or throws ConfigError. */
export function validateConfig(raw: unknown): Config {
  if (!validateConfigSchema(raw)) {
    const errs = (validateConfigSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
    throw new ConfigError(errs);
  }
  const cfg = raw as unknown as Config;
  const errors: string[] = [];
  const ids = cfg.chains.map((c) => c.chain_id);
  if (new Set(ids).size !== ids.length) errors.push('/chains duplicate chain_id');
  if (!ids.includes(cfg.ens.rpc_chain_id)) errors.push('/ens/rpc_chain_id not a configured chain');
  if (!IANAZone.isValidZone(cfg.defaults.timezone)) errors.push('/defaults/timezone not an IANA timezone');
  const urls: Array<[string, string]> = [
    ['/llm/ollama_url', cfg.llm.ollama_url],
    ['/execution/url', cfg.execution.url],
    ...(cfg.ens.indexer_url === null ? [] : [['/ens/indexer_url', cfg.ens.indexer_url] as [string, string]]),
    ...cfg.chains.map((c, i): [string, string] => [`/chains/${i}/rpc_url`, c.rpc_url]),
  ];
  for (const [field, url] of urls) if (!URL.canParse(url)) errors.push(`${field} not a parsable URL`);
  // NFR-01 / ADR-004 / §16.4: Ollama is reached on 127.0.0.1 only, over plain http (§6.1 example).
  if (URL.canParse(cfg.llm.ollama_url)) {
    const u = new URL(cfg.llm.ollama_url);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') errors.push('/llm/ollama_url must be http://127.0.0.1');
  }
  if (errors.length > 0) throw new ConfigError(errors);
  return cfg;
}

/** Reads and validates config.json (§6.1). */
export function loadConfig(path: string = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ConfigError(['config file not readable']);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError(['config file is not valid JSON']);
  }
  return validateConfig(raw);
}

/** Chain display names from config (§6.1 `chains[].name`). */
export function chainNames(config: Config): Partial<Record<ChainId, string>> {
  const out: Partial<Record<ChainId, string>> = {};
  for (const c of config.chains) out[c.chain_id] = c.name;
  return out;
}
