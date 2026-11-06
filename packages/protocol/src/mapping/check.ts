// Implements: AGENT_SPEC §12.5 and D3 (the two checks), §14.2 (a rejected envelope is a 4xx with `message`) and §15
// (messages shown to the user never contain amounts or addresses).

import { validateEnvelope, type HandoffEnvelope } from '../schemas/envelope.js';
import { PlanSchema, planSchemaAt, type Plan } from '../schemas/bridge.v2.js';
import { MappingError, toPlan, type ToPlanOptions } from './to-plan.js';

export type CheckStage = 'schema' | 'consistency' | 'plan';

/** Fixed texts: this is the `message` the agent shows as EXECUTION_REJECTED, so nothing from the input goes in it. */
const MESSAGE: Record<CheckStage, string> = {
  schema: 'the request has a format the wallet does not accept.',
  consistency: 'the amounts or tokens in the request do not agree with each other.',
  plan: 'the request breaks a payment rule the wallet enforces.',
};

export type CheckResult =
  | { ok: true; envelope: HandoffEnvelope; plan: Plan }
  /** `paths` holds field paths only, for logs. `message` is safe to return to the agent. */
  | { ok: false; stage: CheckStage; message: string; paths: string[] };

const reject = (stage: CheckStage, paths: string[]): CheckResult => ({
  ok: false,
  stage,
  message: MESSAGE[stage],
  paths,
});

export function checkEnvelope(raw: unknown, options: ToPlanOptions = {}): CheckResult {
  const first = validateEnvelope(raw);
  if (!first.ok) return reject('schema', first.paths);

  let mapped: ReturnType<typeof toPlan>;
  try {
    mapped = toPlan(first.envelope, options);
  } catch (e) {
    if (e instanceof MappingError) return reject('consistency', [e.path]);
    throw e;
  }

  const second = (options.nowMs === undefined ? PlanSchema : planSchemaAt(() => options.nowMs!)).safeParse(mapped);
  if (!second.success) {
    return reject('plan', [...new Set(second.error.issues.map((i) => `/${i.path.join('/')}`))]);
  }
  return { ok: true, envelope: first.envelope, plan: second.data };
}
