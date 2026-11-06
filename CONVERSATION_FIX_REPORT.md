# Conversational reply correction — 2026-11-06

Follow-up replies previously went directly to the pending field validator. The local Qwen model was running for
the extraction stages, but it did not interpret those replies. This caused sentences to become contact names,
new requests to repeat old questions, and recipient corrections to consume retries.

The user's SQ-CV-01 instruction authorizes interpreting the reply before deciding whether it is a field answer.
The original README is retained. The earlier remediation and its 154-case evaluation remain historical evidence;
the verification below concerns the additional conversation changes.

## Findings and corrections

| Finding | Reproduction | Correction |
| --- | --- | --- |
| B20 — pending question traps conversation | At Yash's address question, `pay riya` repeats Yash's question. `I have to be paid for it` becomes a name. A full new autopay request remains trapped. | Classify guarded typed replies with the local model before applying a field handler. Supply original request, question purpose and recent typed replies. Preserve the question on clarification; replace the draft for a complete new request. |
| B21 — amount reply loses currency | `10 usd` at the missing-amount question asks whether 10 is USDC or ETH. | Retain explicit USD/USDC/ETH in validated replies. USD keeps the existing USDC interpretation. Reject conflicting currencies and precision errors. |
| B22 — accepted amount has stale summary wording | A USD reply has no USD note, or a new amount's note quotes an earlier ETH phrase. | Use the accepted amount reply for summary provenance while keeping original text positions separate for masking. |
| B23 — malformed model amount phrase erases the request | Qwen emits `pay mihir` as a missing amount phrase. After supplying `10 usd`, masking replaces the action and recipient, and request classification returns a balance response. | Mask only independently supported amount phrases. A no-amount phrase retains action/recipient text and asks for the missing amount; invented model hints are discarded. Broad phrases containing monetary values stop safely before masking. Existing precision and fiat questions remain supported. |

## Routing and limits

Whole literal values and exact displayed choices still use the existing validators. Other replies go through the
new `conversation` model call. The strict result distinguishes an answer, recipient correction, complete new
request, clarification, or explicit draft cancellation. Extracted values must appear verbatim in the current reply;
the remaining words cannot hide another amount, schedule, recipient, condition or negation.

A recipient-only correction is supported at the unresolved S6 recipient question. It retains the amount and
schedule and runs normal recipient resolution, planning, limits and summary again. It cannot create an alias from
the old recipient to the new one. Ambiguous repeated targets and later-stage corrections ask for the full updated
request. A full new request is passed unchanged through the pipeline; the model does not rewrite it.

The model receives at most six recent typed replies, with bounded input lengths. Document contents, raw question
text/chips and the contact inventory are excluded. Secrets and decoded URLs are screened before the router and
answer storage. Model failures and ambiguous replies keep the draft and question open without consuming an attempt.
An overlong conversation asks for clarification instead of silently truncating and acting on changed meaning.

Existing address confirmation, contact naming, consent, limits and final payment confirmation still apply.
Conversation interpretation cannot modify an already-submitted retry envelope. The model can still misclassify
language; these checks favor clarification when a proposed interpretation does not account for the whole reply.
This is bounded conversational support for payment requests, not an unrestricted chat agent.

## Verified checks

Production and test revision: `a05cb9d` (amount-span fix `1cc2383`, follow-up compatibility fix `42995d1`).
A detached checkout under `/private/tmp/flex-conversation-fixes/evaluation-a05cb9d` passes:

| Check | Result |
| --- | --- |
| Unit and acceptance tests | **2,129 / 2,129**, 72 files, no skipped tests |
| Separate audit | **205 / 205**, six files, no skipped tests |
| Typecheck, lint, build | Passed |
| Real Qwen conversation scenarios | **7 / 7**, 18 input turns, 41 model calls including 10 conversation calls |
| Full fixed model benchmark | **154 cases: 129 exact, 25 existing stops, zero wrong handoffs, crashes or rejected summaries** |
| Independently reviewed router regressions | **75** tests covering normal replies, adverse inputs, consent, context boundaries, stale questions and concurrency |
| Independently reviewed amount/masking suite | **290 / 290**, including 32 independent controls and 72 original acceptance cases |

After the user's request to keep checking the predefined suites, the working tree was rerun with the same production
and test source: **2,129/2,129 unit/acceptance tests and 205/205 audit checks**, zero failed, skipped or todo tests.
Typecheck, lint and build also pass. Reports and logs are under
`/private/tmp/flex-conversation-fixes/working-tree-*`. A further run with the repository's default worker and timeout
settings also passes **2,129/2,129** via `npm test` and **205/205** via
`npx vitest run --config test/audit/vitest.audit.config.ts`; only JSON-report options were added. Those results are
`/private/tmp/flex-conversation-fixes/default-tests.json` and `default-audit.json` in the same directory.
Generated live-run JSON is excluded from Prettier to preserve the raw evidence hashes; source formatting and ESLint
remain checked.

