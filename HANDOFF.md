# HANDOFF — continuing the agent-layer build

Written 2026-11-06 when the previous Orchestrator session ran out of usage. Read this first, then
`ORCHESTRATOR_PROMPT.md` (the process), `README.md` (the spec, source of truth), `LANES.md` (lane conventions and the
export names Phase 2 will wire), `STATUS.md`, `SPEC_CHECKLIST.md` and `SPEC_QUESTIONS.md`.

## Update 2026-11-05 (second Orchestrator session) — read this first

- **Phase 1 was resumed**: one lane agent per lane, spawned with the prompts the new Orchestrator wrote (template in
  `STATUS.md` history; each = ORCHESTRATOR_PROMPT §6 brief verbatim + the "what is left" item below + lane specifics).
  **The human then stopped all four agents mid-work.** No lane reached its reviewer or wrote a §8 report.
- **`contracts-v3` published** on `agentic_layer`:
  - CCR B-2 / C-1 add `AgentRequest.mentioned_spans` (S5 → S7 `[person]` masking);
  - CCR B-1 adds `ITEM_LABEL` to the catalog, with interim wording pending SQ-22.

  See the CCR log in `STATUS.md` for what each lane must change after rebasing onto `contracts-v3`.
- **New lane work is NOT on GitHub.** The session had no push access. The new lane commits (A +1, B +1, C +7, D +1)
  and the uncommitted lane files exist only in that container, or in the bundle/archive handed to the human (see
  `STATUS.md` for the exact list). Restore them before resuming, or redo that work from the `origin/lane/*` heads below.
