// Implements: §14.4 Ollama client — POST {llm.ollama_url}/api/chat with { model, messages: [system, user],
// format: <schema>, stream: false, options: { temperature, seed, num_ctx } }; parse message.content as JSON, then
// validate with Ajv (shared instance, §12). §8.10 retries: an Ollama error, timeout (llm.timeout_ms, NFR-03) or
// output failing JSON-Schema validation → one retry of the same call; second failure → LlmFailed (callers map it
// to MODEL_FAILED, or "item yields nothing" for the Q-LLM). §14.4 startup check: GET /api/tags must list the
// configured model, otherwise every call fails. NFR-01 / ADR-004: the only model client; local Ollama only.
// §18: logs only allowlisted fields (never prompts or outputs).
// Owner: Lane B.

import type { ValidateFunction } from 'ajv/dist/2020.js';
import type { AllowlistLogger } from '../contracts/io.js';
import { LlmFailed, type LlmCallArgs, type LlmCallName, type LlmClient } from '../contracts/llm.js';
import type { Config } from '../contracts/types.js';
import { SCHEMA, compileEphemeral, validators } from '../schemas/index.js';

const FIXED: ReadonlyArray<[object, ValidateFunction]> = [
  [SCHEMA.amounts, validators.amounts],
  [SCHEMA.requestType, validators.requestType],
  [SCHEMA.recipientSpans, validators.recipientSpans],
  [SCHEMA.quarantine, validators.quarantine],
];

const ephemeral = new WeakMap<object, ValidateFunction>();

/** The shared validator for the four fixed §12.1 schemas; per-request schemas (§12.2) are compiled once each. */
function validatorFor(schema: object): ValidateFunction {
  for (const [s, v] of FIXED) if (s === schema) return v;
  let v = ephemeral.get(schema);
  if (!v) {
    v = compileEphemeral(schema as Record<string, unknown>);
    ephemeral.set(schema, v);
  }
  return v;
}

function baseUrl(config: Config): string {
  return config.llm.ollama_url.replace(/\/+$/, '');
}

/** SQ-L-01 / B14: actions are kinds, so repeated valid labels are semantically identical. Validate everything else. */
function normalizeActionKinds(name: LlmCallName, parsed: unknown): unknown {
  if (name !== 'request_type' || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  if (
    record.request_type !== 'actions' ||
    !Array.isArray(record.actions) ||
    !record.actions.every((action: unknown) => action === 'i' || action === 'k' || action === 'l')
  )
    return parsed;
  return { ...record, actions: [...new Set(record.actions)] };
}

class OllamaLlmClient implements LlmClient {
  /** Result of the last §14.4 model check; `false` makes every call fail (MODEL_FAILED). */
  private modelOk: boolean | null = null;

  constructor(
    private readonly config: Config,
    private readonly log: AllowlistLogger,
  ) {}

  async modelAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${baseUrl(this.config)}/api/tags`, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.config.llm.timeout_ms),
      });
      if (!res.ok) {
        this.modelOk = false;
        return false;
      }
      const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
      const want = this.config.llm.model;
      this.modelOk = Array.isArray(body.models) && body.models.some((m) => m.name === want || m.model === want);
    } catch {
      this.modelOk = false;
    }
    if (!this.modelOk) this.log.warn({ event: 'llm_model_unavailable' });
    return this.modelOk;
  }

  private async once(args: LlmCallArgs, validate: ValidateFunction): Promise<unknown> {
    const { llm } = this.config;
    const res = await fetch(`${baseUrl(this.config)}/api/chat`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llm.model,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        format: args.schema,
        stream: false,
        options: { temperature: llm.temperature, seed: llm.seed, num_ctx: llm.num_ctx },
      }),
      signal: AbortSignal.timeout(llm.timeout_ms),
    });
    if (!res.ok) throw new Error('ollama http error');
    const body = (await res.json()) as { message?: { content?: unknown } };
    const content = body.message?.content;
    if (typeof content !== 'string') throw new Error('ollama response without content');
    const parsed = normalizeActionKinds(args.name, JSON.parse(content) as unknown);
    if (!validate(parsed)) throw new Error('schema validation failed');
    return parsed;
  }

  async call<T>(args: LlmCallArgs): Promise<T> {
    const name: LlmCallName = args.name;
    if (this.modelOk === false) throw new LlmFailed(name);
    const validate = validatorFor(args.schema);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      try {
        const out = await this.once(args, validate);
        this.log.info({ event: 'llm_call', llm_call: name, llm_retry: attempt === 2, duration_ms: Date.now() - t0 });
        return out as T;
      } catch {
        this.log.warn({
          event: 'llm_call_failed',
          llm_call: name,
          llm_retry: attempt === 2,
          duration_ms: Date.now() - t0,
        });
      }
    }
    throw new LlmFailed(name);
  }
}

/** §14.4 local Ollama client. */
export function createOllamaClient(config: Config, log: AllowlistLogger): LlmClient {
  return new OllamaLlmClient(config, log);
}
