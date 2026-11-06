# Live-model remediation evaluation — 2026-11-06

The complete 154-case run has **zero wrong handoffs**, compared with two in the historical baseline. Its unexpected-stop
count falls from **54 to 25**, satisfying the SQ-L-01 gate for retaining the prompt changes. There are no crashes or
rejected summaries. This gate does not establish complete language coverage or compliance with the latency target.

## Runs and scope

- Baseline: exactly `acceptance`, `para-0`, `para-25`, `para-50`, and `para-75` in `test/live/results/`. Diagnostic
  `recheck-*` files are excluded. These are 154 unique cases: 54 acceptance prompts and 100 paraphrases.
- Primary remediation run: production revision `33518a2`, clean isolated checkout, Vitest 3.2.7. Raw evidence:
  [codex-remediation-33518a2.json](test/live/results/codex-remediation-33518a2.json). All 154 IDs, prompt texts and expected
  results match the baseline and manifest. Vitest passes all 155 assertions, including model availability.
- Final code/toolchain: revision `547a36e`, Vitest 4.1.12. Fresh installation, typecheck, lint, build, **1,874/1,874**
  unit/acceptance tests and **169/169** audit checks pass in a separate clean checkout. Production dependency artifacts
  are unchanged. The narrow document-only explicit-chain guard added after the primary revision has four new HTTP
  regressions and independent review. The existing full corpus has no document-only explicit-chain scenario; A-15 is
  included in the final-toolchain repeat.
- Repeat evaluation is in progress on `547a36e`: all 52 cases whose `(outcome, unexpected_stop, final_code)` changed
  from the baseline, plus A-15, for 53 cases. It includes both previously wrong cases, P-061 and P-073. Repeats are
  separate evidence and never replace primary rows.

Both live runs use local Ollama **0.40.14**, `qwen2.5:7b-instruct` (7.6B, Q4_K_M), temperature 0, seed 42, context 8192,
and a 60-second per-call timeout. Model digest:
`845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`.
The machine is macOS arm64 with Node 25.9.0 and npm 11.12.1. Fixed model settings do not guarantee identical outputs.

The production S0–S12 pipeline and real Ollama client are exercised through the HTTP acceptance harness with SQLCipher.
RPC, ENS, indexing, content fetching and execution are fixtures. The simulated user answers scripted questions, rejects
summaries that do not match the expectation, and confirms matching summaries. No funds are signed or broadcast.
Production TCP startup, token files, RPC/model/execution HTTP transports, authenticated reports, session clearing and
log privacy also pass a separate local-fixture smoke test. The real OS keychain and public RPC/ENS/signing deployments
are outside this verification.

## Primary comparison

| Metric | Historical baseline | Remediation |
| --- | ---: | ---: |
| Cases | 154 | 154 |
| Wrong handoffs | **2** | **0** |
| Unexpected stops | 54 | **25** |
| Exact expected outcomes | 98 / 154 (63.6%) | **129 / 154 (83.8%)** |
| Exact expected plans | 77 / 119 (64.7%) | **98 / 119 (82.4%)** |
| Exact expected non-plan outcomes | 21 / 35 | **31 / 35** |
| Rejected summaries | 0 | 0 |
| Crashes | 0 | 0 |
| Requests ending MODEL_FAILED | 9 | 0 |
| Logged client LLM retries | 9 | 0 |
| S8 first-pass validation proxy | 81 / 82 (98.8%) | 106 / 107 (99.1%) |
| Requests with at least one question | 63 / 154 (40.9%) | 61 / 154 (39.6%) |
| No-question initial-response latency sample | 91 | 93 |
| Median initial response | 13.567 s | 14.056 s |
| p95 initial response | 30.832 s | 30.331 s |
| Maximum initial response | 33.857 s | 50.204 s |
| No-question initial responses over 20 s | 14 / 91 | **23 / 93** |
| Sum of per-case measured wall time | 33 min 55.437 s | 39 min 22.518 s |

Thirty-five former stops now give exact outcomes, and both former wrong handoffs now give exact plans. Six baseline
exact cases now stop: **A-01, A-18, A-47, P-022, P-058 and P-097**. Eight continuing stops change their final code; one
case remains exact while its accepted final code changes. All these changes are included in the repeat selection.

