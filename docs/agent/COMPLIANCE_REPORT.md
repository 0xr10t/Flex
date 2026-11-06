# Compliance and privacy review — 2026-11-06

The checklist has 509 rows implemented and tested, plus five explicitly approved and tested differences: three
worked examples and two pending-reply rules superseded by SQ-CV-01. C-514 is accepted for the documented live gate:
the complete 154-case evaluation meets SQ-L-01's zero-wrong-handoff and reduced-stop conditions. A fresh full rerun
on conversation revision `a05cb9d` preserves all 154 final outcome/stop/code signatures from `33518a2`.
The 514-row inventory covers the listed §§5–20 contracts; its coverage is not blanket specification compliance.
The five approved differences remain visible, and the NFR-03 latency requirement is not met by this evidence.

The earlier review covered production through `33518a2`, plus the narrow document-only chain guard `ef69e31`, including the merged
core, understanding, schedule, durable-handoff, secret-screening, chain-binding and confirmation changes. The independent reviewer authored tests and this report,
not those production changes. The review uses `README.md` together with the binding answers in
[SPEC_QUESTIONS.md](SPEC_QUESTIONS.md) and [SPEC_ANSWERS_FOLLOWUP.md](SPEC_ANSWERS_FOLLOWUP.md).
The later human answers and the current request to fix all review findings govern the differences below.
`README.md` is unchanged. Node 25.9.0 is accepted by SQ-11. That review's verification checkout was `547a36e`, which also
includes the development dependency fixes in `791124c` and the explicit live-case selection harness.

The later conversation work is independently graded by Astra/max reviewers, with production authors and graders
separated. Revision `a05cb9d` passes **2,129 unit/acceptance tests, 205 audit checks, seven real-model conversation
scenarios**, typecheck, lint and build. The final working-tree rerun repeats the same deterministic results with
zero failed, skipped or todo tests. The additional prompt, reply routing, amount provenance and masking changes,
adaptations to four legacy fixture files, and separate frontend TCP verification are documented in
[CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md).

## Checklist accounting

| Owner | Items | implemented + tested | approved deviation + tested | live acceptance pending |
| --- | --- | --- | --- | --- |
| Lane A | 81 | 79 | 2 | 0 |
| Lane B | 123 | 123 | 0 | 0 |
| Lane C | 73 | 73 | 0 | 0 |
| Lane D | 152 | 152 | 0 | 0 |
| Orchestrator | 85 | 82 | 3 | 0 |
| **Total** | **514** | **509** | **5** | **0** |

Every checklist row and the resolved question sets were inspected. The evidence inventory maps 503 rows to explicit
`C-nnn` or `A-nn` references in test sources. Ten others map to section-based assertions or direct artifact checks:
C-004 (config), C-267–270 (four LLM schemas), C-272 (payments template), C-273 (internal plan schema), C-274 (handoff
schema), C-440 (E9/A-15), and C-441 (E10/A-16). C-514 has the live evidence below. This is traceability evidence, not a proof that
every conceivable input is covered; comments and test names were supplemented with source and assertion review
for the changed behavior and privacy boundaries.

All six former untested contracts now have passing guard tests: static tables (C-005), DDL constraints (C-026),
request states and fresh fields (C-049), Ajv strict/allErrors/formats (C-271), question shape/chip matching (C-306),
and the 35 error codes and messages (C-395). See [test/unit/contracts](test/unit/contracts).
No skipped, todo, or expected-failure test definitions remain in `test/`; selection of a focused test subset does
not alter this statement.

The original four open deviations are now resolved:

| Row | Approved behavior | Evidence |
| --- | --- | --- |
| C-437, E6 | SQ-D-15: expiry is 23:59:59 on the last occurrence's date; the example's later end date does not replace it. | `test/unit/D/examples.test.ts`, A-08 |
| C-440, E9 | SQ-D-16: the default 100 USDC limit rejects the 120 USDC invoice; A-15 raises its fixture limit to exercise content confirmation. Attached-content amounts cannot receive a one-request override. | `test/unit/D/examples.test.ts`, A-15 |
| C-497, A-44 | SQ-O-05: “me” asks Q_NO_PAYEE; an explicit own address yields SELF_PAYMENT. The approved deviation remains labeled as such. | `test/acceptance/a33-a52.ts` |
| C-510, A-57 | SQ-O-03/F-11: relaxed clause binding permits both amounts to the one recipient; ambiguous multi-recipient requests ask per-amount questions. A-57 is a normal passing test. | `test/acceptance/a55-a60.ts`, `test/unit/D/core-review.test.ts` |

