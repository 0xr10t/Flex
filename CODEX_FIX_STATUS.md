# Review remediation and handoff completion

Work requested on 2026-11-06: fix the findings and gaps in `codex_review_report.md` and execute `HANDOFF_PROMPT.md`.
All **19 findings and 3 gaps** have fixes, permanent regressions and independent review. README remains the original
specification; historical review and handoff instructions are retained.

Later SQ-CV-01 findings **B20–B23** are also fixed and independently tested. Frozen revision `a05cb9d` passes
**2,129 unit/acceptance tests, 205 audits, seven real-model conversation scenarios**, typecheck, lint and build.
The full 154-case rerun preserves **129 exact outcomes, 25 stops and zero wrong handoffs/crashes/rejected summaries**.
The updated frontend is running at **http://127.0.0.1:8791**; its TCP conversation check passes. See
[CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md) for the later changes, raw results and remaining limits.
The workstream table and earlier verification below record the original remediation.

| Workstream | Owner / checkout | Current state |
| --- | --- | --- |
| Existing core branch, independent tests, P10 interval regression | Astra/max review; root repairs | Merged and independently verified, including interval-one and donor-rounding edge fixes |
| B01, B11–B15: amounts, contact boundaries, tokens, masking, actions, URLs | Astra/max author and separate reviewer | Merged; deterministic regressions pass |
| B16–B17: DST and reversed date ranges | Astra/max author and separate reviewer | Merged; timezone, reversed-range and optional-preposition regressions pass |
| B03–B04, B19, G02: execution identity, replay, persistence, early callbacks | Root; Astra/max independent tester | Durable encrypted journal and atomic pre-submit reservations; real disk-full/reopen/early-callback tests pass |
| B08: secret screening for answers | Root; Astra/max independent tester | Both answer entrypoints scanned before persistence; raw/encoded-secret regressions pass |
| G01 explicit chain binding; G03 stale confirmation | Root; Astra/max independent tester | Clause/document chain checks, current settings/balance validation and renewed confirmation verified |
| Development dependency fixes | Astra/max author and separate reviewer | Integrated; npm audit 0, production dependency artifacts unchanged |
| Full live-model set | Root; Astra/max independent grader | 154 cases: 0 wrong handoffs, 25 stops, 129 exact outcomes; all 53 final-toolchain repeats reproduce primary outcomes; retention gate accepted |
| Compliance/security and developing guide | Astra/max reviewers; root integration | 1,874 tests +169 audit checks pass; guide, prompt diffs and current compliance evidence written |

## Implementation decisions

- User authorization to fix the reported gaps includes durable execution correlation and confirmation-time validation. These are explicit hardening changes to the original protocol, not claims that the original specification already required the missing behavior.
- An additive SQLCipher migration adds `handoff_journal`; the original `schema.sql` stays unchanged. The journal stores the immutable confirmed envelope under its original idempotency key before external submission. DB6/DB7 reservations are committed in the same transaction. Session history in the journal is temporary and cleared with all other session data.
- Ambiguous transport failures retain the reservation and identity. A definite rejection releases spend reservations. Valid callbacks can arrive before the submission response and remain applicable after restart. Executed spend cannot be reverted by replay, and cancelled/ended autopays cannot be reactivated by stale creation callbacks.
- Full live evaluation uses local Ollama and fake chain/execution services, with zero real payments or signing. Its SQ-L-01 prompt gate passes: wrong handoffs 2 → 0 and unexpected stops 54 → 25. All changed outcomes are repeated separately; the primary rows are retained.
- Existing branches/worktrees and process documents are retained. No push or deletion is part of this work.

Fresh-checkout evidence at `547a36e`: `npm ci`, typecheck, lint, build, all 1,874 unit/acceptance tests and 169 audit
checks pass. The final production TCP startup/report/session smoke test also passes. The human approved keeping all
three previously interim UI texts (SQ-CX-01).

Remaining limits are explicit: 25 primary harness stops, six baseline successes now stopping safely, and NFR-03's
20-second target not met. Raw intermediate S8 semantic exact-match is not measured; the reported first-pass proxy is
labeled separately from exact expected-plan outcomes. See [LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md),
[STATUS.md](STATUS.md), and [COMPLIANCE_REPORT.md](COMPLIANCE_REPORT.md) for evidence and scope.
