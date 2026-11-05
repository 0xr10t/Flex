# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v2`.

## Lane board

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` @ `3f9ca24` | stopped partway (pushed, unreviewed) | not verified | 14/14 (no lane tests yet) | 0 | — | none (agent stopped) |
| B — Understanding | `lane/b-understanding` @ `55c4642` | stopped partway: S0–S2 written, S3–S5 missing | not verified | 14/14 (no lane tests yet) | 0 | SQ-01, SQ-04, SQ-09 | none (agent stopped) |
| C — Recipients | `lane/c-recipients` @ `a6be84d` | stopped partway: S6/S7 written, tests partial | not verified | 53/53 | 0 | SQ-04, SQ-06, SQ-07, SQ-09, SQ-15 | none (agent stopped) |
| D — Planning & output | `lane/d-planning` @ `cc981ba` | stopped early: WIP S8 tests only, does not typecheck | 0 / 152 | 14 pass, 2 files fail (missing modules) | 0 | SQ-05, SQ-08, SQ-15 | none (agent stopped) |
| Orchestrator | `agentic_layer` | Phase 0 done | 14 / 85 | 8 / 8 | — | SQ-03, SQ-11, SQ-18 | — |

See HANDOFF.md for the continuation plan (session ended on usage limit, 2026-11-06).

## Contract versions

| Tag | Date | Changes |
| --- | --- | --- |
| `contracts-v1` | 2026-11-06 | Initial contracts: types, step, repos, llm, io, catalog, static tables, schemas, schema.sql, registry stubs, test fakes |
| `contracts-v2` | 2026-11-06 | `src/contracts/money.ts` (decimal/base-unit/short-address helpers), `LANES.md` (export names, conventions) |

## Merge log

| `agentic_layer` sha | Lane | Date | Unit suite |
| --- | --- | --- | --- |

## Acceptance results (A-01 … A-60)

Not started (Phase 2).