## Authorized differences from the original specification

These differences are recorded rather than presented as literal compliance with superseded wording.

| Authority | Behavior and affected contract |
| --- | --- |
| SQ-CV-01, human instruction in the current session | C-420/C-421: a pending free-text reply is interpreted before deciding whether it is an answer, correction, new request, clarification or explicit draft cancellation. Clarification/model failure keeps the question and attempt counter. Valid field answers retain native validation; consent and final confirmation cannot be inferred by the model. The additional conversation prompt/schema does not alter the four extraction schemas. |
| SQ-L-01 | The system text of amounts, requestType, spans and payments may change, subject to the full live gate, now passed. All USER slots and §12 schemas remain unchanged. Only repeated valid action kinds are deduplicated before normal schema validation; invalid kinds, missing fields and extra fields still fail. Exact old/new text, reasons and live evidence are in [PROMPT_CHANGES.md](PROMPT_CHANGES.md). Retention is accepted on the evidence and limits below. |
| Current request, B03/B04/B19/G02 | An additive encrypted `handoff_journal` migration records the confirmed envelope and original idempotency key, with DB6/DB7 reservations committed before submission. This changes the old post-2xx write timing. Timeout/5xx retain identity and reservations; definite rejection releases reservations. Reports are checked against request, step, intent and autopay identity. Executed spend and terminal autopays cannot be rolled back by stale reports. |
| Current request, G01 | Explicit chain choices are checked independently of the model, including document-only payments with no typed amount/recipient spans. One unique typed chain binds those payments; an omitted chain triggers correction and then PAIRING_FAILED. Existing clause/sentence binding governs payments with typed spans. |
| Current request, G03 and B19 | Before the first submission, balances and settings are refreshed and funding/limits revalidated. Changed settings or newly broken limits require replanning or renewed consent. After an ambiguous submission, retry preserves the original envelope/key; late-start replanning applies before first submission. This supersedes the original “S0 only on new messages” rule and clarifies SQ-R-05. |
| SQ-R-01/02, SQ-O-01/F-12, SQ-O-03/F-11 | Exact repeated tagged names are masked with Unicode identifier boundaries; mixed payee/story roles ask Q_NAME_ROLE. Distributive scope is local to the amount's clause. Ambiguous pairing asks for every affected amount, with independent attempt counters. |
| SQ-D-16/F-1–F-6, R4-F2 | Q_LIMIT_OVERRIDE replaces Q_GROUP_OVER_LIMIT. Only the named limits are lifted for that request; new breaches ask again. Attached-content amounts retain the error. DB5 is not changed. |
| SQ-R-03/04/05/06 | Short schedules cap `per_period_cap` at `total_cap`; duplicate autopay hashes are ignored; late initial confirmation asks for a fresh start and summary; cancellation after timeout states that the wallet may already have received the request. |
| SQ-08/F-10, R4-F4 | Insufficient-funds text lists positive spendable balances in configured chain order, and need includes separately rounded bridge padding. The empty-balance case has its approved shorter wording. |
| SQ-O-06/08/09, F-13 | Secrets are checked in URL inputs and redirects, including malformed percent encoding, and in answer channels before storage. Additional SSRF ranges are refused. Wallet refusal text is capped and control/format characters are stripped. |
| SQ-01/F-7, SQ-A-06/F-9, F-8 | UNSUPPORTED_REQUEST mentions automatic bridging. The third handoff failure distinguishes timeout from server error. Cancellation of an already handed-off request uses its approved wallet-signing reply. |
| SQ-03/05/06/07/09/15/18/22, SQ-O-07/10 | The accepted question/reply details, group text, retries, ENS update path, silent-reuse chain list and document-size wording follow the resolved answers. Former interim tags are now marked approved. |
| SQ-CX-01, human approval in the current session | “That would leave {name} with nothing.”, “Yes, this once” / “Yes, set it up” / “No”, and “today's limit of {daily_max} (only {remaining} is left)” are approved text, with no wording decision outstanding. |

The additive journal retains submission data across sessions. Its temporary `history_json` is erased on session
clear alongside DB1/DB3/DB8, and accepted history is consumed once. Persistent submission identity contains the
validated execution envelope, not prompts, documents, names, ENS names or summaries. This retention is an explicit
part of the authorized report-correlation fix; it is not described as session-only storage.

