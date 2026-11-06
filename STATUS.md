# STATUS

Integration branch: `agentic_layer` (plays the role of `main` in ORCHESTRATOR_PROMPT.md). Contracts tag: `contracts-v4`.

## Later conversational follow-up — SQ-CV-01

The user's additional multi-turn failures are tracked as B20–B23 in
[CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md), which records current implementation, independent review,
verification and remaining limits. The original-remediation results below retain their historical revisions;
the handoff checklist incorporates this follow-up. The new instruction supersedes always treating a
pending-question reply as a field value.

Final conversation revision `a05cb9d`: **2,129 unit/acceptance tests and 205 audit checks pass**, with typecheck,
lint and build. All **seven real-model conversational scenarios pass**. The complete **154-case** rerun preserves
**129 exact outcomes, 25 existing stops and zero wrong handoffs/crashes/rejected summaries**; every final signature
matches the earlier remediation. The updated local frontend at **http://127.0.0.1:8791** passes the exact reported
sequence over TCP. Port 8790's existing draft is preserved. Raw evidence and limitations are in the linked report.
The final working-tree rerun also passes all 2,129 tests and 205 audits with no failures, skips or todo tests;
typecheck, lint and build pass.

## Earlier Codex remediation — 2026-11-06

All 19 findings and 3 gaps from `codex_review_report.md` are fixed with permanent regression tests. The formerly pending core
branch and the additional understanding/date fixes are merged. Three Astra/max workers implemented or independently
reviewed the fixes, with production authors and acceptance reviewers separated. The original review used nine Astra/max
reviewers; their evidence remains in the report and `/private/tmp/flex-codex-review/`.

| Check | Verified result before SQ-CV-01 |
| --- | --- |
| Unit + acceptance | **1,874 / 1,874**, 66 files; includes **148 HTTP acceptance cases** in 6 files |
| Separate privacy/security audit | **169 / 169**, including an AST inventory of actual viem network capabilities |
| Typecheck, lint and production build | Passed |
| Production startup and TCP round trip | Passed using real SQLCipher and local fixture RPC/model/executor servers |
| Independent remediation review | No unresolved findings in the assigned B01–B19/G01–G03 scope |
| Full local-model evaluation | **154 cases: 0 wrong handoffs, 25 unexpected stops, 129 exact outcomes; 0 crashes/rejected summaries** on `33518a2`. All **53 final-toolchain repeats** reproduce primary outcomes; gate independently accepted |
| Dependency advisories | **0**, including development dependencies; scoped tooling updates independently reviewed; production package artifacts unchanged |
| UI copy approval | Human selected “Keep these texts”; recorded as SQ-CX-01 |
| Documentation | `DEVELOPING.md`, exact prompt diffs, remediation table, spec decisions and `LIVE_EVALUATION_REPORT.md` written |

That remediation's verification artifacts are under `/private/tmp/flex-codex-fixes/`: `final-tests.json`, `final-audit.json`,
`final-npm-audit.json`, `runtime-final-result.json`, and the independent review reports. Fresh-checkout verification at
`547a36e` also passes all 1,874 tests and 169 audit checks after `npm ci`, typecheck, lint and build; its tracked tree is
clean (`clean-*.log/json`). The full live run kept production inputs frozen. Raw live results are in
`test/live/results/codex-remediation-33518a2.json`.

The prompt-retention criterion passes: wrong handoffs **2 → 0**, unexpected stops **54 → 25**. Six formerly exact
cases now stop safely. No-question initial-response latency is median 14.056 s, p95 30.331 s; 23/93 exceed 20 s.
**The NFR-03 latency target remains unmet.** The S8 first-pass metric is a validation proxy; raw intermediate S8
semantic exact-match was not captured. [LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md) explains these limits.

### Handoff acceptance checklist (§10)

| Item | Evidence / disposition |
| --- | --- |
| 1. Integration and clean-checkout checks | All four lanes and reviewed fixes are on `agentic_layer`, the local integration branch. Isolated checkout `a05cb9d` and the final working tree pass 2,129 tests, typecheck, lint and build. Fresh install was separately checked at `547a36e`; package artifacts are unchanged since then. |
| 2. Spec checklist | **509 implemented/tested +5 approved/tested differences**, including C-514's independently accepted live gate and SQ-CV-01's two routing changes. The 514-row inventory is not blanket compliance with every README requirement. |
| 3. A-01 through A-60 | All original acceptance IDs and A-60 privacy assertions pass within the complete 2,129-test run. Legacy routing fixture adaptations and their independent review are documented in CONVERSATION_FIX_REPORT.md. |
| 4. Privacy/security | No unresolved original review findings; 205 audit checks pass. The earlier production TCP log-privacy checks and dependency audit remain recorded above. |
| 5. Spec/verbatim review | Independent review reconciles the binding human answers, approved prompt text, golden artifacts, three approved example differences and two SQ-CV-01 routing differences. The separate NFR-03 performance limitation remains explicit. |
| 6. Live evaluation | The complete 154-case rerun preserves all prior final signatures: 129 exact, 25 stops, zero wrong handoffs. Seven new real-model conversations and the frontend TCP reproduction pass. Both S8 validation proxies and latency limits are reported separately. |
| 7. Spec questions | Human/spec answers are indexed in `SPEC_QUESTIONS.md`; no question is pending. SQ-CX-01 confirms the three UI texts. |
| 8. Specification and setup | README remains unchanged. `DEVELOPING.md` covers native modules, keychain, token files, config, Ollama, all suites and server startup. |

