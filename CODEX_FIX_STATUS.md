# Review remediation and handoff completion

Active work requested on 2026-11-06: fix all findings and gaps in `codex_review_report.md` and complete `HANDOFF_PROMPT.md`. The review report is retained as historical evidence. README remains the original specification.

| Workstream | Owner / checkout | Current state |
| --- | --- | --- |
| Existing core branch, independent tests, P10 interval regression | Astra max, `/private/tmp/flex-codex-fixes/core` | Reviewing and repairing tests; explicit interval-one bug fixed by root for independent retest |
| B01, B11–B15: amounts, contact boundaries, tokens, masking, actions, URLs | Astra max, `/private/tmp/flex-codex-fixes/understanding` | Implementation and regression tests |
| B16–B17: DST and reversed date ranges | Astra max, `/private/tmp/flex-codex-fixes/schedules` | Implementation and regression tests |
| B03–B04, B19, G02: execution identity, replay, persistence, early callbacks | Root | Durable encrypted submission journal and pre-submit reservation implementation |
| B08: secret screening for answers | Root | Implemented before DB8 persistence; regressions pending |
| G01 explicit chain binding; G03 stale confirmation | Root | Pending integration with core branch |
| Full live-model set, independent compliance/security review, developing guide | Swarm after integration | Pending |

## Implementation decisions

- User authorization to fix the reported gaps includes durable execution correlation and confirmation-time validation. These are explicit hardening changes to the original protocol, not claims that the original specification already required the missing behavior.
- An additive SQLCipher migration adds `handoff_journal`; the original `schema.sql` stays unchanged. The journal stores the immutable confirmed envelope under its original idempotency key before external submission. DB6/DB7 reservations are committed in the same transaction. Session history in the journal is temporary and cleared with all other session data.
- Ambiguous transport failures retain the reservation and identity. A definite rejection releases spend reservations. Valid callbacks can arrive before the submission response and remain applicable after restart. Executed spend cannot be reverted by replay, and cancelled/ended autopays cannot be reactivated by stale creation callbacks.
- Full live evaluation will use local Ollama and fake chain/execution services, with zero real payments or signing. Prompt edits are accepted only against the complete 154-case set and its recorded baseline.
- Existing branches/worktrees and process documents are retained. No push or deletion is part of this work.

Detailed final results, commits and remaining limitations will replace the in-progress entries before completion.
