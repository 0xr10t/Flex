# Codex end-to-end review

Review date: 2026-11-06. Project: `agent-layer` in `/Users/phantomxsd/Flex`.

## Follow-up conversation review — SQ-CV-01

The user's multi-turn examples exposed four additional findings, B20–B23, beyond the original 19: replies were
treated as field values without model interpretation; amount replies lost their currency; summary notes retained
stale wording; and a malformed model amount phrase could mask the action and recipient after clarification.
[CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md) records reproductions, fixes, independent review and the
current verification status. The earlier counts and live evaluation below describe the original remediation.

| Finding | Observed failure | Implemented correction |
| --- | --- | --- |
| B20 | A sentence, recipient correction or new request was consumed by the old pending-field validator. | Contextual intent interpretation before field handling; clarification keeps the question open without spending a retry. |
| B21 | `10 usd` lost its currency and prompted for USDC versus ETH again. | Retain explicit currency in amount replies and validate conflicts/precision. |
| B22 | A corrected amount's summary omitted the USD interpretation or quoted an earlier phrase. | Preserve accepted reply wording independently from original masking positions. |
| B23 | A malformed model amount span could erase `pay mihir`, causing a balance response after the amount answer. | Require monetary span evidence; preserve no-amount request text and reject unsafe broad spans. Precision, fiat and `5 more` compatibility have permanent regressions. |

The frozen conversation revision `a05cb9d` passes **2,129 unit/acceptance tests, 205 audit checks and seven real-model
conversation scenarios**, plus typecheck, lint and build. Independent Astra/max reviewers graded the code and tests.
The complete 154-prompt rerun has **129 exact outcomes, 25 existing stops, zero wrong handoffs, no crashes or rejected
summaries**, and no changed final outcome/stop/code signatures. The updated frontend on port 8791 also passes the
reported Yash → `10 usd` → `pay riya` flow over actual TCP with real Qwen and zero submissions. Remaining limits,
legacy fixture adaptations and raw evidence are recorded in the linked conversation report.

The final working-tree rerun also passes all **2,129 tests and 205 audits**, with zero failures or skipped/todo tests;
typecheck, lint and build pass. Generated live traces retain their original bytes and recorded hashes.

**Original review: 19 grouped findings (9 P1, 10 P2), plus 3 separately identified contract/semantic gaps.** Nine independent reviewers ran with `gpt-6-astra`, reasoning effort `max`, in waves of three, alongside the coordinating agent. Five findings reproduced previously acknowledged pending fixes (SQ-R-02 through SQ-R-06). Two earlier defects were fixed by concurrent changes and passed rechecks; they are excluded from that count.

## Remediation status — 2026-11-06

All 19 findings and the 3 gaps now have implemented fixes and regression coverage. Independent Astra/max reviewers
tested the changes; they also found and verified fixes for interval-one schedules, donor-specific bridge rounding,
leading-decimal zero amounts, optional “starting on” date markers, answer URL secrets, and chain scope across masked
text and sentence boundaries. A fresh final-code checkout passes **1,874 unit/acceptance tests and 169 audit checks**,
plus typecheck, lint and build. The production TCP smoke test passes, and npm audit reports **zero vulnerabilities**,
including development tools.