## Artifact checks

| Artifact | Demonstrated result |
| --- | --- |
| Four §12.1 LLM schemas | Byte-for-byte equality with the README fenced JSON, also parsed equality. |
| §12.5 handoff envelope schema | Byte-for-byte equality with the README fenced JSON. |
| §12.2 payments schema / §12.3 internal plan | Passing schema tests enforce request-specific enums, limits, foreign-placeholder rejection and internal placeholder formats. |
| Five original prompts | Four changed system texts equal independently reviewed golden fixtures. Q-LLM remains identical to README. All five USER portions remain equal, with only SQ-21's documented removal of inline explanatory comments for payments. |
| Additional conversation prompt | Authorized by SQ-CV-01; bounded typed context, strict intent validation and independent unit/HTTP checks. Seven real-model scenarios verify the new behavior separately from the fixed 154-case corpus. |
| §7.1 DDL | Original `schema.sql` is identical except its header comment. The separate v2 migration adds the authorized journal; it does not rewrite that DDL. Guard tests check all ten original tables, constraints, keys and DB2 index. |
| §6.1 config / §6.3 defaults | Parsed config equality; all eight default keys, values and types equal the spec. |
| §6.2 static tables | Exact arrays/token metadata asserted by ten passing guard cases. Added recognition of explicit recurrence/group forms is in lexical patterns, not a silent rewrite of the tables. |
| §13.4 questions | 25 quoted baseline rows compared: 24 retained texts match with optional-slot notation resolved; the old group-limit row is replaced as approved. Q_ENS_CHANGED is checked against §9.4. The catalogue has 28 codes and tested new question text/chips. |
| §15 errors | All 35 codes checked: 34 base templates remain literal; UNSUPPORTED_REQUEST is the approved F-7 difference. F-9 final-attempt and F-10 empty-balance variants are separately tested. |
| §13.1–13.2 summaries/balances | Templates and exact-output tests reviewed; approved generalized override and silent-reuse notes are recorded above. Group punctuation and ordinal wording follow the resolved SQ-D answers. |

Machine-readable inventory and comparison results are saved in
`/private/tmp/flex-codex-fixes/compliance-evidence.json` and `compliance-catalog-evidence.json`.

## Earlier independent verification and privacy sweep

- Understanding, date and contract checks: 512/512 passed. The reviewer then found two uncovered variants, added
  failing regressions, and asked a different author to fix them: `.0`/`.000` must not turn into a positive amount,
  and “starting on”/“beginning on” must preserve reversed explicit dates. Corrected S3/date/HTTP checks pass 104/104;
  parser checks pass 8/8. Additional probes preserve local fields across Lord Howe, Chatham and Dublin DST changes.
- An adjacent G01 probe found that “pay this invoice on arbitrum” could confirm on Base when both amount and
  recipient came from content and the model returned unstated. Root fixed the missing binding in `ef69e31`; four
  independent HTTP regressions cover rejection, correction, an accurate first response and no-chain automatic
  selection. The combined chain/S8 rerun passes **48/48**. This source change followed the live freeze: the unchanged
  154-case manifest has content only in A-15, A-45 and A-46, none with a typed chain. A-45/A-46 stop before S8.
  Corpus hashes and scope evidence are in `document-chain-live-scope.json`; the final-toolchain A-15 repeat also
  completes with the same safe pre-S8 stop. It does not exercise the new chain guard; the four HTTP regressions do.
- Prompt checks pass 15/15; S8 and the independent LIVE-P061/LIVE-P073 interval regressions pass 52/52. Wrong-twice
  duration-as-interval output stops; wrong-then-right and explicit every-other/every-two/fortnightly controls pass.
- The separate durable-handoff reviewer reports 42/42 HTTP checks, 207/207 adapted legacy checks, and 6/6 error-audit
  checks after the independently discovered answer-URL and chain-scope fixes. Typecheck and scoped lint/format
  checks pass. The final integrated deterministic run passes **1,874/1,874 tests across 66 files**; the final audit
  passes **169/169 across six files**, with no pending or todo tests. The independent reviewer checked the JSON
  results and clean install, typecheck, lint and build logs. A fresh clean checkout of `547a36e` repeats those same
  passing counts using Vitest 4.1.12; its status log is empty. `npm audit` reports **zero vulnerabilities**, including
  development dependencies; production dependencies are unchanged. Artifacts under `/private/tmp/flex-codex-fixes/`
  are `final-tests.json`, `final-audit.json`, `final-npm-audit.json`, `clean-tests.json`, `clean-audit.json`, and the
  corresponding `final-*` / `clean-*` logs. The final runtime smoke result, `runtime-final-result.json`, also passes
  real local TCP, production clients and SQLCipher against fixture servers; no public-chain submission occurs.
