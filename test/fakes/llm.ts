// FixtureLlmClient (ORCHESTRATOR_PROMPT §5.4). Owned by the Orchestrator.
//
// Fixture file test/fixtures/llm/<test-id>.json:
//   { "calls": [ { "name": "amounts", "match": "<substring of user message>", "output": { … }, "attempt": 1 } ] }
// Calls are consumed in order. For each call the client asserts the name and that `match` occurs in the
// user message, records system/user, validates `output` against the call's schema with the shared Ajv
// (an invalid output counts as a failed attempt, like the real client), and supports the retry-once policy:
// an entry with "attempt": 2 directly following an entry with the same name is the retry. "output": null
// or {"__error": true} simulates an Ollama error/timeout.

import { readFileSync } from 'node:fs';
import { LlmFailed, type LlmCallArgs, type LlmCallName, type LlmClient } from '../../src/contracts/llm.js';
import { compileEphemeral } from '../../src/schemas/index.js';

export interface FixtureCall {
  name: LlmCallName;
  match: string;
  output: unknown;
  attempt?: number;
}
export interface FixtureFile {
  calls: FixtureCall[];
}

export interface RecordedCall {
  name: LlmCallName;
  system: string;
  user: string;
  schema: object;
  attempt: number;
  output: unknown;
  valid: boolean;
}

export class FixtureLlmClient implements LlmClient {
  readonly recorded: RecordedCall[] = [];
  private queue: FixtureCall[];
  available = true;

  constructor(fixture: FixtureFile) {
    this.queue = [...fixture.calls];
  }

  static fromFile(path: string): FixtureLlmClient {
    return new FixtureLlmClient(JSON.parse(readFileSync(path, 'utf8')) as FixtureFile);
  }

  async modelAvailable(): Promise<boolean> {
    return this.available;
  }

  /** Entries not consumed by the test (should be empty at the end of a test). */
  remaining(): FixtureCall[] {
    return [...this.queue];
  }

  async call<T>(args: LlmCallArgs): Promise<T> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const next = this.queue[0];
      if (!next) throw new Error(`FixtureLlmClient: no fixture left for call "${args.name}" (attempt ${attempt})`);
      if (next.name !== args.name) {
        throw new Error(`FixtureLlmClient: expected call "${next.name}", got "${args.name}"`);
      }
      if (!args.user.includes(next.match)) {
        throw new Error(`FixtureLlmClient: user message for "${args.name}" does not contain fixture match`);
      }
      this.queue.shift();
      const isError = next.output === null || (typeof next.output === 'object' && '__error' in (next.output as object));
      const validate = compileEphemeral(args.schema as Record<string, unknown>);
      const valid = !isError && validate(next.output);
      this.recorded.push({ ...args, attempt, output: next.output, valid });
      if (valid) return structuredClone(next.output) as T;
      if (attempt === 2) break;
      // The real client always retries once; the fixture must say what the retry returns.
      const retry = this.queue[0];
      if (!retry || retry.name !== args.name || (retry.attempt ?? 1) !== 2) {
        throw new Error(`FixtureLlmClient: attempt 1 of "${args.name}" failed but no "attempt": 2 fixture follows`);
      }
    }
    throw new LlmFailed(args.name);
  }
}