The full 154-case live-model run has **0 wrong handoffs** (previously 2), **25 unexpected stops** (previously 54), and
129 exact expected outcomes (previously 98), with no crashes or rejected summaries. Six baseline successes now stop
safely, and the 20-second latency target remains unmet. All **53 final-toolchain repeats** reproduce their primary
outcomes, including both formerly wrong cases; no repeat has a wrong handoff, crash or rejected summary.
See [LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md) for the raw results, metric definitions and remaining limits;
[STATUS.md](STATUS.md) records the handoff checklist. Fix completion does not imply every model request succeeds.

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| B01 | Deterministically parsed zero never becomes a positive model amount; glued tokens and leading decimal zeros are covered. | `test/unit/B/s3.test.ts` |
| B02 | Distributive words relax pairing only in their own clauses. | `test/unit/D/core-review.test.ts`, `s8-pair.test.ts` |
| B03 | Reports match the submitted request, step, kind and autopay ID, including cancel-only requests. | `test/acceptance/handoff-independent.test.ts`, `review-hardening.test.ts` |
| B04 | Executed spend cannot be downgraded; stale reports cannot revive cancelled/ended autopays. | Same HTTP/SQLCipher suites, including actual create → cancel → replay |
| B05 | Session close/replacement waits for in-flight work, then clears session stores and deferred journal history. | `test/acceptance/core-review.test.ts`, `handoff-independent.test.ts` |
| B06 | Cancellation of an earlier handed-off request consults history and durable submission state. | `test/acceptance/core-review.test.ts` |
| B07 | Ambiguous timeout cancellation uses the wallet-check warning. | `test/acceptance/core-review.test.ts` |
| B08 | Both answer entrypoints scan raw text and decoded URLs before storage or model calls. | `test/acceptance/review-hardening.test.ts`, `handoff-independent.test.ts` |
| B09 | A late first confirmation asks for a new autopay start and a fresh summary. Already-submitted retries remain immutable. | `test/acceptance/core-review.test.ts`, `review-hardening.test.ts` |
| B10 | Duplicate report transaction hashes do not insert spend twice. | `test/acceptance/core-review.test.ts` |
| B11 | Contact-name matching uses Unicode identifier boundaries. | `test/unit/B/s5.test.ts` |
| B12 | Unsupported token screening handles glued quantities and compound number words. | `test/unit/B/lexical.test.ts` |
| B13 | Context masking requires independently recognizable amount evidence; no-amount prompts remain intact. | `test/unit/B/s3.test.ts`; complete live evaluation |
| B14 | Repeated valid action labels are narrowly deduplicated before schema validation. | `test/unit/B/ollama.test.ts`; complete live evaluation |
| B15 | Malformed URL escapes cannot suppress scanning of separately encoded secrets. | `test/unit/B/s1.test.ts`, `fetch.test.ts` |
| B16 | Future local dates/times use date-aware IANA offsets. | `test/unit/B/chrono.test.ts`, `test/acceptance/schedule-dates.test.ts` |
| B17 | Explicit date-range direction survives chrono normalization, including optional start prepositions. | Same date suites |
| B18 | A short autopay's period cap is bounded by its total cap. | `test/unit/D/core-review.test.ts` |
| B19 | SQLCipher commits immutable submission identity and DB6/DB7 reservations before sending; post-accept failures remain recoverable. | Independent real `SQLITE_FULL`, cold reopen and fresh HTTP callback tests |
| G01 | Explicit chains are checked per payment and sentence, using consistent typed-text offsets. | `test/acceptance/chain-binding.test.ts`, `handoff-independent.test.ts` |
| G02 | Pre-submit persistence allows valid callbacks before the executor's HTTP response. | Independent early i/k/l callback tests |
| G03 | First confirmation refreshes balances/settings, revalidates funding/limits, and requires renewed consent when changed. | `test/acceptance/review-hardening.test.ts`, `handoff-independent.test.ts` |

The durable journal is an additive encrypted schema-v2 table. The original schema file and README specification are
unchanged. Protocol decisions, including the immutable-retry boundary for late schedules, are documented in
`SPEC_QUESTIONS.md`. The human approved retaining all three previously interim UI texts.

The original review evidence below is retained unchanged in substance. Its source locations and “observed” behavior
describe the reviewed revision before remediation, not the current implementation.

## Scope and evidence

The review exercised the real S0–S12 pipeline, authenticated HTTP routes, SQLCipher repositories, amount/recipient masking, questions and answers, planning, limits, summaries, confirmation, execution envelopes, report ingestion, session lifecycle, and recovery paths. Most adversarial scenarios use Fastify HTTP injection with controlled LLM/RPC/ENS/execution dependencies. A separate TCP smoke test used production startup/configuration, token files, RPC and Ollama HTTP transports, execution transport, and report endpoints against local fixture servers.

The live-model reviewer independently ran the actual installed Ollama `qwen2.5:7b-instruct` model: 8 distinct scenarios, 11 executions including repeats and invoice recovery, 35 logical model calls, and 37 HTTP chat requests. The five confirmed execution envelopes matched their reviewed summaries. Three supported request types failed; details are below. No live-model timeout occurred. This small sample is not an accuracy benchmark.

No real funds were signed or broadcast. Public ENS/indexer deployments, real chain balances, the production OS keychain, and an external signing/execution implementation were not exercised. The repository contains the agent service; a wallet UI and signing layer are outside this checkout.

### Revision tracking

The checkout changed through another process during testing. The initial revision was `e383b24802c1de80520d3261b5add37592dfd666`; live tests arrived at `19210d3`; production understanding/recipient fixes arrived at `176881a`; later revisions changed documentation and live-test formatting. **Final verified checkout: `1fc01765367530ddaa3a8fc16bd61e78ac057348`.** Reviewers recorded their revisions and raw outputs. The coordinator reran all 109 deterministic review cases on the final checkout. The live-tested production LLM files were unchanged at final verification. No production code or pre-existing test was changed by this review.