- New spec rulings: SQ-21 (answered: LLM #4 prompt `// …` remarks are annotations, not prompt text). SQ-22 is open.
  SQ-11: Node 22.23.4 is available in the cloud environment.
- **Testing sub-agents must run on Claude Sonnet** (`model: "sonnet"`), as the human asked.

## Where things stand (as of the first hand-off)

**Phase 0: done.** It is on `agentic_layer`, tagged `contracts-v1` and then `contracts-v2`:

- repo skeleton (spec §21 layout) and tooling (TypeScript 5.9 strict ESM, ESLint 9, Prettier, Vitest 3), with §5 dependencies pinned exactly;
- `config.example.json`, `src/db/schema.sql` and the JSON Schemas in `src/schemas/`, all copied unchanged from the spec;
- frozen contracts in `src/contracts/` (types, step, repos, llm, io, catalog, static-tables, money);
- `src/pipeline/registry.ts`, where every step is a stub returning `UNSUPPORTED_REQUEST`;
- test fakes in `test/fakes/`;
- `SPEC_CHECKLIST.md` (514 items, one owner each), `SPEC_QUESTIONS.md` (20 entries, 11 open for the human) and `STATUS.md`.

On `agentic_layer`, `npm run typecheck`, `npm run lint`, `npm test` (14 tests) and `npm run build` all pass.

**Phase 1 (four parallel lanes): started, then stopped partway by the user.** Each lane branch is pushed. None has been
through its Lane Reviewer. None is merged.

| Lane | Branch | What is on it | Checked at hand-off |
| --- | --- | --- | --- |
| A — Platform | `lane/a-platform` (`3f9ca24`) | config load/defaults/tokens, SQLCipher open + keychain + migrate, every DB1–DB8 repository, allowlist logger + rotating file, Fastify app with sessions/settings/reports routes, session manager + request runner | typecheck OK, lint OK, tests pass, but **no Lane A unit tests yet** (only the 14 Orchestrator tests run) |
| B — Understanding | `lane/b-understanding` (`55c4642`) | amount parser, secret detectors, URL handling, SSRF fetcher, lexical scan + chrono, the four prompt `.txt` files and builders, Ollama client, Q-LLM extraction, steps S0, S1, S2 | typecheck OK, lint OK, tests pass, but **no Lane B unit tests yet**; **S3, S4, S5 not written** |
| C — Recipients | `lane/c-recipients` (`a6be84d`) | names, addresses, ENS + ENS client, ENS re-check, groups + subname source, S6 resolve, S7 mask | typecheck OK, lint OK, **53 tests pass** (39 lane tests, names suite partly written); reviewer pass not run |
| D — Planning & output | `lane/d-planning` (`cc981ba`) | only WIP tests for S8 and the LLM #4 prompt (`test/unit/D/`) | **does not typecheck**: the tests import `src/pipeline/s8-pair.ts` and `src/llm/prompt-builder/payments.ts`, which don't exist yet. All of S8–S12 is still to do |

The previous lane agents did not leave Lane reports, CCRs (`ccr/`) or new spec questions (`spec-questions/`). Treat
everything on the lane branches as unreviewed and check it against the spec before relying on it.

## What is left (in order)

1. **Finish Phase 1** for each lane, using the lane briefs in `ORCHESTRATOR_PROMPT.md` §6 plus the "Lane X specifics" in
   `LANES.md` / below.
   - A: write the Lane A unit tests (§20.1 session + logging rows, every A row of `SPEC_CHECKLIST.md`), then check the
     runner against the `src/contracts/step.ts` header semantics and the §17.3 table, then run the reviewer.
   - B: S3 (§8.4), S4 (§8.5), S5 (§8.6) with their answer handlers; then every Lane B unit test (secrets, lexical,
     parser, verify, Q-LLM marker test §16.1), then the reviewer.
   - C: finish `test/unit/C/names.test.ts` and the remaining C checklist rows, then the reviewer.
   - D: everything: S8 (§8.9 + LLM #4 prompt), S9 (§10), S10 (§11), S11 (§13.1–§13.3 incl. `buildBalanceAnswer`),
     S12 (§8.14 + execution client), with tests, then the reviewer.
2. **Phase 2 (integration):** merge into `agentic_layer` in the order A → B → C → D, one at a time, running the full unit suite after each merge.
   Then:
   - create `src/llm/prompt-builder/index.ts`;
   - wire the real step exports (`LANES.md` table) into `src/pipeline/registry.ts`;
   - wire the production factories in `src/index.ts`;
   - build `test/acceptance/harness.ts` and A-01…A-60 (ORCHESTRATOR_PROMPT §3.1).
3. **Phase 3:**
   - Privacy & Security Auditor (§3.2) and Spec Compliance Reviewer (§3.3), in parallel;
   - then the Live-Model Evaluator (§3.4). It needs `ollama pull qwen2.5:7b-instruct`; the model is not pulled on the original machine.
4. **Final acceptance:** ORCHESTRATOR_PROMPT §10, including a short `DEVELOPING.md`.

## Decisions already taken (binding)

- `agentic_layer` plays the role of "`main`" from ORCHESTRATOR_PROMPT.md. Lane branches are `lane/<letter>-<name>` from `contracts-v2`.
- TypeScript is pinned to 5.9.3: the spec says 5.x, and 7.x conflicts with typescript-eslint.
- The §6.2 word lists, the chip matcher (`matchChip`) and the money helpers live in `src/contracts/` so lanes don't
  depend on each other for them.
- Runner semantics (header of `src/contracts/step.ts`):
  - an AnswerHandler returning `continue` re-runs the same step, so steps must be re-entrant through `req.step_state`;
  - `error.final_state` can be `ANSWERED` for refusals;
  - `discard` ends the request as DISCARDED;
  - when S12 returns `EXECUTION_UNAVAILABLE`, the runner sets `HANDOFF_FAILED`.
- Cross-lane functions are imported from the owning lane's file and mocked (`vi.mock`) until that lane merges:
  - `parseAmountText` from `src/amounts/parse.ts` (B);
  - `buildBalanceAnswer` from `src/messages/balance.ts` (D);
  - `newId` from `src/util/ids.ts` (A).
- Interim answers SQ-01…SQ-20 in `SPEC_QUESTIONS.md` stay in force until the human answers. Still open: SQ-01, 03, 04, 05, 06, 07, 08, 09, 11, 15, 18.

## Gotchas found so far

- **Agent worktrees start from the remote default branch (`master`, commit `17ce490`), not from `agentic_layer`.**
  After a worktree is created, run `git checkout -b lane/<x> origin/lane/<x>` (to continue a lane) or
  `git checkout -b … contracts-v2` before reading files.
- Agent worktrees live under `.claude/worktrees/`. That folder is in `.gitignore` and excluded from lint, format and Vitest on `agentic_layer`.
- `npm ci` is needed in every fresh checkout or worktree (`better-sqlite3-multiple-ciphers` is a native module; it builds fine on Node 22/23 on macOS arm64).
- The spec asks for Node 22 LTS. The original machine had Node 23.11.1 (SQ-11 open). `package.json` has `engines.node >= 22`.
- Lane B left an uncommitted `.scratch/chr.mjs` (a chrono experiment) in its old worktree. It was not pushed, and nothing is lost.

## How to resume

```bash
git clone --branch agentic_layer https://github.com/0xr10t/Flex.git && cd Flex
git fetch origin 'refs/heads/lane/*:refs/remotes/origin/lane/*' --tags
npm ci && npm run typecheck && npm run lint && npm test
```

Then give your coding agent the prompt in **HANDOFF_PROMPT.md**.
