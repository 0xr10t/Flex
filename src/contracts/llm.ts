// Implements: §8.10 call policy (fresh chat, format=schema, retry once), §14.4 Ollama interface boundary.
// Owned by the Orchestrator (frozen contract). Lane B implements OllamaLlmClient in src/llm/ollama.ts;
// tests use FixtureLlmClient (test/fakes/llm.ts).

export type LlmCallName =
  | 'amounts'
  | 'request_type'
  | 'spans'
  | 'payments'
  | 'quarantine'
  | 'conversation'
  | 'draft_values'
  | 'draft_edit'
  | 'chat_route'
  | 'chat';

export interface LlmCallArgs {
  name: LlmCallName;
  system: string;
  user: string;
  schema: object;
  /** Backend-owned per-call override, used to enable thinking for general conversation. */
  think?: boolean;
}

export interface LlmClient {
  /**
   * Sends one fresh chat with format=schema; validates with Ajv; retries once on error/timeout/invalid
   * (spec §8.10); throws LlmFailed after the second failure.
   */
  call<T>(args: LlmCallArgs): Promise<T>;
  /** §14.4 startup check: GET /api/tags lists the configured model. */
  modelAvailable(): Promise<boolean>;
}

/** Thrown by LlmClient.call after the second failure. Callers map it to MODEL_FAILED (or "item yields nothing" for Q-LLM). */
export class LlmFailed extends Error {
  readonly callName: LlmCallName;
  constructor(callName: LlmCallName) {
    super('LLM call failed twice');
    this.name = 'LlmFailed';
    this.callName = callName;
  }
}

/** Prompt builders return this (§8.10). */
export interface BuiltPrompt {
  system: string;
  user: string;
  schema: object;
}