### Verification results

| Check | Result |
| --- | --- |
| Initial build, typecheck, lint | Passed |
| Initial unit + acceptance suite, controlled workers | 1,652/1,652 passed |
| Initial separate audit suite, controlled workers | 154/154 passed |
| Final unit + acceptance suite | **1,678/1,678 passed**, 58 files |
| Final separate audit suite | **168/168 passed**, 6 files |
| Final build and typecheck | Passed |
| Final lint | Passed |
| Production TCP transport/startup round trip | Passed, including decline, confirmation, report authentication/update, and session wipe |
| Live Qwen sample | Simple send, follow-up, autopay creation, and unsupported-swap refusal passed; balance, cancellation, and multi-recipient requests failed; invoice recovered with clarification |
| Additional deterministic review suite | **109 cases: 82 passed, 27 failed assertions**, 9 files, 31.58 seconds; all failures match documented findings, with no timeouts |

The first unrestricted-concurrency baseline encountered host-load timeouts. Controlled runs passed; those timeouts are not counted as product defects. Some reproduction tests assert the required behavior and therefore fail; others deliberately assert the observed defect and pass. Their assertion counts must not be interpreted as a product success rate.

Detailed synthetic traces, reviewer reports, logs, and reproduction artifacts are retained locally under `/private/tmp/flex-codex-review/`. Test filenames cited below are archived in its `repro-tests/` directory; the replay command at the end restores them temporarily. Each finding includes a concrete reproduction and source location. The agent service still requires explicit final confirmation in the model-conditioned payment cases; the tests do not establish an unattended payment bypass.

| Astra/max reviewer | Focus | Independent cases |
| --- | --- | ---: |
| Understanding | Amounts, lexical rules, classification, follow-ups | 17 |
| Recipients | Names, ENS, groups, masking, provenance | 12 |
| Sessions | Concurrency, close/reopen, confirmation/cancel/retry | 15 |
| Live model | Actual local Qwen through HTTP routes | 8 scenarios / 11 executions |
| Planning | Pairing, chains, bridges, reservations, handoff fidelity | 15 |
| Reports | Correlation, replay, accounting, transactions, reopen | 14 |
| Security | Encoded secrets, SSRF, auth, attachments, quarantine | 12 |
| Schedules | DST, date ranges, recurrence, caps, limits | 12 |
| Fault recovery | Accepted delivery plus storage failure, recovery controls | 9 |

The coordinator added three secret-answer cases, performed the TCP smoke test, and reran the baseline and consolidated review suites. The newly merged 154-prompt live suite was not rerun wholesale; pre-existing live result files were not counted as this review's executions.

## Original implementation findings

Priority: **P1** warrants attention before relying on payment/accounting/privacy guarantees; **P2** is a correctness or availability defect. Priorities describe impact, not a claim that real financial loss occurred.

### B01 · P1 · A typed zero can become a positive payment without the required clarification

**Source:** `src/amounts/verify.ts:338`.

Submit `send 0 usdc to Mihir`; provide the schema-valid amount output `{phrase:"0 usdc", number:"5", token:"USDC", relative:null, fiat:null, role:"pay"}`. Normal classification, recipient resolution, and pairing reach a **5 USDC summary**, without `Q_AMOUNT_MISMATCH` or a positive-amount question. Confirming submits `amount.value:"5", base_units:"5000000"`. The same result was reproduced with `zero` and `0.000`.

The code parser recognizes zero, but its `reason === 'zero'` branch only sets `code_verified`; it then accepts the model's value. The later zero check sees 5. The summary exposes the discrepancy and requires confirmation, but the deterministic mismatch protection has failed. Compare zero with the model value and require the documented clarification before creating a payable amount.

**Evidence:** `understanding.test.ts`, `understanding-final.log`, `understanding.md`.

### B02 · P1 · An unrelated “each” disables amount-to-recipient checks across the request

**Source:** `src/plan/pairing-checks.ts:46`, `:84`, `:135`. **Known pending fix:** SQ-R-02.

Submit `send 10 usdc to Aradhya and 20 usdc to Mihir and 1 usdc each to Aradhya`. Supply a schema-valid pairing that swaps the first two recipients. The pipeline accepts it immediately, shows 10 USDC to Mihir and 20 USDC to Aradhya, and submits those payments after confirmation. The same swap without the third “each” clause is retried and rejected as `PAIRING_FAILED`.

