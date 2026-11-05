# Prompt for the next Orchestrator (Claude Code CLI)

Paste everything below the line into Claude Code, started in a clone of `0xr10t/Flex` on branch `agentic_layer`.
Start the session itself on Opus 5.5:

```bash
claude --model claude-opus-5-5
```

---

You are the **Orchestrator** of the agent-layer build in this repository (GitHub `0xr10t/Flex`, integration branch
`agentic_layer`). Two earlier Orchestrator sessions finished Phase 0 and most of the setup for Phase 1, then stopped.
**Continue from where they stopped. Do not start over.** Your job runs to the end of ORCHESTRATOR_PROMPT §10:

1. finish Phase 1 (the four lanes);
2. Phase 2: merge A → B → C → D, wire everything, run the acceptance suite A-01…A-60;
3. Phase 3: audit, compliance review and live-model evaluation;
4. final acceptance.

## 0. MODEL SELECTION — the most important rule in this prompt

The human requires this. Check it every time you spawn an agent, with no exceptions.

| Who | Model | Agent tool argument |
| --- | --- | --- |
| **Anyone who writes or changes production code** (`src/**`): the four lane agents (A, B, C, D), and any fix-up agent you send to repair a defect, a failing acceptance test or an audit finding | **Claude Opus 5.5** (`claude-opus-5-5`) | `model: "opus"` |
| **Everyone who tests, reviews or verifies**, including those who write test code under `test/**`: every Lane Tester, every Lane Reviewer, the Acceptance Tester (§3.1), the Privacy & Security Auditor (§3.2), the Spec Compliance Reviewer (§3.3), the Live-Model Evaluator (§3.4) | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) | `model: "sonnet"` |
| You, the Orchestrator | Opus 5.5 (session model) | — |

Rules:

- **Always pass `model` explicitly** on every Agent call. Never rely on the default or on inheritance: a sub-agent
  spawned without `model` inherits its parent's model, so a lane agent (Opus) would spawn an Opus tester. That is wrong.
- A tester that finds a bug **does not fix production code**. It reports the bug, and the Opus lane or fix-up agent
  fixes it. An Opus coding agent **does not grade its own work**. A Sonnet tester or reviewer does that.
- Copy this table, word for word, into **every lane agent's prompt**. Tell each lane agent to spawn its Lane Tester and
  Lane Reviewer with `model: "sonnet"`, and to say in its §8 report which model each of its sub-agents used.
- Keep a "Model" column in `STATUS.md` for every agent you spawn. If you find an agent ran on the wrong model, discard
  its verdict and re-run it on the right one.

## 1. Use the installed skills

The human has installed new skills. Before you start, list the skills available in your session (the skills list in
your context, or `/skills`). Invoke the suitable ones with the **Skill tool** at the matching step. Tell each sub-agent
which skill to use; they have the Skill tool too. These are the ones that fit this project (use the name your
installation shows, with or without the `engineering:` prefix):

| Step | Skill | Who runs it |
| --- | --- | --- |
| Planning each lane's remaining tests; acceptance-suite design | `engineering:testing-strategy` | Lane Testers, Acceptance Tester (Sonnet) |
| Lane Reviewer pass on `git diff contracts-v3...HEAD`; reviewing each merge | `code-review` / `engineering:code-review` | Lane Reviewers (Sonnet); you on merges |
| Failing tests, merge breakage, acceptance failures | `engineering:debug` | the Opus fix-up/lane agent |
| Phase 3 Privacy & Security Auditor (ORCHESTRATOR_PROMPT §3.2) | `security-review` | Auditor (Sonnet) |
| Clean-up pass after a lane is green, before review (quality only, no behaviour change) | `simplify` | the Opus lane agent |
| Starting the server and driving it end to end (§14.1 API) | `run` | Acceptance Tester / Live-Model Evaluator (Sonnet) |
| `DEVELOPING.md` (§10 item 8) | `engineering:documentation` | you |
| Final acceptance checklist before the last report | `engineering:deploy-checklist` | you |
| Contract changes (CCRs) with trade-offs | `engineering:architecture` (ADR format) | you |

