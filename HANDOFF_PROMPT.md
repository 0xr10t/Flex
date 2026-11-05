# Hand-off prompt (paste this to the next coding agent)

You are taking over as the **Orchestrator** of the agent-layer build in this repository (branch `agentic_layer` of
https://github.com/0xr10t/Flex). A previous Orchestrator finished Phase 0 and started Phase 1, then stopped when its
usage ran out. Continue from where it stopped. Do not start over.

1. Read these fully, in order: `HANDOFF.md` (current state, what is left, decisions, gotchas), `ORCHESTRATOR_PROMPT.md`
   (your role and process; "`main`" there means `agentic_layer` here), `README.md` (the spec, source of truth),
   `LANES.md` (lane conventions and the exact export names you will wire), `STATUS.md`, `SPEC_QUESTIONS.md`, and the
   Totals of `SPEC_CHECKLIST.md`. Then read every file in `src/contracts/`, `src/schemas/index.ts`,
   `src/pipeline/registry.ts` and `test/fakes/`.
2. Run `git fetch origin 'refs/heads/lane/*:refs/remotes/origin/lane/*' --tags`, `npm ci`, `npm run typecheck`,
   `npm run lint` and `npm test` on `agentic_layer`, and confirm they pass.
3. For each of `lane/a-platform`, `lane/b-understanding`, `lane/c-recipients`, `lane/d-planning`:
   - inspect what is there: `git diff contracts-v2...origin/lane/<x> --stat`;
   - run typecheck, lint and test on it;
   - record the real state in `STATUS.md`.
   Do not trust any lane code you haven't checked against the spec.
4. Show me (the human) a short status table and the list of open spec questions, then continue Phase 1. Spawn one
   background lane agent per unfinished lane, each with `isolation: "worktree"`. Give each:
   - its brief from `ORCHESTRATOR_PROMPT.md` §6, word for word;
   - the "what is left" item for that lane from `HANDOFF.md`;
   - an instruction to read `LANES.md`;
   - an explicit first command: `git checkout -b lane/<x> origin/lane/<x>` then `npm ci`. Agent worktrees start from
     `master` otherwise.
   Each lane must use a Lane Tester and a Lane Reviewer sub-agent, commit only to its own branch, and finish with the
   ORCHESTRATOR_PROMPT §8 report.
5. While lanes run, follow ORCHESTRATOR_PROMPT §2 Phase 1 (CCRs, spec questions, `STATUS.md`); don't write lane code
   yourself. Then do Phase 2 (merge A → B → C → D, wire the registry and `src/index.ts`, acceptance harness and
   A-01…A-60), Phase 3 (auditor, compliance reviewer, then live-model evaluator) and the §10 final acceptance.
6. Ground rules (ORCHESTRATOR_PROMPT §1) apply throughout:
   - the spec decides;
   - never invent behaviour: unclear → `SPEC_QUESTIONS.md` plus `UNSUPPORTED_REQUEST`;
   - contracts are frozen, and changes go through CCRs, published as `contracts-v3`, `contracts-v4`, …;
   - money only as decimal strings / bigint; randomness only from `node:crypto`; logging only through the allowlist;
   - no network in unit tests; no secrets in commits;
   - conventional commits ending with your own attribution line.
   Ask me before pushing to GitHub, and batch every spec question for me in one message.