One request-wide distributive flag disables P4 and related clarification for all clauses. SQ-R-02 explicitly requires the exception to apply only to amounts in the distributive word's own clause. Scope that exception per clause.

**Evidence:** `planning.test.ts`, case `each-unrelated-clause-swap`; `planning-evidence.jsonl`.

### B03 · P1 · Execution reports can mutate an autopay unrelated to the submitted intent

**Source:** `src/server/reports.ts:40`, `:46`, `:57`; `src/db/repos/db6.ts:63`.

Create an ordinary one-time payment and an unrelated active autopay. Post an authenticated `intent_result` for the payment's actual request and step, including the unrelated `autopay_id`. The endpoint returns 204, marks the payment executed, and marks the unrelated autopay **cancelled**, even though the captured envelope contains no cancellation. A subsequent `stop paying mihir` fails with `NO_ACTIVE_AUTOPAY`; no cancellation was submitted to the executor.

A second reproduction reports step 999 for a newly created autopay whose only step is 0. The endpoint returns 204 and activates DB7 while the actual prefund step remains pending. Request-ID equality alone chooses creation versus cancellation; the stored intent/step/autopay association is not checked, and the DB6 update count is ignored. Persist and verify that association before mutation. This requires the execution-report token; it is not an authentication bypass. It is distinct from the documented absence of a DB6 row for legitimate cancellation-only requests.

**Evidence:** `reports.test.ts`, R06–R08; `reports-evidence.json`.

### B04 · P1 · Stale or replayed reports reverse completed state and corrupt spending totals

**Source:** `src/db/repos/db6.ts:63`; `src/server/reports.ts:46`.

With a daily USDC limit of 10, execute and report a 10-USDC payment. The next payment correctly asks for a limit override. Now deliver a late `status:"failed"` callback for the original request/step. It returns 204, clears the stored hash and execution time, changes the row to failed, and reduces `spentToday` from **10 to 0**. The next payment reaches confirmation without the previously required override.

Separately, create and activate an autopay, legitimately cancel it through the agent and report that cancellation, then replay the original creation-success callback verbatim. DB7 changes **cancelled → active**. This requires only duplicate delivery of an old valid event.

The current protocol lacks ordering/version rules, and updates apply unconditionally. Define idempotent event processing and valid state transitions; a duplicate old creation result must not overwrite newer cancellation state. If correction or reorganization events are required, represent them explicitly.

**Evidence:** `reports.test.ts`, R09–R10, including downstream limit/cancellation behavior.

### B05 · P1 · Closing a session during asynchronous work does not keep its data deleted

**Source:** `src/session/manager.ts:169`, `:386`; `src/pipeline/s1-guard.ts:124`; `src/pipeline/s12-handoff.ts:153`.

Start a message containing typed and pasted text; hold the quarantine response. Delete the session: HTTP 204, stores empty. Release the response. The original message returns 404, but the closed session's **raw typed and pasted text reappears in DB8**. Another delete for that ID returns 404. Closing or replacing a session during the amount-model call similarly recreates old DB1 rows.

Closing while execution submission is pending also allows accepted S12 work to recreate DB8 history. For an autopay, DB7's recipient name becomes empty because DB3 was cleared before accepted-handoff bookkeeping read it.

The manager wipes immediately, then checks closure only after the awaited step has already performed writes. Coordinate closure with outstanding work and guard writes after awaits; snapshot accepted-handoff metadata before submission. The observed privacy failure is retention in encrypted storage, not plaintext exfiltration.

**Evidence:** `sessions.test.ts`, five close/reopen cases; `sessions-run.log`.

### B06 · P1 · Cancelling a previous handed-off request falsely says nothing was sent

**Source:** `src/session/manager.ts:264`. **Policy:** SQ-A-01/F-8.

Confirm request A and capture its submitted 50-USDC envelope. Start request B in the same session. Call `/cancel` with A's request ID. The response is **“Cancelled. Nothing was sent.”**, although A is still recorded pending and was delivered to execution. No cancellation is sent to the executor.

The handler recognizes a handed-off request only when it is still `s.active`; it treats another known request like an unknown/discarded one. Consult handoff history when choosing the response. This false assurance can lead the user to retry or rely on a cancellation that did not occur.

**Evidence:** `sessions.test.ts`, `cancel of an already handed-off request remains truthful…`.

### B07 · P1 · Cancellation after an ambiguous timeout falsely says nothing was sent

**Source:** `src/session/manager.ts:209`, `:261`. **Known pending fix:** SQ-R-06.