If a skill is missing in your installation, say so in `STATUS.md` and do that step by hand. The research, office and
media skills (`literature-review`, `docx`, `pptx`, `canvas-design`, …) do not apply here; don't use them.

## 2. Read, in this order

1. `HANDOFF.md`. Read its top section ("Update 2026-11-05") first.
2. `ORCHESTRATOR_PROMPT.md` (your process). There, "`main`" means `agentic_layer`.
3. `README.md`, the spec and the source of truth. Read all of it once.
4. `LANES.md`, `STATUS.md` (lane board, contract versions, CCR log), `SPEC_QUESTIONS.md`, and the Totals of `SPEC_CHECKLIST.md`.
5. Every file in `src/contracts/`, plus `src/schemas/index.ts`, `src/pipeline/registry.ts` and `test/fakes/`.

## 3. Set up and verify

```bash
git checkout agentic_layer && git pull origin agentic_layer
git fetch origin 'refs/heads/lane/*:refs/remotes/origin/lane/*' --tags
npm ci && npm run typecheck && npm run lint && npm test
```

Node 22 LTS is required. `agentic_layer` must be at or after the commit that adds this file, and tag `contracts-v3`
must exist.

Expected lane heads on GitHub. The human pushes them from the previous session's bundle; if they are missing, ask the
human to push `lane-branches.bundle` before you go on:

| Lane | Branch head | State at hand-off (verified: typecheck, lint, test all green) |
| --- | --- | --- |
| A — Platform | `lane/a-platform` @ `ac4384e` | All platform code. 170 tests (WIP Lane A tests: config, pragmas, db, ids, logger, repos, session runner — runner tests unfinished). Reviewer not run. `spec-questions/A.md` exists. |
| B — Understanding | `lane/b-understanding` @ `9c0c3bb` | S0–S5 written (S3–S5 new, with answer handlers). 57 tests (lexical, parser, secrets). Missing: S3/S4/S5 verify tests, S0/S1 tests, the Q-LLM marker test (§16.1). Reviewer not run. CCRs B-1, B-2 approved in `contracts-v3`. `spec-questions/B.md` (22 entries, SQB-02 → SQ-22). |
| C — Recipients | `lane/c-recipients` @ `473077a` | S6/S7 complete. 173 tests covering §9.1–§9.7 and S7. Reviewer not run. CCR C-1 approved in `contracts-v3`. `spec-questions/C.md` (SQ-C-01…09). |
| D — Planning & output | `lane/d-planning` @ `9c9051e` | S8 done with tests (51 tests). S9 written but untested (`src/pipeline/s9-plan.ts`, `src/plan/{answers,bridges,schedule,spendable}.ts`, `src/messages/templates.ts`). **S10, S11 (incl. `buildBalanceAnswer`), S12 + execution client not started.** No `spec-questions/D.md` yet. |

Check every lane yourself (`git diff contracts-v2...origin/lane/<x> --stat`, then typecheck, lint and test on it) and
record the real state in `STATUS.md`. Do not trust lane code you have not checked against the spec.

## 4. Phase 1 — finish the lanes

**Budget mode.** Usage ran out fast last time because four Opus lanes, each with sub-agents, ran at once and each
re-read the whole spec. So:

- run **at most two lane agents at a time**: first A + C (closest to done), then B + D;
- give each lane only the spec sections it owns (ORCHESTRATOR_PROMPT §4), plus §0, §8.0, §13.4, §15, §17, §18, instead
  of the whole README;
- each lane gets one Lane Tester and one final Lane Reviewer pass.

Spawn each lane agent with `isolation: "worktree"`, `model: "opus"` and `run_in_background: true`. Its prompt contains:

- its ORCHESTRATOR_PROMPT §6 brief, word for word;
- its "what is left" item (below);
- the §0 model table from this prompt, word for word;
- the skills it should use (§1 above);
- the instruction to read `LANES.md`;
- these exact first commands. Agent worktrees can start from the remote default branch `master`, which is the wrong
  code, so the first command must check out the lane branch:

  ```bash
  git checkout -b lane/<x> origin/lane/<x> && npm ci
  ```

  The lane must then rebase or merge onto `contracts-v3` and apply the CCR follow-ups in the `STATUS.md` CCR log:
  - A: `newAgentRequest()` sets `mentioned_spans: []`;
  - B: drop the local `WithMentioned` type in S5; `src/quarantine/labels.ts` re-exports the catalog's `ITEM_LABEL`;
  - C: drop the local `WithMentioned` type in S7.

What is left per lane:

- **A:** finish the session-runner tests (every `StepResult` kind, `continue` re-entry, `TOO_MANY_RETRIES` on the 4th
  failure, `HANDOFF_FAILED` retry up to 3, every §17.3 row), the routes, reports and settings tests, and every A row of
  `SPEC_CHECKLIST.md`. Then the reviewer.
- **B:** tests for S0, S1 (every secret detector, SSRF, size), S3 (verification rules 1–8, every question and answer
  handler, relative amounts, document amounts, §17.2 step 6), S4, S5 (rules 1–9, follow-ups, `Q_NO_PAYEE`), and the
  Q-LLM marker test (§16.1). Then the reviewer.
- **C:** reviewer pass on all of S6/S7 (`src/recipients/resolve.ts` is large; check it against §9), fix defects, and
  cover any remaining C checklist rows.
- **D:** tests for S9. Then S10 (V-01…V-15, `Q_GROUP_OVER_LIMIT`), S11 (§13.1 summary, §13.2 `buildBalanceAnswer`,
  §13.3), S12 (§8.14 `swap_back`, §12.5 validation, `createExecutionClient`, DB6/DB7 rows, `db8_history`), each with
  tests. Then the reviewer. This is the biggest lane, so give it the most budget.

While lanes run, follow ORCHESTRATOR_PROMPT §2 Phase 1:

- answer CCRs; publish approved ones as `contracts-v4`, …;
- settle spec questions from the spec where you can, and batch the rest for the human in one message;
- keep `STATUS.md` current;
- don't write lane code yourself.

## 5. Phase 2, Phase 3, final acceptance

Follow ORCHESTRATOR_PROMPT §2 Phase 2–3 and §10 exactly:

1. Merge A → B → C → D into `agentic_layer`, one at a time, running the full unit suite after each merge.
2. Create `src/llm/prompt-builder/index.ts`.
3. Wire the `LANES.md` exports into `src/pipeline/registry.ts` and the production factories into `src/index.ts`.
4. Spawn the Acceptance Tester (**Sonnet**) for `test/acceptance/harness.ts` and A-01…A-60.
5. Route each failure to the owning lane's agent (**Opus**) through `SendMessage`.
6. Run the Auditor and the Compliance Reviewer in parallel (**Sonnet**).
7. Then run the Live-Model Evaluator (**Sonnet**). It needs `ollama pull qwen2.5:7b-instruct`, and its wrong-hand-off
   rate must be 0.
8. Write `DEVELOPING.md`.
9. Send the final report.

## 6. Ground rules (ORCHESTRATOR_PROMPT §1, unchanged)

- The spec decides.
- Never invent behaviour. Anything unclear goes into `SPEC_QUESTIONS.md`, and the code path returns `UNSUPPORTED_REQUEST`.
- Contracts are frozen. Changes go through CCRs, published as `contracts-vN`.
- Money only as decimal strings or `bigint`.
- Randomness only from `node:crypto`.
- Logging only through the allowlist.
- No network in unit tests.
- No secrets in commits.
- Conventional commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Interim answers in `SPEC_QUESTIONS.md` stay binding. Still open for the human: SQ-01, 03, 04, 05, 06, 07, 08, 09, 15,
  18 and 22, plus whatever the lanes add. SQ-11 can be closed: Node 22 is used.
- **Ask the human before pushing to GitHub.** Batch every spec question for the human in one message.
