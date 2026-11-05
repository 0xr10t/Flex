# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v2`.

## Lane board

Snapshot 2026-11-05 after the resumed Phase 1 lane agents were **stopped by the human** mid-work. Nothing on the lane
branches below is pushed: the commits are local to this container (branches `lane/*`), and the uncommitted files sit in
the agent worktrees under `.claude/worktrees/agent-*`. Not re-verified (typecheck/lint/test) after the stop; no lane
reached its Lane Reviewer or wrote a §8 report.

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` @ `2f706f3` (local, +1 over origin `3f9ca24`) | stopped. Commit: messages while `HANDOFF_FAILED` fix + `spec-questions/A.md`. Uncommitted: `src/config/load.ts` change, 9 test files in `test/unit/A/` (config, pragmas, db, ids, logger, repos, session harness/tests — session runner tests were in progress) | not verified | not verified | 0 | `spec-questions/A.md` (SQ-A-01…) | none |
| B — Understanding | `lane/b-understanding` @ `866f358` (local, +1 over origin `55c4642`) | stopped. Commit: S3, S4, S5 with answer handlers. Uncommitted: `test/unit/B/{lexical,parse,secrets}.test.ts` | not verified | not verified | B-1, B-2 → approved in contracts-v3 | `spec-questions/B.md` (SQB-01…; SQB-02 → SQ-22) | none |
| C — Recipients | `lane/c-recipients` @ `473077a` (local, +7 over origin `a6be84d`) | stopped. Commits: prettier fix, S6 fixes, tests for §9.2–§9.7 and S7. Nothing uncommitted | not verified | not verified | C-1 → approved in contracts-v3 | `spec-questions/C.md` (SQ-C-01…09) | none |
| D — Planning & output | `lane/d-planning` @ `8c61351` (local, +1 over origin `cc981ba`) | stopped. Commit: S8 (LLM #4 prompt builder, per-request schema, P1–P9, correction retry). Uncommitted (S9 started): `src/pipeline/s9-plan.ts`, `src/plan/{answers,bridges,schedule,spendable}.ts`, `src/messages/templates.ts`, `test/unit/D/parse-mock.ts`. S10–S12 not started | not verified | not verified | 0 | none written yet | none |
| Orchestrator | `agentic_layer` | Phase 1 supervision; contracts-v3 published. typecheck ✅ lint ✅ test 14/14 ✅ | 14 / 85 | 14 / 14 | — | SQ-03, SQ-11, SQ-18, SQ-22 | — |

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