The real-model scenarios use the exact final source bytes. Three checked plans are confirmed to the local capture
executor; no scenario submits before explicit confirmation. Their summaries and captured envelopes have the
expected recipients, amounts and chains. The Yash-to-Riya autopay also checks frequency, weekdays, first occurrence,
finite end date and total cap. Raw evidence: [final-a05cb9d.json](test/live/results/conversation/final-a05cb9d.json).
All seven also passed on the earlier `d0f7806` candidate; both runs are retained separately.
Independent grading uses Astra/max workers; production authors do not grade their changes alone.

The first real-model probe reproduced the corrected Yash → `10 usd` → `pay riya` sequence through the frontend's
sandbox and produced the intended 10-USDC, twice-weekly, three-week summary, with no submission. It also verified
refund clarification and escape to a new autopay request. The first six permanent live tests then exposed the broader
S3 masking issue and two router classification errors; those failed attempts are retained as diagnostic evidence.
The address and complete-request scenarios pass after the prompt and bounded normalization corrections.

The first full-benchmark attempt was stopped after 28 completed cases because it caught a compatibility regression
in `Send 5 more`: the new span guard rejected that valid follow-up. The partial run has 19 exact outcomes, nine
unexpected stops and zero wrong handoffs/crashes; only A-06/A-07 differ from the previous remediation in that prefix.
Its unchanged rows are retained in [benchmark-aborted-d0f7806.json](test/live/results/conversation/benchmark-aborted-d0f7806.json).
This diagnostic is not a complete acceptance run. The corrected parser recognizes one trailing `more` while still
checking the stated number independently: a model reading `5 more` as 50 triggers an amount mismatch question.
The fresh full run on `a05cb9d` completes all 154 cases with **129 exact outcomes and 25 unexpected stops**,
with **zero wrong handoffs, crashes or rejected summaries**. Every outcome/stop/final-code signature matches the
earlier `33518a2` remediation; no formerly exact case regresses. The separate A-06/A-07 probe and the complete run
both preserve the valid `more` follow-up. Raw evidence: [full run](test/live/results/conversation-a05cb9d.json) and
[follow-up probe](test/live/results/conversation/followup-probe-a05cb9d.json). No diagnostic/probe rows replace
primary results. The seven conversational scenarios establish the new behavior separately from this legacy corpus.

The benchmark now also records `target_trace_start`, `target_pairing_reached` and `target_pairing_exact`. These
exclude setup payments, which could make the old pairing metric look successful even when the target follow-up
stopped before S8. The original fields and outcome oracle remain unchanged. Both pairing metrics are validation
proxies, not semantic exact-match measurements of every S8 output.

The legacy proxy is **106/107** and the target-only proxy is **104/105**. P-058/P-060 account for the two setup-only
pairing cases. P-044 asks an additional `Q_NAME_ROLE` and still finishes exactly; 62/154 requests now have questions.
No-question initial responses have median **8.245 s**, p95 **17.275 s**, and maximum **24.406 s** (one of 92 over
20 seconds). This excludes follow-up and confirmation time; host/cache conditions are uncontrolled, so neither
causal speedup nor full compliance with the 20-second target is established. See
[LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md) for comparison and remaining model stops.

## Existing tests and the frontend

The complete existing suites remain in the default run, with no skipped tests. An independent reviewer adapted
four legacy fixture files to the explicitly requested routing change: native validation/runner tests now supply
field-shaped values or explicit invalid chips, and conversational tests supply classifier fixtures. Retry limits,
stale IDs, raw-answer persistence and final results remain asserted. The DB2 audit now checks the writer's enclosing
function instead of a line number that moved, with a negative-control test. These changes are recorded in
`71c847d` and `7d26e90`; the new behavior has 75 independent router regressions.

The updated local frontend is **http://127.0.0.1:8791**, running the compiled `a05cb9d` source with real Qwen,
sample balances/contacts and local execution capture. The actual TCP `/api/messages` → `/api/answers` flow passes
the user's Yash → `10 usd` → `pay riya` sequence: six real model calls, a correct 10-USDC twice-weekly three-week
Riya summary and zero submissions. Evidence: [frontend trace](test/live/results/conversation/frontend-a05cb9d.json).
Only this initially empty synthetic test session was reset afterward. The earlier frontend on port 8790 and its
pending draft were preserved; use port 8791 to exercise the corrected runtime.

Permanent tests: `test/unit/A/conversation-router-review.test.ts`,
`test/acceptance/conversation-router-review.test.ts`, `test/unit/B/amount-answers.test.ts`,
`test/acceptance/amount-answer-independent.test.ts`, and `test/live/conversation.test.ts`.
Local diagnostics and independent review reports are under `/private/tmp/flex-conversation-fixes/` and
`/private/tmp/flex-codex-fixes/`. Only synthetic test data is used; execution is captured locally.
