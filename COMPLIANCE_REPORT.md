# Compliance and privacy review — 2026-11-06

The checklist has 513 rows supported by deterministic checks, including three explicitly approved differences
from worked examples. C-514 is implemented but remains pending until the full 154-case live evaluation satisfies
SQ-L-01. A passing unit suite does not establish that live-model condition.

Production reviewed through `33518a2`, plus the narrow document-only chain guard `ef69e31`, including the merged
core, understanding, schedule, durable-handoff, secret-screening, chain-binding and confirmation changes. The independent reviewer authored tests and this report,
not those production changes. The review uses `README.md` together with the binding answers in
[SPEC_QUESTIONS.md](SPEC_QUESTIONS.md) and [SPEC_ANSWERS_FOLLOWUP.md](SPEC_ANSWERS_FOLLOWUP.md).
The later human answers and the current request to fix all review findings govern the differences below.
`README.md` is unchanged. Node 25.9.0 is accepted by SQ-11.

## Checklist accounting

| Owner | Items | implemented + tested | approved deviation + tested | live acceptance pending |
| --- | --- | --- | --- | --- |
| Lane A | 81 | 81 | 0 | 0 |
| Lane B | 123 | 123 | 0 | 0 |
| Lane C | 73 | 73 | 0 | 0 |
| Lane D | 152 | 152 | 0 | 0 |
| Orchestrator | 85 | 81 | 3 | 1 |
| **Total** | **514** | **510** | **3** | **1** |

Every checklist row and the resolved question sets were inspected. The evidence inventory maps 503 rows to explicit
`C-nnn` or `A-nn` references in test sources. Ten others map to section-based assertions or direct artifact checks:
C-004 (config), C-267–270 (four LLM schemas), C-272 (payments template), C-273 (internal plan schema), C-274 (handoff
schema), C-440 (E9/A-15), and C-441 (E10/A-16). C-514 is the live gate. This is traceability evidence, not a proof that
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
| SQ-L-01 | The system text of amounts, requestType, spans and payments may change, subject to the full live gate. All USER slots and §12 schemas remain unchanged. Only repeated valid action kinds are deduplicated before normal schema validation; invalid kinds, missing fields and extra fields still fail. Exact old/new text, reasons and live evidence belong in [PROMPT_CHANGES.md](PROMPT_CHANGES.md). Retention is still conditional until C-514 is accepted. |
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
| Five prompts | Four changed system texts equal independently reviewed golden fixtures. Q-LLM remains identical to README. All five USER portions remain equal, with only SQ-21's documented removal of inline explanatory comments for payments. |
| §7.1 DDL | Original `schema.sql` is identical except its header comment. The separate v2 migration adds the authorized journal; it does not rewrite that DDL. Guard tests check all ten original tables, constraints, keys and DB2 index. |
| §6.1 config / §6.3 defaults | Parsed config equality; all eight default keys, values and types equal the spec. |
| §6.2 static tables | Exact arrays/token metadata asserted by ten passing guard cases. Added recognition of explicit recurrence/group forms is in lexical patterns, not a silent rewrite of the tables. |
| §13.4 questions | 25 quoted baseline rows compared: 24 retained texts match with optional-slot notation resolved; the old group-limit row is replaced as approved. Q_ENS_CHANGED is checked against §9.4. The catalogue has 28 codes and tested new question text/chips. |
| §15 errors | All 35 codes checked: 34 base templates remain literal; UNSUPPORTED_REQUEST is the approved F-7 difference. F-9 final-attempt and F-10 empty-balance variants are separately tested. |
| §13.1–13.2 summaries/balances | Templates and exact-output tests reviewed; approved generalized override and silent-reuse notes are recorded above. Group punctuation and ordinal wording follow the resolved SQ-D answers. |

Machine-readable inventory and comparison results are saved in
`/private/tmp/flex-codex-fixes/compliance-evidence.json` and `compliance-catalog-evidence.json`.

## Independent verification and privacy sweep

- Understanding, date and contract checks: 512/512 passed. The reviewer then found two uncovered variants, added
  failing regressions, and asked a different author to fix them: `.0`/`.000` must not turn into a positive amount,
  and “starting on”/“beginning on” must preserve reversed explicit dates. Corrected S3/date/HTTP checks pass 104/104;
  parser checks pass 8/8. Additional probes preserve local fields across Lord Howe, Chatham and Dublin DST changes.
- An adjacent G01 probe found that “pay this invoice on arbitrum” could confirm on Base when both amount and
  recipient came from content and the model returned unstated. Root fixed the missing binding in `ef69e31`; four
  independent HTTP regressions cover rejection, correction, an accurate first response and no-chain automatic
  selection. The combined chain/S8 rerun passes **48/48**. This source change followed the live freeze: the unchanged
  154-case manifest has content only in A-15, A-45 and A-46, none with a typed chain. A-45/A-46 stop before S8.
  Corpus hashes and scope evidence are in `document-chain-live-scope.json`; the final-toolchain A-15 live smoke
  remains a separate coordinator check.
- Prompt checks pass 15/15; S8 and the independent LIVE-P061/LIVE-P073 interval regressions pass 52/52. Wrong-twice
  duration-as-interval output stops; wrong-then-right and explicit every-other/every-two/fortnightly controls pass.
- The separate durable-handoff reviewer reports 42/42 HTTP checks, 207/207 adapted legacy checks, and 6/6 error-audit
  checks after the independently discovered answer-URL and chain-scope fixes. Typecheck and scoped lint/format
  checks pass. The final integrated deterministic run passes **1,870/1,870 tests across 66 files**; the final audit
  passes **169/169 across six files**. Artifacts are `integrated-verified.json` and `compliance-final-audit.json`
  under `/private/tmp/flex-codex-fixes/`. The runtime smoke test also passes real local TCP, production clients and
  SQLCipher against fixture servers; no public-chain submission occurs.
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
Ollama calls were made by this independent reviewer. The full live set remains the coordinator's separate gate;
its zero-wrong-handoff and reduced-needless-stop conditions are not inferred from these deterministic results.

## Remaining acceptance gate

C-514 and retention of the SQ-L-01 candidates remain pending the complete frozen-source 154-case run. Earlier
results and short probes are insufficient. The final report must record wrong handoffs, pairing exact-match,
question/stop counts, and the comparison with the unchanged baseline before marking this row accepted. The existing
`pairing_exact` field measures S8 passing without a correction retry or model error; report it as first-pass pairing
validation, alongside semantic exact outcomes. The live oracle compares expected `i`/`k`/`l` outcomes and selected
schedule fields; bridge calculations, complete schedule timing and persistence also rely on the deterministic suites.
No additional unresolved production defect was found in this review's assigned scope after `ef69e31`.
