# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v3`.

## Lane board

Verified 2026-11-06 by the third Orchestrator session (fresh `npm ci`, then typecheck, lint, test on each lane head).
Machine: macOS arm64, **Node 25.9.0** (the human declined installing Node 22 on this machine; see SQ-11).

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` @ `ac4384e` | Phase 1 resumed (runner tests, routes, reports, settings, A rows, reviewer). Not yet rebased on `contracts-v3` | not verified | 170 / 170 (typecheck ✅ lint ✅) | 0 | `spec-questions/A.md` | none |
| B — Understanding | `lane/b-understanding` @ `9c0c3bb` | S0–S5 written; tests for S0/S1/S3/S4/S5 + §16.1 marker test missing. Not yet rebased on `contracts-v3` | not verified | 57 / 57 (typecheck ✅ lint ✅) | B-1, B-2 → approved (contracts-v3) | `spec-questions/B.md` | none |
| C — Recipients | `lane/c-recipients` @ `06d7efa` | **done**, reviewed, on `contracts-v3`, not merged. Phase 2 follow-up: try `PARENT_QUERY` (`ID!`) against a real subgraph; only pinned by text tests so far | 70 implemented + tested, 3 at interim behaviour (C-169, C-195, C-197) / 73 | 220 / 220 (typecheck ✅ lint ✅) | C-1 → approved (contracts-v3) | SQ-C-01, 02, 03, 09, 10, 11 | 2026-11-06, Lane C agent #2 |
| D — Planning & output | `lane/d-planning` @ `9c9051e` | S8 done + tests; S9 written, untested; S10–S12 not started | not verified | 51 / 51 (typecheck ✅ lint ✅) | 0 | none yet | none |
| Orchestrator | `agentic_layer` @ `2125afc` | Phase 1 supervision. typecheck ✅ lint ✅ test 14/14 ✅ | 14 / 85 | 14 / 14 | — | SQ-01, 03–09, 11, 15, 18, 22 | — |

## Agents spawned (model check)

Rule (NEXT_ORCHESTRATOR_PROMPT §0): code writers = Opus 5.5 (`model: "opus"`); testers/reviewers/auditors = Sonnet 5.5 (`model: "sonnet"`).

| Agent | Role | Model | Branch | Started | Result |
| --- | --- | --- | --- | --- | --- |
| Lane A agent #1 | Lane A — Platform (code) | opus | `lane/a-platform` | 2026-11-06 | stopped by the human (account switch); merged contracts-v3, `a2d9b55` |
| Lane C agent #1 | Lane C — Recipients (code) | opus | `lane/c-recipients` | 2026-11-06 | stopped by the human (account switch); merged contracts-v3, `3ec1461`, uncommitted test edits left |
| Lane A agent #2 | Lane A — Platform (code) | opus | `lane/a-platform` | 2026-11-06 | running |
| Lane C agent #2 | Lane C — Recipients (code) | opus | `lane/c-recipients` | 2026-11-06 | done @ `06d7efa`; Orchestrator re-ran typecheck ✅ lint ✅ test 220/220 ✅ |
| Lane C Tester | Lane C tests | sonnet (per report) | `lane/c-recipients` | 2026-11-06 | done; 47 tests, no production bugs |
| Lane C Reviewer | Lane C review | sonnet (per report) | `lane/c-recipients` | 2026-11-06 | done; R-1…R-4 fixed |
| Lane D agent | Lane D — Planning & output (code) | opus | `lane/d-planning` | 2026-11-06 | running |

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

Lane follow-ups after rebasing onto `contracts-v3`: A — `newAgentRequest()` (`src/session/request.ts`) must set
`mentioned_spans: []` (the field is required); B — drop the local `WithMentioned` type in S5 and make
`src/quarantine/labels.ts` re-export the catalog's `ITEM_LABEL`; C — drop the local `WithMentioned` type in S7.

## Merge log

| `agentic_layer` sha | Lane | Date | Unit suite |
| --- | --- | --- | --- |

## Acceptance results (A-01 … A-60)

Not started (Phase 2).
