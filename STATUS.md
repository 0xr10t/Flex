# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v2`.

## Lane board

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` | in progress | 0 / 81 | — | 0 | — | — |
| B — Understanding | `lane/b-understanding` | in progress | 0 / 123 | — | 0 | SQ-01, SQ-04, SQ-09 | — |
| C — Recipients | `lane/c-recipients` | in progress | 0 / 73 | — | 0 | SQ-04, SQ-06, SQ-07, SQ-09, SQ-15 | — |
| D — Planning & output | `lane/d-planning` | in progress | 0 / 152 | — | 0 | SQ-05, SQ-08, SQ-15 | — |
| Orchestrator | `agentic_layer` | Phase 0 done | 14 / 85 | 8 / 8 | — | SQ-03, SQ-11, SQ-18 | — |

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
