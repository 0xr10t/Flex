// Test helpers: a StepContext wired to fakes, a fresh AgentRequest, an empty LexicalScan, the §6.1 example
// config and the §19 example setup. Owned by the Orchestrator.

import { DateTime } from 'luxon';
import type { StepContext } from '../../src/contracts/step.js';
import type { AgentRequest, Config, LexicalScan, RequestId, SessionId } from '../../src/contracts/types.js';
import { CapturingLogger, FakeEns, FakeExecution, FakeFetcher, FakeRpc, FakeSubnames } from './io.js';
import { FixtureLlmClient, type FixtureFile } from './llm.js';
import { createFakeRepos, seedContact, type FakeRepos } from './repos.js';

/** Illustrative wallet used by tests (§19 "0xUSER…"). */
export const TEST_WALLET = '0x00000000000000000000000000000000000000Aa' as const;

/** §19 setup contacts. */
export const ARADHYA = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E' as const;
export const MIHIR = '0x91aB2c3D4e5F60718293a4B5c6D7e8F9012377d0' as const;

export function testConfig(): Config {
  return {
    wallet: { address: TEST_WALLET },
    server: { host: '127.0.0.1', port: 8787 },
    auth: { ui_token_file: '/tmp/ui_token', execution_report_token_file: '/tmp/execution_report_token' },
    db: { path: ':memory:' },
    llm: {
      ollama_url: 'http://127.0.0.1:11434',
      model: 'qwen2.5:7b-instruct',
      temperature: 0,
      seed: 42,
      num_ctx: 8192,
      timeout_ms: 60000,
    },
    chains: [
      {
        chain_id: 11155111,
        name: 'Sepolia',
        is_l2: false,
        aliases: ['sepolia', 'ethereum', 'eth chain', 'l1', 'ethereum sepolia', 'eth sepolia'],
        rpc_url: 'https://rpc.invalid/sepolia',
        usdc_address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      },
      {
        chain_id: 84532,
        name: 'Base Sepolia',
        is_l2: true,
        aliases: ['base', 'base sepolia', 'base testnet'],
        rpc_url: 'https://rpc.invalid/base-sepolia',
        usdc_address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      },
      {
        chain_id: 421614,
        name: 'Arbitrum Sepolia',
        is_l2: true,
        aliases: ['arbitrum', 'arbi', 'arb', 'arbitrum sepolia', 'arb sepolia'],
        rpc_url: 'https://rpc.invalid/arbitrum-sepolia',
        usdc_address: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
      },
    ],
    ens: {
      rpc_chain_id: 11155111,
      universal_resolver_address: '0x0000000000000000000000000000000000000001',
      indexer_url: 'https://indexer.invalid/graphql',
      indexer_kind: 'ens-subgraph',
    },
    execution: {
      url: 'http://127.0.0.1:8788',
      outbound_token_file: '/tmp/execution_outbound_token',
      timeout_ms: 15000,
    },
    network: { socks_proxy: null },
    fetch: { enabled: true, max_bytes: 1048576, timeout_ms: 10000, max_redirects: 3 },
    defaults: { timezone: 'Asia/Kolkata', autopay_time_of_day: '10:00' },
  };
}

export function emptyScan(): LexicalScan {
  return {
    clauses: [],
    addresses: [],
    ens: [],
    groups: [],
    chains: [],
    tokens: [],
    dates: [],
    recurrence: [],
    cancel: [],
    back_reference: [],
    distributive: [],
    split: [],
    numeric_candidates: [],
  };
}

export function newRequest(over: Partial<AgentRequest> = {}): AgentRequest {
  return {
    request_id: 'req_000000000001' as RequestId,
    session_id: 'ses_000000000001' as SessionId,
    state: 'RECEIVED',
    typed_text: '',
    untrusted: [],
    scan: emptyScan(),
    amounts: [],
    spans: [],
    recipients: [],
    notes: [],
    limit_override: false,
    handoff_attempts: 0,
    resolved: [],
    mentioned_spans: [],
    prepend_messages: [],
    step_state: {},
    ...over,
  };
}

export interface TestContext extends StepContext {
  repos: FakeRepos;
  llm: FixtureLlmClient;
  rpc: FakeRpc;
  ens: FakeEns;
  subnames: FakeSubnames;
  exec: FakeExecution;
  fetcher: FakeFetcher;
  log: CapturingLogger;
}

export interface TestContextOptions {
  req?: Partial<AgentRequest>;
  fixture?: FixtureFile;
  timezone?: string;
  /** ISO instant used as "now" (default 2026-11-05T17:30:00Z = Thu 23:00 Asia/Kolkata, as in E6). */
  now?: string;
  /** Seed the §19 contacts (Aradhya on Base+Arbitrum, Mihir on all three). Default true. */
  seedExampleContacts?: boolean;
}

export function makeTestContext(o: TestContextOptions = {}): TestContext {
  const repos = createFakeRepos();
  if (o.seedExampleContacts !== false) {
    seedContact(repos, 'Aradhya', ARADHYA, [84532, 421614]);
    seedContact(repos, 'Mihir', MIHIR, [11155111, 84532, 421614]);
  }
  const timezone = o.timezone ?? 'Asia/Kolkata';
  const nowIso = o.now ?? '2026-11-05T17:30:00Z';
  return {
    req: newRequest(o.req),
    repos,
    llm: new FixtureLlmClient(o.fixture ?? { calls: [] }),
    rpc: new FakeRpc(),
    ens: new FakeEns(),
    subnames: new FakeSubnames(),
    exec: new FakeExecution(),
    fetcher: new FakeFetcher(),
    config: testConfig(),
    limits: repos.db5.getAll(),
    now: () => DateTime.fromISO(nowIso, { zone: 'utc' }).setZone(timezone),
    timezone,
    log: new CapturingLogger(),
  };
}