- Reviewed privacy boundaries: local-only Ollama with redirect refusal; quarantined content reaches P-LLM only as
  validated placeholders; S7 verifies and masks exact repeated recipient spans; the execution envelope excludes
  names, ENS, summaries and free text; session clear deletes prompt/history stores and truncates the WAL.
- The network audit now reads TypeScript syntax for viem runtime capabilities, including aliases and namespaces.
  A prose comment about transport no longer counts as a network client. The same two allowed viem client modules
  remain enforced; the full audit and TypeScript check passed after this test-only correction.
- Reviewed every production logging call site against the allowlist/value-shape checks. Event labels are constants,
  rule IDs use fixed labels or closed step values, and no console/stdout output exists. The only stderr output is
  the fixed startup-failure sentence. Raw external errors are not logged.
- Outbound inventory remains Ollama, configured RPC/ENS services, the HTTPS content fetcher, and the configured
  execution client. The fetcher checks every redirect and pins DNS checks at connection time. Existing audit tests
  cover rebinding, SSRF ranges, authentication separation, encrypted stores, and prompt isolation.

The source and fixture checks use fake chain/execution services and do not sign or send real payments. No new
Ollama calls were made by this independent reviewer. The live metrics below come from the coordinator's separate
local-model run and independent review of its results, not from the deterministic suite.

## Latest live verification and acceptance limits

The complete `a05cb9d` rerun contains the same 154 IDs, prompts and expected results in manifest order. It has
**129 exact outcomes, 25 unexpected stops, zero wrong handoffs, crashes or rejected summaries**. Independent
recomputation confirms that all final outcome/stop/code signatures match `33518a2`; P-044 adds a resolved
`Q_NAME_ROLE` question and remains exact. The seven added conversation scenarios pass on the same source bytes,
with 18 input turns, 41 real model calls and three explicitly confirmed local capture submissions. No scenario
submits before confirmation. The actual frontend TCP reproduction also passes, with zero submissions.

The legacy S8 first-pass validation proxy remains **106/107**. The new target-only proxy is **104/105**, excluding
prior setup payments; neither measures raw semantic exact-match across all S8 outputs. No-question initial-response
latency is median **8.245 s**, p95 **17.275 s**, maximum **24.406 s** across 92 cases. One exceeds 20 seconds; later
clarification and confirmation time are excluded, and host/cache conditions are uncontrolled. Full NFR-03 compliance
and a causal speedup are not established. The 25 stop cases remain visible; no universal language coverage is claimed.

Raw results, hashes, the diagnostic run stopped to fix `5 more`, and independent comparison evidence are linked from
[LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md) and [CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md).
Generated live-run JSON is excluded from Prettier so the recorded raw hashes remain stable; source linting remains
enabled. The earlier review below is retained with its original revision and measurement scope.

## Earlier live evaluation

The primary run uses frozen source `33518a2`, Ollama 0.40.14 and `qwen2.5:7b-instruct` at temperature 0, seed 42,
with 8,192 context tokens. The model digest starts `845dbda0ea48`. The baseline is exactly `acceptance.json`,
`para-0.json`, `para-25.json`, `para-50.json` and `para-75.json`; earlier recheck files are excluded. Both sets contain
the same 154 unique IDs, prompts and expected outcomes: 54 acceptance cases and 100 paraphrases. The primary result
is [codex-remediation-33518a2.json](test/live/results/codex-remediation-33518a2.json). Its committed formatted JSON
has SHA-256 `44f39bbde4411ebee08f0726a1a8d9b223c180e02226211fd8884b76dbe7f1b6`; the original isolated-run bytes have
SHA-256 `62165960fb8420a1c12a8f89d05c30688f904f7020caf378b7553faeb9ea7240`. Parsed deep equality was independently
asserted after formatting. The prompt manifest and comparison oracle were unchanged; `547a36e` adds only explicit
case selection for repeats. Only model calls are live in this evaluation; chain and execution services are fixtures.