Confirm a valid summary while the execution boundary returns `{status:"unavailable", cause:"timeout"}`. Cancel through either `/cancel` or the text `stop`. Both return **“Cancelled. Nothing was sent.”** The request may already have reached the wallet; a transport timeout does not establish non-delivery.

SQ-R-06 requires “Cancelled here, but your wallet may already have received it. Check your wallet.” Preserve and use the last failure cause. The ordinary 5xx cancellation path is a separate policy.

**Evidence:** `sessions.test.ts`, two timeout-cancellation variants.

### B08 · P2 · Private-key-shaped clarification answers are stored instead of refused

**Source:** `src/session/manager.ts:185`, `:232`, `:352`.

With no saved recipient, send `Send 50 USDc to ARADHYA` and reach `Q_WHO_IS`. Answer with the synthetic string `0x` followed by `ab` repeated 32 times. Both `/answers` and `/messages` while awaiting an answer return another question and store the complete string in `db8_prompts`. The same string as a new request correctly returns `SECRET_DETECTED` and stores nothing.

Clarification input bypasses S1, and `answer()` writes before invoking its handler. Run secret detection at every text entrypoint before persistence. The evidence establishes encrypted retention; it does not establish model forwarding, log disclosure, or network exfiltration. No real secret was used.

**Evidence:** `answer-secrets.test.ts`, two failures and one successful initial-message control; `answer-secrets.log`.

### B09 · P2 · Late autopay confirmation submits an already-past first occurrence

**Source:** `src/session/manager.ts:371`; `src/pipeline/s12-handoff.ts:148`. **Known pending fix:** SQ-R-05.

At Thursday 23:00 Asia/Kolkata, prepare `pay mihir 10 usdc every friday for 8 weeks`. The first occurrence is Friday 10:00. Advance 12 hours and confirm. The agent submits the unchanged schedule with the first occurrence **one hour in the past**. It does not ask `Q_AUTOPAY_START` or present a revised summary.

SQ-R-05 requires the new start question, replanning from S9, and fresh confirmation. Check freshness before S12. Whether an external scheduler rejects, skips, or immediately executes that occurrence was not tested.

**Evidence:** `sessions.test.ts`, delayed confirmation case and captured envelope.

### B10 · P2 · Duplicate autopay-payment reports count the same transaction twice

**Source:** `src/server/reports.ts:85`. **Known pending fix:** SQ-R-04.

Post the same 10-USDC `autopay_payment` callback twice, with identical transaction hash and timestamp. Both return 204 and insert separate DB6 rows. `spentToday` becomes 20 instead of 10; under a daily limit of 20, another 10-USDC payment unnecessarily requires an override.

SQ-R-04 explicitly requires accepting a duplicate hash without inserting again. Make deduplication atomic with insertion.

**Evidence:** `reports.test.ts`, R11; DB6 rows and subsequent limit question in `reports-evidence.json`.

### B11 · P2 · A partial model name span still resolves `Mihir2` as saved contact `Mihir`

**Source:** `src/pipeline/s5-spans.ts:129`; `src/lexical/text.ts:68`.

Submit `send 10 usdc to Mihir2`, with a schema-valid but truncated model span `Mihir`. Deterministic span verification accepts the substring and produces a summary paying saved contact Mihir without recipient clarification. The payments prompt contains `address_<id>2`, while its recipient table refers to `address_<id>`.

The helper used by S5 treats letter-to-digit transitions as boundaries. Use recipient-specific identifier boundaries. The concurrently merged exact-repeat sweep fix protects S7 repeats but does **not** repair S5's initial span validation. The wrong recipient is visible in the summary; a live-model incidence rate was not measured.

**Evidence:** `recipients.test.ts`, partial-name regression; post-merge `recipients-recheck-cae2664.log`: 11 passing controls/regressions, this one failure.

### B12 · P2 · Unsupported token detection misses attached tickers and compound number words

**Source:** `src/lexical/scan.ts:121`, `:271`; `src/lexical/patterns.ts` unsupported-token pattern.

Submit any of `send 100usdt to Mihir`, `send one hundred usdt to Mihir`, or `send one thousand usdt to Mihir`. With faithful amount fixtures preserving the phrase and number, the agent calls the amount model and asks whether the amount is **USDC or ETH**, instead of returning `UNSUPPORTED_TOKEN` for the explicitly specified USDT.

