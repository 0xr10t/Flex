# Documentation map

| If you want to... | Read |
| --- | --- |
| See how the wallet differs from the agent design, and why | [wallet/ARCHITECTURE_CHANGES.md](wallet/ARCHITECTURE_CHANGES.md) |
| Send the agent team what they need to change | [wallet/AGENT_HANDOFF.md](wallet/AGENT_HANDOFF.md) |
| See the order of work | [wallet/IMPLEMENTATION_PLAN.md](wallet/IMPLEMENTATION_PLAN.md) |
| See the detail of each wallet part | [wallet/README.md](wallet/README.md) |
| See progress, decisions and findings | [wallet/IMPL_TRACKER.md](wallet/IMPL_TRACKER.md) |
| See what is undecided | [wallet/OPEN_QUESTIONS.md](wallet/OPEN_QUESTIONS.md) |
| Read the current design | [spec/AGENT_SPEC_v1.1.md](spec/AGENT_SPEC_v1.1.md) |
| Read what the agent code was built from | [../README.md](../README.md) (v1) |

## Folders

| Folder | Holds |
| --- | --- |
| `spec/` | The v1.1 spec, the decisions behind it, and the test records: `AGENT_SPEC_v1.1.md`, `DECISIONS.md`, `TESTED.md`, `TEST_MAP.md` |
| `wallet/` | The wallet's design changes, plan, parts, tracker and open questions |
| `agent/` | The agent build's records: status, compliance report, spec checklist, spec questions and answers, orchestrator prompt |

## Which source wins

1. `wallet/ARCHITECTURE_CHANGES.md`, for what it covers.
2. `spec/AGENT_SPEC_v1.1.md`.
3. `spec/DECISIONS.md`, `spec/TEST_MAP.md`, `spec/TESTED.md`: why, and how far each thing is proven.
4. The root `README.md` (v1): only for what the agent code does today.

## Old file names

These files moved on 6 November 2026.

| Old | New |
| --- | --- |
| `README_2.md` | `docs/spec/AGENT_SPEC_v1.1.md` |
| `DECISIONS_2.md` | `docs/spec/DECISIONS.md` |
| `TESTED.md` | `docs/spec/TESTED.md` |
| `TESTED_2.md` | `docs/spec/TEST_MAP.md` |
| `STATUS.md`, `COMPLIANCE_REPORT.md`, `ORCHESTRATOR_PROMPT.md`, `SPEC_*.md` | `docs/agent/` |
| `spec-questions/` | `docs/agent/spec-questions/` |

Comments in `src/` and `test/` still use the short names, such as `spec-questions/B.md` and `ORCHESTRATOR_PROMPT §7`. They were left
as they are so the agent code stays identical to `origin/agentic_layer`.

The root `README.md` stays in place because agent tests read prompt text from it (`test/unit/B/prompts.test.ts`,
`test/unit/D/prompt-payments.test.ts`).