The original README, four LLM schemas, handoff schema, and v1 DDL remain unchanged. The encrypted submission journal
is an additive v2 migration. `SPEC_QUESTIONS.md` documents report correlation, monotonic updates, confirmation-time
validation, and why retries cannot change an already-submitted autopay envelope.

`HANDOFF_PROMPT.md` records the work performed and is retained. No branch/tag has been pushed and no worktree or process file has
been deleted. The original frontend and its active draft remain available on port 8790; the corrected runtime is on 8791.

The lane board and session logs below are historical records. They do not supersede this current status.

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
| Privacy & Security Auditor | §3.2 | sonnet | `phase3/audit` (from `69bbbf1`) | 2026-11-06 | done @ `c548096`, merged `ab8d665`; 2 violations (spec gaps: SQ-O-06, SQ-O-01), 8 observations; 142 audit tests |
| Fix-up agent (O6, O7, contract tests) | Phase 3 fixes | opus (+ sonnet tester) | `phase3/fixes` (from `ab8d665`) | 2026-11-06 | running |
| Spec Compliance Reviewer | §3.3 | sonnet | `phase3/compliance` (from `69bbbf1`) | 2026-11-06 | done @ `a4d840d`, merged; 503 tested / 6 no test / 1 missing / 4 deviates (all known SQs); verbatim artefacts identical |
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
| `contracts-v2` | 2026-11-06 | `src/contracts/money.ts` (decimal/base-unit/short-address helpers), `LANES.md` (export names, conventions; removed after Phase 2) |
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
| `ab8d665` | Phase 3 audit tests (`phase3/audit`) | 2026-11-06 | ✅ 1416 + audit 142 |
| `7a4d8f0` | Phase 3 fixes O6, O7, contract tests (`phase3/fixes`) | 2026-11-06 | ✅ 1501 + audit 142 |
| `c11b465` | Human answers implemented: `phase4/core` @ `5e5f443` (contracts-v4 `eef4dcf`) + `phase4/understanding` @ `1f7e4a3` | 2026-11-06 | ✅ 1652/1652 + audit 154/154; no `it.fails` left; build ✅ |

## Acceptance results (A-01 … A-60)

Run 1 (2026-11-06, `7c8db03`): 46 pass, 24 fail: A-01, 02, 03, 04, 06, 08, 10, 11, 12, 14, 15, 22, 24, 26, 30, 36, 38, 40, 44, 47, 51, 57, 60.
Most envelope diffs are non-EIP-55 example addresses in the expectations; A-60's 1,141 hits are all the bare value "4".
Triage by the Acceptance Tester (sonnet): 20 test-side fixes (non-EIP-55 example addresses, fixture trims, A-60 scanner
matching bare digits in numeric fields), 0 lane defects, 3 spec conflicts asserted at interim behaviour.

Run 2 (2026-11-06, `311a409`): **70 / 70 green**. Caveats: A-57 is `it.fails` (SQ-O-03, P4 rejects the row's pairing);
A-08 asserts the §10.6 `expires_at` (SQ-D-15); A-30 asserts the §15 template (SQ-08); A-44 "me" gives `Q_NO_PAYEE` (SQ-O-05).
A-60: 0 hits for registered addresses, names, ENS names, amounts and prompt fragments ≥ 12 characters.

## Standing decisions and gotchas

- 2026-11-06 review swarm (6 Opus reviewers on `d5389df`): 19 code defects, none critical; the most serious was a session close/open racing an in-flight hand-off (possible double payment). Human answered SQ-R-01…06. Fix round: `phase6/fixes-core` (A, D, contracts) and `phase6/fixes-understanding` (B, C), both from `7af6321`, Opus + one Sonnet tester each. The live-model evaluation (`phase5/live`) is still running.

- Interim wording added by the core agent (not covered by an answer; confirm at final acceptance): the `Q_PAIR_AMOUNT` re-ask hint "That would leave {name} with nothing."; `Q_LIMIT_OVERRIDE` chips "Yes, this once" / "Yes, set it up" / "No"; the daily fragment "today's limit of {daily_max} (only {remaining} is left)".

- 2026-11-06, human decision: the post-answers deep review swarm runs on **Opus** reviewers (an exception to the Sonnet-reviews rule, for this review only). The live-model evaluation runs against the local Ollama `qwen2.5:7b-instruct` (installed 2026-11-06).

- Orchestrator-owned (change only through the Orchestrator): `src/contracts/`, `src/schemas/`, `src/db/schema.sql`, `src/pipeline/registry.ts`, `src/llm/prompt-builder/index.ts`, `test/fakes/`, root config. CCRs B-1, B-2, C-1 (approved) and D-1 (rejected) are logged in the CCR table below; their files were removed after Phase 2.

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
