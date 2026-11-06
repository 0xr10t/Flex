# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v3`.

## Lane board

Verified 2026-11-06 by the third Orchestrator session (fresh `npm ci`, then typecheck, lint, test on each lane head).
Machine: macOS arm64, **Node 25.9.0** (the human declined installing Node 22 on this machine; see SQ-11).

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` @ `6029674` | **done**, reviewed, on `contracts-v3`, not merged. Phase 2: C-039, C-050, C-431 can only be proven once S1/S12 and the LLM logging are wired | 78 implemented + tested, 3 partial (other lanes' step code) / 81 | 439 / 439 (typecheck ✅ lint ✅) | 0 | SQ-A-01…08 | 2026-11-06, Lane A agent #2 |
| B — Understanding | `lane/b-understanding` @ `9c0c3bb` | S0–S5 written; tests for S0/S1/S3/S4/S5 + §16.1 marker test missing. Not yet rebased on `contracts-v3` | not verified | 57 / 57 (typecheck ✅ lint ✅) | B-1, B-2 → approved (contracts-v3) | `spec-questions/B.md` | none |
| C — Recipients | `lane/c-recipients` @ `06d7efa` | **done**, reviewed, on `contracts-v3`, not merged. Phase 2 follow-up: try `PARENT_QUERY` (`ID!`) against a real subgraph; only pinned by text tests so far | 70 implemented + tested, 3 at interim behaviour (C-169, C-195, C-197) / 73 | 220 / 220 (typecheck ✅ lint ✅) | C-1 → approved (contracts-v3) | SQ-C-01, 02, 03, 09, 10, 11 | 2026-11-06, Lane C agent #2 |
| D — Planning & output | `lane/d-planning` @ `9c9051e` | S8 done + tests; S9 written, untested; S10–S12 not started | not verified | 51 / 51 (typecheck ✅ lint ✅) | 0 | none yet | none |
| Orchestrator | `agentic_layer` @ `2125afc` | Phase 1 supervision. typecheck ✅ lint ✅ test 14/14 ✅ | 14 / 85 | 14 / 14 | — | SQ-01, 03–09, 11, 15, 18, 22 | — |

## Agents spawned (model check)

Rule (see `Standing decisions and gotchas` below): code writers = Opus 5.5 (`model: "opus"`); testers/reviewers/auditors = Sonnet 5.5 (`model: "sonnet"`).

| Agent | Role | Model | Branch | Started | Result |
| --- | --- | --- | --- | --- | --- |
| Lane A agent #1 | Lane A — Platform (code) | opus | `lane/a-platform` | 2026-11-06 | stopped by the human (account switch); merged contracts-v3, `a2d9b55` |
| Lane C agent #1 | Lane C — Recipients (code) | opus | `lane/c-recipients` | 2026-11-06 | stopped by the human (account switch); merged contracts-v3, `3ec1461`, uncommitted test edits left |
| Lane A agent #2 | Lane A — Platform (code) | opus | `lane/a-platform` | 2026-11-06 | done @ `6029674`; Orchestrator re-ran typecheck ✅ lint ✅ test 439/439 ✅ |
| Lane A Tester | Lane A tests | sonnet (per report) | `lane/a-platform` | 2026-11-06 | done; 269 tests |
| Lane A Reviewer | Lane A review | sonnet (per report) | `lane/a-platform` | 2026-11-06 | done; 6 defects + N1 fixed; `ecdb941` read by the Orchestrator |
| Lane B agent #1 | Lane B — Understanding (code) | opus | `lane/b-understanding` | 2026-11-06 | stopped by the human @ `538613c` (contracts-v3 merged only) |
| Lane B agent #2 | Lane B — Understanding (code) | opus | `lane/b-understanding` | 2026-11-06 | done @ `fcbfc77`; verified 297/297; merged |
| Docs clean-up agent | delete obsolete docs | sonnet | `agentic_layer` | 2026-11-06 | done @ `8d7556d` |
| Acceptance Tester | §3.1 harness + A-01…A-60 | sonnet | `phase2/acceptance` (from `186e548`) | 2026-11-06 | done @ `9c9cc6f`; 70/70; merged |
| Lane C agent #2 | Lane C — Recipients (code) | opus | `lane/c-recipients` | 2026-11-06 | done @ `06d7efa`; Orchestrator re-ran typecheck ✅ lint ✅ test 220/220 ✅ |
| Lane C Tester | Lane C tests | sonnet (per report) | `lane/c-recipients` | 2026-11-06 | done; 47 tests, no production bugs |
| Lane C Reviewer | Lane C review | sonnet (per report) | `lane/c-recipients` | 2026-11-06 | done; R-1…R-4 fixed |
| Lane D agent #1 | Lane D — Planning & output (code) | opus | `lane/d-planning` | 2026-11-06 | stopped by the human @ `a22c6d0` (S10–S12 committed; tester's S9 tests uncommitted, 1 failing: C-188) |
| Lane D agent #2 | Lane D — Planning & output (code) | opus | `lane/d-planning` | 2026-11-06 | done @ `71607d0`; verified 432/432; merged |

## Skills available in this session

After the account switch all of these are installed: `engineering:testing-strategy`, `engineering:code-review`,
`engineering:debug`, `engineering:architecture`, `engineering:documentation`, `engineering:deploy-checklist`,
`security-review`, `simplify`, `run`.

## Contract versions

| Tag | Date | Changes |
| --- | --- | --- |
| `contracts-v1` | 2026-11-06 | Initial contracts: types, step, repos, llm, io, catalog, static tables, schemas, schema.sql, registry stubs, test fakes |
| `contracts-v2` | 2026-11-06 | `src/contracts/money.ts` (decimal/base-unit/short-address helpers), `LANES.md` (export names, conventions) |
| `contracts-v3` | 2026-11-05 | CCR B-2 + C-1 (same change): `AgentRequest.mentioned_spans: Span[]` (S5 → S7 `[person]` masking, §8.6 rule 6, §8.8) and `mentioned_spans: []` in `test/fakes/context.ts`; CCR B-1: `ITEM_LABEL` in `src/contracts/catalog.ts` (`{item}` slot, interim wording SQ-22) |

## CCR log

| CCR | Lane | Ruling | Version |
| --- | --- | --- | --- |
| B-1 | B | APPROVED (interim wording, SQ-22): user-facing text belongs in the catalog (ORCHESTRATOR_PROMPT §5.7) | contracts-v3 |
| B-2 | B | APPROVED: §8.6 rule 6 / §8.8 need the mentioned spans carried from S5 to S7; in memory only (§16.2) | contracts-v3 |
| C-1 | C | APPROVED: identical to B-2 | contracts-v3 |
| D-1 | D | REJECTED (no change needed): §21 assigns `src/messages/` the summary and balance texts, so `src/messages/templates.ts` is their home | — |

Lane follow-ups after rebasing onto `contracts-v3`: A — `newAgentRequest()` (`src/session/request.ts`) must set
`mentioned_spans: []` (the field is required); B — drop the local `WithMentioned` type in S5 and make
`src/quarantine/labels.ts` re-export the catalog's `ITEM_LABEL`; C — drop the local `WithMentioned` type in S7.

## Merge log

| `agentic_layer` sha | Lane | Date | Unit suite |
| --- | --- | --- | --- |
| `186e548` | A — Platform (`lane/a-platform` @ `6029674`) | 2026-11-06 | typecheck ✅ lint ✅ 439/439 ✅ |
| `65ba941` | B — Understanding (`lane/b-understanding` @ `fcbfc77`) | 2026-11-06 | ✅ 722/722 |
| `179cce6` | C — Recipients (`lane/c-recipients` @ `06d7efa`) | 2026-11-06 | ✅ 928/928 |
| `e7a4b20` | D — Planning & output (`lane/d-planning` @ `71607d0`) | 2026-11-06 | ✅ 1346/1346 |
| `1823dff` | Orchestrator wiring: registry, prompt-builder index, production factories, entry point | 2026-11-06 | ✅ 1346/1346, build ✅ |
| `7c8db03` | Acceptance suite (`phase2/acceptance` @ `d4f0c9b`) | 2026-11-06 | unit 1346/1346; acceptance 46/70 |
| `311a409` | Acceptance triage (`phase2/acceptance` @ `9c9cc6f`) | 2026-11-06 | ✅ 1416/1416 (unit 1346 + acceptance 70) |

## Acceptance results (A-01 … A-60)

Run 1 (2026-11-06, `7c8db03`): 46 pass, 24 fail: A-01, 02, 03, 04, 06, 08, 10, 11, 12, 14, 15, 22, 24, 26, 30, 36, 38, 40, 44, 47, 51, 57, 60.
Most envelope diffs are non-EIP-55 example addresses in the expectations; A-60's 1,141 hits are all the bare value "4".
Triage by the Acceptance Tester (sonnet): 20 test-side fixes (non-EIP-55 example addresses, fixture trims, A-60 scanner
matching bare digits in numeric fields), 0 lane defects, 3 spec conflicts asserted at interim behaviour.

Run 2 (2026-11-06, `311a409`): **70 / 70 green**. Caveats: A-57 is `it.fails` (SQ-O-03, P4 rejects the row's pairing);
A-08 asserts the §10.6 `expires_at` (SQ-D-15); A-30 asserts the §15 template (SQ-08); A-44 "me" gives `Q_NO_PAYEE` (SQ-O-05).
A-60: 0 hits for registered addresses, names, ENS names, amounts and prompt fragments ≥ 12 characters.

## Standing decisions and gotchas

- Model rule, set by the human. Anyone who writes or changes production code under `src/**` (the four lane agents and
  any fix-up agent) runs on Opus 5.5 (`model: "opus"`). Anyone who tests, reviews or verifies runs on Sonnet 5.5
  (`model: "sonnet"`). That covers Lane Testers (even when they write `test/**`), Lane Reviewers, the Acceptance
  Tester, the Privacy & Security Auditor, the Spec Compliance Reviewer and the Live-Model Evaluator.
- Always pass `model` explicitly on every Agent call, because a sub-agent otherwise inherits its parent's model. Tell
  each lane agent to start its tester and reviewer with `model: "sonnet"` and to name the model of each sub-agent in
  its report. If an agent ran on the wrong model, discard its verdict and re-run it.
- A tester that finds a bug reports it. It does not fix production code; the Opus lane or fix-up agent does. An Opus
  agent does not grade its own work.
- Skills that fit: `engineering:testing-strategy` for tests, `engineering:code-review` for reviews and merges,
  `engineering:debug` for failures, `security-review` for the auditor, `simplify` for a clean-up pass,
  `run` to drive the server end to end, `engineering:documentation` for `DEVELOPING.md`.
- Ask the human before pushing to GitHub, and batch every spec question for the human into one message.
- TypeScript is pinned to 5.9.3: the spec says 5.x, and 7.x conflicts with typescript-eslint.
- Agent worktrees start from the remote default branch `master`, which has none of the project files. The first
  command in a lane worktree must be `git checkout -b lane/<x> origin/lane/<x> && npm ci` (or branch from the right
  contracts tag for a new lane).
- Agent worktrees live under `.claude/worktrees/`, which is in `.gitignore` and excluded from lint, format and Vitest
  on `agentic_layer`. Never edit files there from the main checkout.
- `npm ci` is needed in every fresh checkout or worktree: `better-sqlite3-multiple-ciphers` is a native module.