| Measure | Baseline | Primary full run |
| --- | --- | --- |
| Wrong handoffs | 2/154 | **0/154** |
| Exact expected outcomes | 98/154 | 129/154 |
| Exact expected plans | 77/119 (64.7%) | 98/119 (82.4%) |
| Matched confirmed main-request envelopes | 77/79 | 98/98 |
| Exact expected non-plan outcomes | 21/35 | 31/35 |
| Unexpected stops recorded by the harness | 54/154 | **25/154** |
| Rejected summaries | 0 | 0 |
| Crashes | 0 | 0 |
| Cases with at least one question | 63/154 (40.9%) | 61/154 (39.6%) |
| First-pass S8 validation proxy | 81/82 (98.8%) | 106/107 (99.1%) |
| MODEL_FAILED outcomes / client retries | 9 / 9 | 0 / 0 |

The semantic plan and envelope counts compare recipient, intent kind and payment amount/token. They check chain
only when the expected plan specifies one, and recurring frequency/interval plus specified days, day of month and
end fields. They reject extra or missing non-bridge intents. They do not compare `j` bridge intents, complete
schedule timing, caps, prefunding, delegate/job IDs or persistence; those rely on the deterministic and HTTP suites.
The simulated user checks summaries before confirming. The existing `pairing_exact` field is a first-pass S8
validation proxy, which can include a setup's prior request. It is **not raw semantic S8 exact-match**; that rate
over all intermediate model candidates was not captured. Semantic evidence for completed plans is reported
separately above. The zero-wrong claim is bounded by these explicit oracle checks.

All 25 stop traces were inspected. They include missing or fabricated amount spans, omitted context numbers,
recipient/group extraction failures, recurrence misclassification and the rejected unsupported `times_per_week`
field in P-072. Some stops are intended guards without a scripted answer: cross-sentence Q_PAIR_AMOUNT (F-11),
numeric coverage questions, and the SQB-14 cancellation-word check. The count is the unchanged harness metric,
not a claim that every stop was unnecessary. Six previously exact cases now stop safely: A-01, A-18, A-47, P-022,
P-058 and P-097. P-061 and P-073, the two baseline wrong handoffs, both produce the expected recurring plans.

The no-question initial-response latency remains a limitation: baseline median 13.567 s, p95 30.832 s, maximum
33.857 s across 91 cases; primary median 14.056 s, p95 30.331 s, maximum 50.204 s across 93. In the primary run,
23/93 exceed 20 s, compared with 14/91 in the baseline. These measurements end at the initial HTTP response and do
not include the later confirmation/submission round trip. **The NFR-03 requirement of at most 20 s end to end is
not established and the observed slower responses exceed it.** No latency improvement or universal live-model
success is claimed.

The final-source repeat at `547a36e` covers all 52 changed outcome/code signatures plus A-15, including P-061 and
P-073. All 53 outcome/unexpected-stop/code signatures reproduce the primary run: **38 exact, 15 safe stops, zero
wrong handoffs, rejected summaries, crashes, MODEL_FAILED outcomes or client retries**. It contains 26/40 exact
expected plans and 12/13 exact expected non-plan outcomes; 26 cases ask a question and the S8 first-pass proxy is
34/35. The selection and unchanged prompt/expected objects were independently checked. The log reports 54/54
Vitest assertions, including model availability. A-15 still asks Q_AMOUNT_MISSING before S8, so its repeat confirms
the safe outcome rather than successful invoice planning. P-061 and P-073 remain exact.

These repeats are separate reproducibility evidence; they do not replace primary outcomes or change its denominator.
The original repeat artifact under `/private/tmp/flex-codex-fixes/final/test/live/results/` is
`codex-remediation-repeat-547a36e.json`, SHA-256 `5ee7479d04e9fcbb120846edbccc231df082d2908bca7357045fbc602523d2d2`.
The [committed formatted repeat](test/live/results/codex-remediation-repeat-547a36e.json) has SHA-256
`d0511fde54d41aa457d1521333a11c2fa341b7c78510fd178570e8d30f9d7621`; parsed deep equality was independently asserted.
C-514 and retention of the SQ-L-01 candidates are accepted for the stated gate. No additional unresolved production
defect was found in this review's assigned scope after `ef69e31`; residual live usability, measurement limits and
latency are recorded above. This is not a claim of complete performance acceptance or literal compliance with every
original specification sentence.
