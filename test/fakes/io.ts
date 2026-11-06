// Mocks for src/contracts/io.ts (no network in unit tests). Owned by the Orchestrator.

import {
  EnsUnavailable,
  IndexerUnavailable,
  type AllowlistLogger,
  type ContentFetcher,
  type EnsClient,
  type ExecutionClient,
  type FetchResult,
  type LogFields,
  type RpcClients,
  type SubmitResult,
  type SubnameSource,
} from '../../src/contracts/io.js';
import type { Address, ChainId, HandoffEnvelope } from '../../src/contracts/types.js';
import { checkEnvelope, placeholderHashes } from '@flex/protocol';

/** Balances in base units per chain; a chain listed in `down` rejects. */
export class FakeRpc implements RpcClients {
  eth = new Map<ChainId, bigint>();
  usdc = new Map<ChainId, bigint>();
  down = new Set<ChainId>();
  calls: Array<{ fn: 'eth' | 'usdc'; chain_id: ChainId }> = [];
  async getEthBalance(chain_id: ChainId): Promise<bigint> {
    this.calls.push({ fn: 'eth', chain_id });
    if (this.down.has(chain_id)) throw new Error('rpc down');
    return this.eth.get(chain_id) ?? 0n;
  }
  async getUsdcBalance(chain_id: ChainId): Promise<bigint> {
    this.calls.push({ fn: 'usdc', chain_id });
    if (this.down.has(chain_id)) throw new Error('rpc down');
    return this.usdc.get(chain_id) ?? 0n;
  }
}

/** records: name → coinType (as decimal string) → address. `unavailable` names throw EnsUnavailable. */
export class FakeEns implements EnsClient {
  records = new Map<string, Map<string, Address>>();
  unavailable = new Set<string>();
  calls: Array<{ name: string; coinType: bigint }> = [];
  set(name: string, coinType: bigint, address: Address): this {
    const m = this.records.get(name) ?? new Map<string, Address>();
    m.set(coinType.toString(), address);
    this.records.set(name, m);
    return this;
  }
  async getAddress(name: string, coinType: bigint): Promise<Address | null> {
    this.calls.push({ name, coinType });
    if (this.unavailable.has(name)) throw new EnsUnavailable();
    return this.records.get(name)?.get(coinType.toString()) ?? null;
  }
}

export class FakeSubnames implements SubnameSource {
  children = new Map<string, string[]>();
  failing = false;
  async listChildren(parent: string): Promise<string[] | 'not_found'> {
    if (this.failing) throw new IndexerUnavailable();
    return this.children.get(parent) ?? 'not_found';
  }
}

/** Records every envelope; `responses` is consumed in order, then `fallback`. */
export class FakeExecution implements ExecutionClient {
  submissions: Array<{ envelope: HandoffEnvelope; idempotencyKey: string }> = [];
  responses: SubmitResult[] = [];
  fallback: SubmitResult = { status: 'accepted' };
  async submit(envelope: HandoffEnvelope, idempotencyKey: string): Promise<SubmitResult> {
    this.submissions.push({ envelope: structuredClone(envelope), idempotencyKey });
    const checked = checkEnvelope(envelope, {
      nowMs: Date.parse(envelope.created_at),
      delegationHashes: placeholderHashes(envelope),
    });
    if (!checked.ok) return { status: 'rejected', message: checked.message };
    return this.responses.shift() ?? this.fallback;
  }
}

export class FakeFetcher implements ContentFetcher {
  pages = new Map<string, FetchResult>();
  calls: string[] = [];
  async fetchUrl(url: string): Promise<FetchResult> {
    this.calls.push(url);
    return this.pages.get(url) ?? { ok: false };
  }
}

/** Captures log lines for assertions (A-60 style greps in unit tests). */
export class CapturingLogger implements AllowlistLogger {
  lines: Array<LogFields & { level: string }> = [];
  info(f: LogFields): void {
    this.lines.push({ ...f, level: 'info' });
  }
  warn(f: LogFields): void {
    this.lines.push({ ...f, level: 'warn' });
  }
  error(f: LogFields): void {
    this.lines.push({ ...f, level: 'error' });
  }
}
