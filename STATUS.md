# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v2`.

## Lane board

Verified by the Orchestrator on 2026-11-05 (Node 22.23.4, clean `npm ci`), each lane checked out at its pushed head.

| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A — Platform | `lane/a-platform` @ `3f9ca24` | in progress (resumed Phase 1). Code for config, keychain, SQLCipher open/migrate, DB1–DB8 repos, logger + rotation, Fastify app (sessions/settings/reports), session manager + runner. typecheck ✅ lint ✅ test ✅ | not verified (0 lane tests) | 14/14 (Orchestrator tests only; **no Lane A tests**) | 0 | SQ-A-01, SQ-A-02 cited in code but `spec-questions/A.md` never committed | none |
| B — Understanding | `lane/b-understanding` @ `55c4642` | in progress (resumed Phase 1). Parser, secrets, URLs, SSRF fetcher, lexical + chrono, 4 prompt files (checked verbatim ✅) + builders, Ollama client, Q-LLM, S0–S2. **S3, S4, S5 missing.** typecheck ✅ lint ✅ test ✅ | not verified (0 lane tests) | 14/14 (**no Lane B tests**) | 0 | SQB-08 cited in code but `spec-questions/B.md` never committed; SQ-01, SQ-04, SQ-09 | none |
| C — Recipients | `lane/c-recipients` @ `a6be84d` | in progress (resumed Phase 1). S6 (`recipients/resolve.ts`), S7, names/address/ENS/group, ENS client, subname source; names suite partial. typecheck ✅ **lint ❌ (prettier: `test/unit/C/names.test.ts`)** test ✅ | not verified | 53/53 (39 lane tests) | 0 | SQ-04, SQ-06, SQ-07, SQ-09, SQ-15 | none |
| D — Planning & output | `lane/d-planning` @ `cc981ba` | in progress (resumed Phase 1). Only WIP tests for S8 + LLM #4 prompt. **typecheck ❌** (imports missing `s8-pair.ts`, `prompt-builder/payments.ts`), **lint ❌** (prettier ×3), **test ❌** (2 files fail to load). All of S8–S12 to do | 0 / 152 | 14 pass, 2 files fail | 0 | SQ-05, SQ-08, SQ-15 | none |
| Orchestrator | `agentic_layer` @ `239f734` | Phase 1 supervision. typecheck ✅ lint ✅ test 14/14 ✅ build ✅ | 14 / 85 | 14 / 14 | — | SQ-03, SQ-11, SQ-18 | — |

Phase 1 resumed 2026-11-05: one background lane agent per lane (A, B, C, D), each in its own worktree on its lane branch.

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
