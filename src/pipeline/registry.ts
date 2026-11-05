// Implements: §3.3 fixed step order S0–S12 (registry of step functions and answer handlers).
// Owned by the Orchestrator. contracts-v1: every step is a stub returning UNSUPPORTED_REQUEST (spec §0).
// Phase 2 wires the lanes' real step functions in here.

import type { StepEntry, StepName, StepResult } from '../contracts/step.js';

const unsupported = async (): Promise<StepResult> => ({ kind: 'error', code: 'UNSUPPORTED_REQUEST' });

function stub(): StepEntry {
  return { step: unsupported, onAnswer: unsupported };
}

export const registry: Record<StepName, StepEntry> = {
  s0: stub(),
  s1: stub(),
  s2: stub(),
  s3: stub(),
  s4: stub(),
  s5: stub(),
  s6: stub(),
  s7: stub(),
  s8: stub(),
  s9: stub(),
  s10: stub(),
  s11: stub(),
  s12: stub(),
};
