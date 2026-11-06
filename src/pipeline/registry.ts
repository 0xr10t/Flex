// Implements: §3.3 fixed step order S0–S12 (registry of step functions and answer handlers).
// Owned by the Orchestrator. Phase 2: every step is the owning lane's real StepEntry (LANES.md export table).

import type { StepEntry, StepName } from '../contracts/step.js';
import { s0 } from './s0-balances.js';
import { s1 } from './s1-guard.js';
import { s2 } from './s2-lexical.js';
import { s3 } from './s3-amounts.js';
import { s4 } from './s4-type.js';
import { s5 } from './s5-spans.js';
import { s6 } from './s6-resolve.js';
import { s7 } from './s7-mask.js';
import { s8 } from './s8-pair.js';
import { s9 } from './s9-plan.js';
import { s10 } from './s10-validate.js';
import { s11 } from './s11-summary.js';
import { s12 } from './s12-handoff.js';

export const registry: Record<StepName, StepEntry> = { s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12 };