The ticker pattern misses a directly preceding digit; compound words inspect only the immediately adjacent word (`hundred` or `thousand`), which is not a complete amount by itself. Detect the full adjacent amount expression before asking for a supported asset. The tests stop at the incorrect clarification and do not claim a payment without asset selection/confirmation.

**Evidence:** `understanding.test.ts`, three unsupported-token cases.

## Live-model integration failures

### B13 · P2 · Context-amount masking erases balance and cancellation requests

**Source:** `src/pipeline/s3-amounts.ts:123`; `src/schemas/llm-amounts.schema.json`.

The real model returned this valid schema output for `what's my balance`:

```json
{"amounts":[{"phrase":"what's my balance","number":null,"relative":null,"token":null,"fiat":null,"role":"context"}]}
```

S3 accepts it without establishing that it contains an amount, masks the entire message to `[amount]`, and sends `Message: <<<[amount]>>>` to classification. The result is `UNSUPPORTED_REQUEST`. The balance failure reproduced twice. `stop paying mihir`, with an active seeded autopay, failed through the same path.

The model extraction mistake is amplified by a deterministic integration gap. Require evidence of an amount before allowing a context entry to erase an arbitrary span, and test no-amount requests with the real model. This is a supported-request availability failure, not an unauthorized handoff.

**Evidence:** `live-model.json`, `live-model-repeat.json`, cases 03 and 06; raw calls and response transcripts in `live-model.md`.

### B14 · P2 · Duplicate action labels repeatedly break a normal multi-recipient request

**Source:** `src/llm/prompts/requestType.txt`; `src/schemas/llm-request-type.schema.json:7`; `src/llm/ollama.ts:93`.

For `Send 10 usdc to Aradhya on base and 20 usdc to Mihir on arbitrum`, the live classifier returned `actions:["i","i"]` on **all four observed attempts** across two complete API runs. The schema requires unique action kinds. Both requests returned `MODEL_FAILED` before recipient resolution/planning.

Rejecting invalid schema output is correct and safe. The defect is the reproducible prompt/model/schema incompatibility on a supported request, coupled with an identical retry that repeats the same invalid representation. Clarify unique action-kind semantics in the prompt or implement the narrowly approved normalization from SQ-L-01; retain schema enforcement and retest the full live set before accepting a fix.

**Evidence:** `live-model.json`, `live-model-repeat.json`, case 02. No timeouts contributed.

## Additional security, schedule, and recovery defects

### B15 · P1 · Malformed URL encoding bypasses the pre-fetch secret check

**Source:** `src/guard/urls.ts:69`; `src/pipeline/s1-guard.ts:93`; `src/quarantine/fetch.ts:132`.

Percent-encode every character of a synthetic 64-hex key in a URL query parameter, then add an unrelated malformed component:

```ts
const synthetic = 'ab'.repeat(32);
const encoded = [...synthetic].map(c => `%${c.charCodeAt(0).toString(16)}`).join('');
const url = `https://invoice.example.invalid/?key=${encoded}&discount=50%`;
```

`urlHasSecret(url)` returns false. Through both typed URLs and `urls[]`, the production fetcher reaches its HTTP callback with this URL; `new URL(requestedUrl).searchParams.get('key')` recovers the original synthetic key. Replacing the malformed component with `label=%FF` also bypasses the check. A clean initial URL redirecting to that target performs the second request too. Removing the malformed component correctly produces `SECRET_DETECTED` with no fetch.

Whole-URL `decodeURIComponent` throws on any malformed component; the fallback scans only the encoded string. Decode components independently/tolerantly or reject malformed encoding before HTTP. This can transmit a secret already present in the user's URL; it does not read secrets from the wallet. Tests used injected DNS/HTTP and synthetic data, with no external destination contacted.

**Evidence:** `security.test.ts`, two failing regressions covering five URL/redirect variants; `security-run.log`, `security-evidence.jsonl`.

### B16 · P2 · Parsing a future date across DST shifts the requested payment time and date

**Source:** `src/lexical/chrono.ts:24`, `:45`.

In an `America/New_York` session during winter, an explicit start of **July 1, 2026 at 10:00** becomes `first_occurrence:"2026-07-01T11:00:00-04:00"` and cron `0 11 * * *`. In the reverse season, an explicit **December 1 at 00:30** becomes **November 30 at 23:30**, with cron `30 23 * * *`. Both incorrect schedules reached the execution envelope after confirmation.

The parser receives the session's *current numeric UTC offset*, then converts the resulting future instant using the timezone's actual future offset. The offset difference changes the user's wall-clock fields. Preserve the requested local calendar/time components and resolve them in the IANA timezone on the scheduled date. Same-offset parsing and already-constructed schedule recurrence across DST passed; the defect is in natural-language date/time ingestion.

**Evidence:** `schedules.test.ts`, two full-HTTP DST cases and controls; `schedules-vitest.txt` and `schedules-evidence.jsonl`.

### B17 · P2 · Reversed explicit start/end dates are silently turned into an executable schedule

**Source:** `src/lexical/chrono.ts:51`; `src/pipeline/s9-plan.ts:192`.

Request a daily payment **starting November 20, 2026 until November 10, 2026**. The application reverses the endpoints into November 10–20 and creates an **11-payment schedule**, instead of reporting no occurrences or requesting correction. The requested endpoints, used unchanged in the schedule enumerator, correctly produce zero occurrences.

The date-range parser sorts explicit endpoints, and the wrapper assigns start/end roles to that sorted result without preserving the user's markers. Validate the original start/end relationship before allowing normalization to change the request. The summary exposes the resulting schedule, but it should not manufacture a different valid interval from an invalid one.

**Evidence:** `schedules.test.ts`, reversed-boundary HTTP handoff and direct enumerator control.

### B18 · P2 · Short autopays use a weekly cap greater than their entire prefund

**Source:** `src/pipeline/s9-plan.ts:241`; `src/plan/schedule.ts:133`. **Known pending fix:** SQ-R-03.

Prepare **20 USDC daily for 2 payments**. The total is 40 USDC, but `per_period_cap` becomes 140 USDC (20 × 7). This unnecessarily asks `Q_LIMIT_OVERRIDE` against the default 100-USDC period limit. Answering Yes produces an envelope with **period cap 140, total cap 40**.

SQ-R-03 requires `min(amount × maximum weekly occurrences, total_cap)`, which yields 40 and needs no override here. Cap the period allowance by the funded lifetime total. The tested outcome is an inflated cap and unnecessary override, not execution of seven payments.

**Evidence:** `schedules.test.ts`, short-autopay case, question and final envelope.

### B19 · P1 · A database failure after execution acceptance loses delivery records and says nothing was sent

**Source:** `src/pipeline/s12-handoff.ts:153`, `:173`; `src/session/manager.ts:386`; `src/contracts/catalog.ts` internal-error text.

Let the executor accept the real envelope, then fail DB6, DB7, or DB8 persistence. Tests injected individual write failures and a real `SQLITE_FULL` condition. The bookkeeping transaction rolls back all local delivery records, but the executor already accepted the envelope. The API returns terminal `INTERNAL_ERROR` with **“Nothing was sent.”** Confirmation retry returns 409, and valid execution callbacks return 404 even after repairing/reopening storage.

Repeating the same user action after restart creates a second accepted envelope with a new request/idempotency key; for an autopay it also creates a new autopay ID. Only the second delivery is recorded locally. This demonstrates duplicate submission potential under a storage fault, not two observed on-chain executions.

Maintain recoverable, durable delivery state across the acceptance/persistence boundary, and never report non-delivery after a known acceptance. Reuse the original request identity for recovery. Report-before-response timing in G02 is a separate race; this case receives acceptance first and then loses bookkeeping.

**Evidence:** `faults.test.ts`, five observed-failure scenarios plus four recovery/control cases; `faults-run.log` and `faults.md`.

## Confirmed protocol and semantic gaps

These behaviors were reproduced, but the current specification either permits the narrow implementation or does not define the missing guarantee. They should be addressed through an explicit contract decision rather than described as undisputed violations of an existing rule.

### G01 · P2 · Explicit chains are not deterministically bound to their payment clauses

`src/plan/pairing-checks.ts:105` allows any chain mentioned anywhere, or `unstated`. A fixture swapping the Base/Arbitrum chains in `send 10 usdc to Aradhya on base and 20 usdc to Mihir on arbitrum` reaches confirmation and handoff. A fixture returning `unstated` for `send 10 usdc to Mihir on arbitrum` produces Base because its balance is larger. Summaries accurately expose the wrong chains and still require approval.

This satisfies P9's current global allowlist but fails to preserve unambiguous request meaning. Consider checking explicit per-clause chains and asking on disagreement. **Evidence:** `planning.test.ts`, the two `explicit-chain` scenarios.

### G02 · P2 · A callback arriving before the submission response is rejected

`src/pipeline/s12-handoff.ts:153` awaits submission before recording pending DB6/DB7 rows. An executor that receives the envelope and calls `/v1/execution/reports` before returning its 2xx gets **404**, for both ordinary payments and autopay creation. Submission subsequently succeeds but local records remain pending without the already-reported result. Retrying the callback after the response works.

README specifies writes after 2xx but does not guarantee callback ordering or retries. Loss is conditional on the executor not retrying 404. Establish correlatable submission state earlier, buffer early results, or explicitly enforce response-before-callback and retry semantics. **Evidence:** `reports.test.ts`, R05a/R05b.

### G03 · P2 · Confirmation uses stale settings and balance validation

Prepare 50 USDC on Base; change settings to a 1-USDC per-payment limit and allow only Sepolia; drop the fake Base/Arbitrum balances to zero; advance 30 days; confirm. The agent submits the original Base plan without refreshing RPC, limits, or the summary. The request-start limit snapshot remains authoritative (`src/session/manager.ts:317`, `:371`).

The spec validates at S10 and deliberately has no idle timeout, so this is a design gap, not a clear current-spec violation. Decide whether settings changes invalidate pending summaries and when revalidation is required. **Evidence:** `sessions.test.ts`, stale-validation observation.

## Resolved during this review by concurrent changes

- **Document alias provenance laundering:** On the initial revision, confirming/saving a document address allowed a second ENS alias for the same address to become `source:'contact'` and enter an autopay. The independently merged `176881a` tracks addresses newly added in the current request and preserves untrusted provenance. The coordinator adapted the test to answer the additional required address confirmation; it now ends with `UNTRUSTED_IN_AUTOPAY` and no handoff. Do not count this as an open defect.
- **Exact-repeat masking of `Mihir2`:** Initial S7 sweep tests rewrote this as a repeat of Mihir. The merged Unicode-aware sweep boundaries fixed those tests. B11 remains open because it concerns S5's separate initial span-matching helper.
- **Initially absent live suite:** `npm run test:live` initially exited with no test files; `19210d3` supplied the suite. This is historical execution context, not an open bug.

## Successful controls

Controls covered normal one-time and multi-payment planning; bigint bridge rounding, buffers, dependencies, and gas on both sides; pending-fund reservations; autopay prefunding; normal confirmation/decline and duplicate-confirm rejection; stale question rejection; exact-envelope/idempotency-key retries; ENS rechecks and fallback; chain-specific recipients; group deduplication and selection; untrusted-recipient blocking after the merge; report token separation; report/settings transaction rollback; encrypted DB reopen and wrong-key rejection; ordinary session wipe; and log-value exclusion.

In the live invoice scenario, the model returned the nondecimal string `strconv(20)` and the app requested an amount. Explicit user answers recovered to the correct 20-USDC envelope; rejecting the injected recipient worked, and document instructions did not enter the primary-model prompts. This was recoverable model-quality friction, not a demonstrated injection bypass.

## Reproducing the review

Environment: macOS arm64, Node `v25.9.0`, npm `11.12.1`, Vitest `3.2.7`. The production model was Ollama `0.40.14`, `qwen2.5:7b-instruct` / 7.6B / Q4_K_M, temperature 0, seed 42, context 8192, 60-second timeout. Model digest and prompt hashes are preserved in `live-model.md` and the trace artifacts.

From the project root, the final baseline commands were:

```sh
npm run build
npm run typecheck
npm run lint
npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000
./node_modules/.bin/vitest run --config test/audit/vitest.audit.config.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
```

Review-specific tests were archived outside the checkout to leave only this requested report as a project change. These local commands replay the evidence:

```sh
# Recreates test/codex-review temporarily, runs 109 cases, then removes those copies.
# Exit 1 is expected while the documented failing invariants remain.
node /private/tmp/flex-codex-review/replay.mjs

# Optional: actual local Ollama sample; requires the installed model/service.
node /private/tmp/flex-codex-review/replay.mjs --live

# Real TCP round trip with local upstream fixture servers; uses the current build.
node /private/tmp/flex-codex-review/runtime-smoke.mjs
```

The replay helper refuses to overwrite an existing `test/codex-review` directory. These evidence files live in temporary local storage and should be copied elsewhere before that storage is cleared. The report's concrete inputs and observations remain usable independently of those files.

Primary consolidated evidence: `final-test.log`, `final-audit.log`, `final-typecheck.log`, `final-build.log`, `final-lint.log`, `final-review.log`, and `runtime-final.log`. Original per-reviewer JSON traces were also preserved under `original-evidence/` before the final rerun. The archive replay helper was verified with a passing control and cleaned up its temporary test copies. No fixes, commits, deployments, or real payment submissions were performed by this review.