“Unexpected stop” is the existing harness flag, not a claim that every question was unnecessary. The queue contains
only scripted answers; an additional valid clarification can therefore count as a stop. The raw artifacts preserve
this distinction and the model traces. No failure bucket has been omitted to improve the comparison.

## What the metrics prove

The 98 completed expected plans match the evaluator's semantic checks for payment/cancellation intents: expected
recipient, token and amount; explicit chain where the expected case supplies one; and recurrence frequency, interval,
plus specified weekdays, day of month and end fields. Both P-061 and P-073 have the intended recurrence interval in
their summary and envelope. The summary reader was strengthened after the historical baseline to check intervals;
the historical two wrong handoffs are retained unchanged rather than reclassified.

The evaluator excludes `j` bridge intents and does not independently compare every schedule timestamp, time zone,
cap or prefunding field. Those have deterministic unit/HTTP regression coverage. Its `pairing_exact` field means S8
was reached without a CORRECTION call or model error: **it is a first-pass validation proxy, not raw S8 semantic
exact-match accuracy**. Semantic exact-match over every intermediate S8 candidate was not captured. The plan success
rate and envelope comparisons above are the available semantic evidence for completed plans. P-072 reaches a
CORRECTION call and then safely stops with `PAIRING_FAILED`; that is separate from a client transport/schema retry.

Latency measures the initial HTTP response for requests without questions, including non-plan/error responses.
It excludes subsequent clarification, confirmation and submission. Percentiles use sorted index `floor(p × n)`, as
the existing summarizer does. Runs used the shared machine; host load was not held constant. **NFR-03's 20-second
end-to-end target is not met by these observations and has not been established for complete requests.**

## Remaining stop cases

| Final code | Count | Cases |
| --- | ---: | --- |
| Q_AMOUNT_MISSING | 9 | A-11, A-12, A-13, A-15, A-18, P-058, P-078, P-080, P-090 |
| Q_AMOUNT_UNCOVERED | 8 | A-01, A-28, A-47, P-007, P-022, P-025, P-027, P-097 |
| Q_NO_PAYEE | 3 | A-41, P-064, P-083 |
| Q_PAIR_AMOUNT | 1 | P-023 |
| Q_RECURRING | 1 | P-060 |
| PAIRING_FAILED | 1 | P-072 |
| UNSUPPORTED_REQUEST | 1 | P-079 |
| Q_ADDRESS_REENTER | 1 | P-085 |

Independent review found no new deterministic wrong-plan defect in these traces. They include model amount/span
errors, missed recurrence/group roles and conservative guards around contextual numbers. P-023 asks the approved
cross-sentence amount question; P-079 invokes the approved no-cancel-word guard. These remain observable limitations
of the supported-language experience, even though none sends a wrong payment in this evaluation.

## Reproduce and verify evidence

```sh
node test/live/summarize.mjs acceptance para-0 para-25 para-50 para-75
node test/live/summarize.mjs codex-remediation-33518a2
LIVE_SET=all LIVE_TAG=your-new-unique-tag npm run test:live
LIVE_SET=all LIVE_IDS=A-15,P-061,P-073 LIVE_TAG=your-new-repeat-tag npm run test:live
```

Always give the summarizer explicit tags. Its default combines every result file, including partial runs and repeated
cases. Do not overwrite the recorded tags. Vitest's live invariant is only “no wrong handoff”; completeness, stops,
crashes and rejected summaries must also be inspected.

| Evidence | SHA-256 |
| --- | --- |
| `test/live/prompts.json` | `69ba36fbdaf343f250c2c0655ab8612e449e487d8bdb8b91bcb5a53323d068c4` |
| Primary 154-case JSON | `62165960fb8420a1c12a8f89d05c30688f904f7020caf378b7553faeb9ea7240` |

Exact prompt diffs and hashes are in [PROMPT_CHANGES.md](PROMPT_CHANGES.md). Independent grading and checklist scope
are in [COMPLIANCE_REPORT.md](COMPLIANCE_REPORT.md). Supporting execution logs, baseline hashes, clean-checkout reports,
dependency review, model metadata and production TCP evidence are retained under `/private/tmp/flex-codex-fixes/`.
