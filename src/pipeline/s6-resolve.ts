// Implements: §8.7 S6 — Resolve recipients (code + user), following §9 (§9.1–§9.4, §9.6, §9.7).
// The flows live in src/recipients/resolve.ts; this file is the StepEntry the registry wires.

import type { StepEntry } from '../contracts/step.js';
import { resolveAnswer, resolveStep } from '../recipients/resolve.js';

export const s6: StepEntry = { step: resolveStep, onAnswer: resolveAnswer };
