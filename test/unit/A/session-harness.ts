// Lane A test harness for the session manager: a stub step registry whose entries tests override per step, the
// Orchestrator fakes for every injected client, and a fixed clock.
import { DateTime } from 'luxon';
import type { Repos } from '../../../src/contracts/repos.js';
import {
  STEP_ORDER,
  type AnswerHandler,
  type Step,
  type StepContext,
  type StepEntry,
  type StepName,
} from '../../../src/contracts/step.js';
import type { Answer, MessageInput, Question, QuestionCode, QuestionId } from '../../../src/contracts/types.js';
import { SessionManager, type StepRegistry } from '../../../src/session/manager.js';
import { CapturingLogger, FakeEns, FakeExecution, FakeFetcher, FakeRpc, FakeSubnames } from '../../fakes/io.js';
import { FixtureLlmClient } from '../../fakes/llm.js';
import { createFakeRepos, type FakeRepos } from '../../fakes/repos.js';
import { testConfig } from '../../fakes/context.js';

export interface Call {
  step: StepName;
  kind: 'step' | 'answer';
  question?: Question;
  answer?: Answer;
}

export interface Harness<R extends Repos = FakeRepos> {
  manager: SessionManager;
  repos: R;
  llm: FixtureLlmClient;
  log: CapturingLogger;
  calls: Call[];
  contexts: StepContext[];
  /** Replace the step function and/or answer handler of one step. */
  set(step: StepName, entry: Partial<StepEntry>): void;
  clock: { iso: string };
}

let qn = 0;
export function question(code: QuestionCode = 'Q_TOKEN', attempt = 1): Question {
  qn++;
  return {
    question_id: `q_${qn.toString(16).padStart(12, '0')}` as QuestionId,
    code,
    text: 'Is 50 in USDC or ETH?',
    input: 'chips',
    chips: [],
    attempt,
    max_attempts: 4,
  };
}

export const SUMMARY = { text: 'Send 50 USDC', lines: ['line'], notes: [], footer: ['Confirm?'] };

export function msg(text: string): MessageInput {
  return { text, pasted_blocks: [], attachments: [], urls: [] };
}

/** Default registry: S0–S10 continue, S11 returns a summary, S12 continue (accepted). */
export function makeHarness<R extends Repos = FakeRepos>(opts: { repos?: R } = {}): Harness<R> {
  const repos = (opts.repos ?? createFakeRepos()) as R;
  const llm = new FixtureLlmClient({ calls: [] });
  const log = new CapturingLogger();
  const calls: Call[] = [];
  const contexts: StepContext[] = [];
  const clock = { iso: '2026-11-05T17:30:00.000Z' };
  const entries = {} as Record<StepName, StepEntry>;
  const steps: Partial<Record<StepName, Step>> = {};
  const handlers: Partial<Record<StepName, AnswerHandler | undefined>> = {};
  for (const name of STEP_ORDER) {
    steps[name] = async () => (name === 's11' ? { kind: 'summary', summary: SUMMARY } : { kind: 'continue' as const });
    handlers[name] = async () => ({ kind: 'continue' });
    entries[name] = {
      step: async (ctx) => {
        calls.push({ step: name, kind: 'step' });
        contexts.push(ctx);
        return (steps[name] as Step)(ctx);
      },
      onAnswer: async (ctx, q, a) => {
        calls.push({ step: name, kind: 'answer', question: q, answer: a });
        const h = handlers[name];
        if (h === undefined) throw new Error('unreachable');
        return h(ctx, q, a);
      },
    };
  }
  const registry: StepRegistry = new Proxy(entries, {
    get(target, prop: string) {
      const e = target[prop as StepName];
      if (e === undefined) return undefined;
      return handlers[prop as StepName] === undefined ? { step: e.step } : e;
    },
  });
  const manager = new SessionManager({
    repos,
    llm,
    rpc: new FakeRpc(),
    ens: new FakeEns(),
    subnames: new FakeSubnames(),
    exec: new FakeExecution(),
    fetcher: new FakeFetcher(),
    log,
    config: testConfig(),
    registry,
    clock: () => DateTime.fromISO(clock.iso, { zone: 'utc' }),
  });
  return {
    manager,
    repos,
    llm,
    log,
    calls,
    contexts,
    clock,
    set(step, entry) {
      if (entry.step !== undefined) steps[step] = entry.step;
      if ('onAnswer' in entry) handlers[step] = entry.onAnswer;
    },
  };
}

/** Steps called (kind 'step') in order. */
export const stepNames = (calls: Call[]): string[] =>
  calls.map((c) => (c.kind === 'step' ? c.step : `${c.step}:answer`));
