// Implements: §8.13 S11 — Summary and confirmation (§13.1 through src/messages/summary.ts); §8.5 rule 3 / SQB-15: with
// `also_balance` the §13.2 answer is the first message of the summary response.

import type { StepContext, StepEntry, StepResult } from '../contracts/step.js';
import type { Summary } from '../contracts/types.js';
import { buildBalanceAnswer } from '../messages/balance.js';
import { buildSummary } from '../messages/summary.js';
import { internalError } from '../plan/common.js';

async function step(ctx: StepContext): Promise<StepResult> {
  const { req } = ctx;
  if (!req.plan) return internalError(ctx, 's11', 'S11_NO_PLAN');
  let summary: Summary;
  try {
    summary = buildSummary(ctx, req.plan);
  } catch {
    return internalError(ctx, 's11', 'S11_BUILD');
  }
  if (req.also_balance) req.prepend_messages.unshift(...buildBalanceAnswer(ctx));
  req.summary = summary;
  req.state = 'AWAITING_CONFIRMATION';
  return { kind: 'summary', summary };
}

export const s11: StepEntry = { step };
