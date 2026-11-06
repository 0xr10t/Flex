# SPEC_ANSWERS_FOLLOWUP

Consistency check of the human's answers of 2026-11-06 (recorded in `SPEC_QUESTIONS.md`). README.md is unchanged.
Part 1 lists what was checked and found consistent. Part 2 records the human's answers to the 13 follow-up questions
(F-1 to F-13), given 2026-11-06 and binding. Part 3 is the final consistency pass. Part 4 is the code-change list by owner. Ids: SQ-D-16 means answer 13 (one-time limit overrides).

## Confirmed consistent (no question needed)

- **Item 13 vs §1.3** ("User-set limits (DB5) can only be changed from settings, never from chat"): consistent. The
  override applies to one request, DB5 is never written, and it is the same mechanism as the existing
  `daily_limit_override` of `Q_GROUP_OVER_LIMIT`. The "Yes" is a user answer through `/answers`, which attached content
  cannot give.
- **Item 13 vs item 12**: item 12 (`Q_GROUP_OVER_LIMIT` "No" gives "Cancelled. Nothing was sent.") matches item 13's "No"
  reply. Same reply everywhere.
- **Item 13 vs E9 and SQ-D-16's old note**: E9 (invoice amounts from attached content) keeps ending with `LIMIT_PER_TX`
  under default limits, as the human said. Test A-15 still raises the limit in its setup. If the user picks "Type a
  different amount" (the row becomes `source='user'`), the amount is typed and the new question may apply.
- **Item 13 vs the spec text**: §11.3 ("the only question S10 can ask is `Q_GROUP_OVER_LIMIT`") and the V-13/V-14/V-15
  "Otherwise `LIMIT_DAILY`" rows are now a human-approved difference. README is not edited.
- **Item 10 vs §15 / §8.5 rule 1 / compliance**: the new `UNSUPPORTED_REQUEST` text differs from §15 (verbatim) and from
  §8.5 rule 1 (which has "I can't do: <short reason>"). Human-approved difference. Consequences: the C-395 test
  (`test/unit/contracts/error-messages.test.ts`) must expect the new text for this one code, and the
  `COMPLIANCE_REPORT.md` row "Identical for all 35" must say "34 identical, `UNSUPPORTED_REQUEST` human-approved
  difference". SQ-22/SQ-A-03 and every "uncovered state" path (SQ-C-01…03, SQB-06, SQB-08, SQB-14, SQ-D-08, ...) now
  show this text too; their internal rule ids are still logged.
- **Item 8 vs SQ-06/SQB-01 list joining**: use the same join ("A", "A and B", "A, B and C"); amounts have no trailing
  zeros (§10.1, §13.1). Example: "Base Sepolia (80) and Arbitrum Sepolia (60)". The `{need}` and the total are also
  without trailing zeros. No question.
- **Item 9 vs SQ-A-03**: no clash. Failures 1 and 2 leave the request in `HANDOFF_FAILED`, so SQ-A-03 (cancel words
  cancel, other text gives `UNSUPPORTED_REQUEST`) stays. After failure 3 the request is `FAILED`; `confirm` gives 409 as
  today. The final text is returned in the same response as the third failure. Orchestrator detail: reuse the code
  `EXECUTION_UNAVAILABLE` with a different text on attempt 3, so the catalogue stays at 35 codes.
- **Item 6 vs P2/P3**: P2 (each amount used once) and P3 (each payee paid) are untouched. Only P4's trigger changes.
- **Item 3 vs SQB-12**: `0.0.0.0/8` and `::` stay refused; the new ranges are added. The decoded IPv4 of
  `64:ff9b::/96`, `2002::/16` and `::a.b.c.d` is checked against all refused IPv4 ranges (127/8, 10/8, 100.64/10, ...).
- **Item 7 vs C-497 / A-44**: README A-44 expects `SELF_PAYMENT` for "send 10 usdc to me"; the human chose `Q_NO_PAYEE`.
  Human-approved difference. `SPEC_CHECKLIST.md` C-497 stays "deviates", but is now answered, not open. The own-address
  variant of A-44 still gives `SELF_PAYMENT`.
- **Item 1 vs SQ-C-08 history**: history stores placeholders only; repeated placeholders in a stored text are fine.
- **Item 14 vs SQ-A-03**: cancel in `HANDOFF_FAILED` still cancels (`DISCARDED`) with "Cancelled. Nothing was sent."; no clash. Only a `HANDED_OFF` request gets the different reply (F-8).

- **SQ-O-10 vs `reused_from_chain_id`**: consistent, no human question left. DB3 stores one chain id (README line 467,
  plan schema line 1342), but the note can list all chains without a schema change: at summary time (S11), take the
  contact's DB2 rows whose address equals the reused address (the address held by the DB3 placeholder), excluding the
  payment's own chain, and list their chain display names in configured-chain order with the SQ-06 join ("A and B").
  Rows of the same contact with a different address are not listed. `reused_from_chain_id` stays the single "source"
  chain (set in S9), used only as the marker that a reuse happened. Nothing changes between S9 and S11 in one request,
  so the derived list is stable. One chain gives the same note as today.

## Follow-up answers (human, 2026-11-06, binding)

- **F-1 (SQ-D-16) several limits at once.** One question names every broken limit: "This is 150 USDC, over your
  per-payment limit of 100 and today's limit of 300. Go ahead this once?" One "Yes" lifts all of them for this request.
- **F-2 (SQ-D-16, SQ-15) group question.** Merged into the general question. `Q_GROUP_OVER_LIMIT`, `daily_limit_override`
  and the note "Today's limit was lifted once for this group payment." are generalized into the new question, flag and
  note, under the same rules. A group payment with attached-content amounts now ends with the limit error.
- **F-3 repeating payments.** Different wording: "This repeating payment is over your weekly autopay limit of 100. Set
  it up anyway?" Same for the duration limit.
- **F-4 `LIMIT_BRIDGES`.** It asks too: "This needs 4 transfers between chains; your limit is 3. Go ahead this once?"
- **F-5 mixed amounts.** Any amount in the request from attached content: no question, the limit error stands.
- **F-6 typed or not.** Relative amounts ("half my eth", "all my usdc") count as typed. Agent-calculated amounts (bridge
  padding, autopay caps) count the same as the amount they come from.
- **F-7 `UNSUPPORTED_REQUEST` text (replaces the text in answer 10).** "I can send USDC or ETH, bridge funds between
  chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part."
  This now matches behaviour: a direct bridge request is still unsupported (planned, CCIP).
- **F-8 cancel after hand-off.** "That was already sent to your wallet for signing, so it can't be cancelled here."
  (HTTP 200, request state unchanged). Every other no-active-request cancel keeps "Cancelled. Nothing was sent."
- **F-9 3rd failed hand-off.** On a timeout: "I couldn't confirm your wallet received this after 3 tries. Check your
  wallet before trying again." On a 5xx: "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again
  later." The cause of the 3rd attempt decides which text.
- **F-10 `INSUFFICIENT_FUNDS` list.** Only chains with a positive spendable amount of that token, in configured chain
  order; unreadable chains are left out. When no chain is positive (SQB-11), the reply is "…and can use 0." without an
  "across" part.
- **F-11 relaxed P4 (SQ-O-03).** "Ask when unclear". Cross-clause pairings are allowed more widely, but the user is asked
  who gets which amount whenever the request has several recipients and a payment's amount and recipient are in
  different clauses ("10 usdc and 20 usdc to mihir and riya", "send 10 usdc. send 20 usdc to Mihir"). A single
  recipient in one sentence ("10 usdc and 0.01 eth to mihir") passes with no question.
- **F-12 same name as payee and mentioned (SQ-O-01 sweep).** The user is asked whether that name should be paid. "Yes,
  pay {name}": every occurrence of the text becomes the payee placeholder. "No, they're only mentioned": every occurrence
  becomes `[person]` and the payee span is dropped (if no payee is left, the normal no-payee question follows). A name
  is one contact (D-11), so all occurrences follow the answer.
- **F-13 SSRF.** `64:ff9b::/96` and `2002::/16` are refused entirely.

## Final consistency pass

> **Confirmed by the human (2026-11-06), F-10 trigger:** ask "Who should get {amount} {token}?" when the request names
> several recipients, or when the amount and its recipient are in different sentences. A single recipient in one sentence
> ("10 usdc and 0.01 eth to mihir") passes without a question. The tension noted below is resolved.

All 13 answers were checked against each other, the accepted interim answers and the spec sections they touch. They
form one consistent set; the points below are how the pieces fit, and one reading that the implementer must follow.

- **Combined question, wording rule (F-1 + F-3 + F-4).** The lead sentence is built from one fragment per broken limit
  (per-payment, daily, weekly autopay, duration, transfers), joined like other lists ("A, B and C"). The closing is "Set
  it up anyway?" when any broken limit belongs to a repeating payment, else "Go ahead this once?". One "Yes" lifts all;
  "No" gives `DISCARDED` and "Cancelled. Nothing was sent." Other V-rules (V-01 to V-11) still end the request before the
  question. Fragments live in the catalog (Orchestrator).
- **F-2 + F-5 + SQ-15.** The old group "No" reply is now the general "No" reply; same text, no clash. Test A-15/E9 and
  the group daily-limit example (README line 1945) change: E9 stays `LIMIT_PER_TX`; a group over the daily limit with a
  typed amount gets the new question; with an attached-content amount it gets `LIMIT_DAILY`.
- **F-4 + F-6.** The transfer count is derived from the payment amounts, so it counts as typed exactly when those amounts
  do (F-5 applies: any attached-content amount means `LIMIT_BRIDGES` stays an error).
- **F-7 vs SQ-01, SQ-A-03, uncovered states.** The new text is true for every path that shows it. Internal gap paths keep
  logging their own `rule_id`.
- **F-8 vs SQ-A-01 and SQ-A-03.** `HANDOFF_FAILED` still counts as active (cancel gives `DISCARDED`); `HANDED_OFF`,
  `ANSWERED`, `DISCARDED`, `FAILED`, no request and a wrong `request_id` give the "Cancelled. Nothing was sent." reply,
  except `HANDED_OFF` which gets the F-8 text. Safe to repeat.
- **F-9 vs 5xx/timeout, SQ-A-06.** Attempts 1 and 2 keep the §15 text whatever the cause. The 3rd attempt's cause picks
  one of two texts of the same code `EXECUTION_UNAVAILABLE` (catalogue stays 35 codes).
- **F-10 vs SQ-06/SQB-01, SQB-11.** Same join; no trailing zeros; a positive-only list can be empty only when
  everything is 0, which has its own sentence (see F-10).
- **F-11 vs P2/P3/P4 and SQ-O-03.** A new question replaces the rejection. After the user's choices, P1 to P9 still
  run: each amount used once, each payee paid. A choice set that leaves a payee unpaid is a validation failure, so the
  question is re-asked with a hint (attempts as for other chip questions: first ask plus 3 re-asks, then
  `TOO_MANY_RETRIES`). "10 to A and 20 to B" (amount clause has its own recipient) still follows P4 as written, with no
  question. A-57 passes with no question.
- **F-12 vs F-1 to F-6.** The payee question comes from S5/S6, before any amounts are summed, so it does not interact
  with limit logic. It also does not conflict with SQB-23 (the sweep runs after the answer) or S7's fail-closed offset
  rule (only exact, non-overlapping occurrences are swept; occurrences inside another tagged span are left alone; any
  remaining conflict stops the request).
- **F-13 vs SQ-O-08.** Refusing both ranges entirely makes decoding their embedded IPv4 unnecessary for those two; decoding
  still applies to `::a.b.c.d` IPv4-compatible addresses and IPv4-mapped addresses.
- **One reading to confirm with the human's examples (not blocking).** F-11 says "several recipients" but its second
  example, "send 10 usdc. send 20 usdc to Mihir", has a single recipient. Reading adopted: the question is asked when the
  request has several recipients, or when a payment's amount and recipient are in different sentences (not just
  different clauses). A single recipient with both parts in one sentence passes. If the human meant otherwise, only
  the trigger condition in S8 changes.

No other tension remains.

## Code changes required

Describe only; nothing is implemented. Owners: O Orchestrator-owned contracts/catalog/question codes; A platform; B
S0-S5; C S6-S7; D S8-S12. Do O's rows first; B, C and D depend on them.

### Owner O (contracts, catalog, question codes)

| id | Change | Likely files | Tests affected |
|---|---|---|---|
| SQ-D-16, F-1 to F-6 (new question and note) | Add question code `Q_LIMIT_OVERRIDE` (chips "Yes, this once"/"No"; for repeating payments the "Yes" chip reads "Yes, set it up") and remove `Q_GROUP_OVER_LIMIT`. Catalog: one fragment per limit: "over your per-payment limit of {max}", "over today's limit of {daily_max}" (with "only {remaining} is left"), "over your weekly autopay limit of {max}", "over the {weeks}-week limit for repeating payments", "needs {n} transfers between chains; your limit is {max}". Lead sentence per the examples in F-1, F-3, F-4, closing "Go ahead this once?" or "Set it up anyway?". Replace the AgentRequest flag `daily_limit_override` with `limit_override`. Replace the note "Today's limit was lifted once for this group payment." with "A limit was lifted once for this request." Reply on "No": "Cancelled. Nothing was sent." Request/response schema and the question catalogue count. | `src/contracts/types.ts`, `src/contracts/catalog.ts`, `src/contracts/step.ts`, `src/session/request.ts`, `src/schemas/*` | Question-catalogue and contract tests; C-395 unchanged in code count |
| SQ-O-03, F-11 (new question) | Add `Q_PAIR_AMOUNT` (name is the Orchestrator's choice): one question per affected amount, text e.g. "Who should get {amount} {token}?", `input: "chips"`, one chip per possible recipient (label = the recipient's display name/short address), attempts as other chip questions (`max_attempts` 4, then `TOO_MANY_RETRIES`). | `src/contracts/types.ts`, `src/contracts/catalog.ts`, question tests | Question-catalogue tests |
| SQ-O-01, F-12 (new question) | Add `Q_NAME_ROLE` (name is the Orchestrator's choice): text e.g. "Should I pay {name}?", chips "Yes, pay {name}" / "No, they're only mentioned". Yes: all occurrences become the payee placeholder. No: all occurrences become `[person]`, the payee span is dropped. | `src/contracts/types.ts`, `src/contracts/catalog.ts` | Question-catalogue tests |
| SQ-01, F-7 | `ERROR_MESSAGE.UNSUPPORTED_REQUEST` = "I can send USDC or ETH, bridge funds between chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part." Record direct user bridging as a planned CCIP feature. | `src/contracts/catalog.ts` | `test/unit/contracts/error-messages.test.ts` (C-395, this code); A-18/A-19 text; any test matching the old text; `COMPLIANCE_REPORT.md` row ("34 identical, 1 human-approved difference") |
| SQ-A-06, F-9 | `EXECUTION_UNAVAILABLE` gets two final-attempt variants: timeout "I couldn't confirm your wallet received this after 3 tries. Check your wallet before trying again." and 5xx "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again later." Same code. | `src/contracts/catalog.ts` | C-395 (add variants) |
| SQ-A-01, F-8 | Add the reply text "That was already sent to your wallet for signing, so it can't be cancelled here." (reuse `CANCELLED` code for the other case). | `src/contracts/catalog.ts` | C-395 / catalog tests |
| SQ-08, F-10 | `INSUFFICIENT_FUNDS` `{chains}` slot carries "Base Sepolia (80) and Arbitrum Sepolia (60)"; empty case renders "…and can use 0." | `src/contracts/catalog.ts` | A-30, C-395 sample |
| SQ-O-10 | Silent-reuse note slot carries a list of chain names joined "A and B". | `src/contracts/catalog.ts` | note tests |

### Owner A (platform)

| id | Change | Likely files | Tests affected |
|---|---|---|---|
| SQ-A-01, F-8 | Cancel with nothing active, a wrong `request_id` or an ended request: HTTP 200, state `done`, "Cancelled. Nothing was sent.", nothing changed, repeatable, no `unsupported_state` log. For a `HANDED_OFF` request: the F-8 text, same status, state unchanged. `HANDOFF_FAILED` still cancels (`DISCARDED`). | `src/session/manager.ts`, `src/server/*` | Lane A cancel tests (`cancel:no_active_request` flips); repeat-cancel; a `HANDED_OFF` case |

### Owner B (S0-S5)

| id | Change | Likely files | Tests affected |
|---|---|---|---|
| SQ-O-01, SQB-23, F-12 | After S5 tags spans, sweep further whole-word occurrences of a tagged text to its placeholder (payee placeholder or `[person]`), no new DB3 row, no extra payment. When one text carries both roles, ask `Q_NAME_ROLE` and apply the answer to all occurrences. Offsets stay exact and non-overlapping; occurrences inside another tagged span are left alone; leftover conflict fails closed. | `src/pipeline/s5-*.ts`, `src/quarantine/*`, `src/llm/prompt-builder/` | 2 `it.fails` in `test/audit/prompts.test.ts` become normal; SQB-23 tests flip; new tests for the role question |
| SQ-O-06 | S1 secret scan over every `urls[]` entry and every redirect target before any fetch; a hit gives `SECRET_DETECTED`; nothing fetched or stored. | `src/guard/secrets.ts`, `src/guard/urls.ts`, S1 | `it.fails` in `test/audit/secrets.test.ts` becomes normal; redirect-target case |
| SQ-O-08, F-13 | Refuse `100.64.0.0/10`, `64:ff9b::/96` and `2002::/16` (whole ranges), `::a.b.c.d` IPv4-compatible (decode and check), `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `ff00::/8`, `255.255.255.255`, `fec0::/10`; keep `0.0.0.0/8` and `::`. | `src/guard/urls.ts` | SSRF unit tests, audit O3 tests |
| SQ-08, SQB-11 | S4 relative-amount value 0: use the new `INSUFFICIENT_FUNDS` form ("can use 0."). | `src/pipeline/s4-type.ts` | SQB-11 test |

### Owner C (S6-S7)

| id | Change | Likely files | Tests affected |
|---|---|---|---|
| SQ-O-01, SQB-23 | S7 mention masking must accept swept occurrences: `[person]` replacement stays exact and non-overlapping; `s7_span_mismatch` fail-closed rule is kept. | `src/recipients/*` (S7) | S7 span tests; add swept-occurrence cases |

### Owner D (S8-S12)

| id | Change | Likely files | Tests affected |
|---|---|---|---|
| SQ-O-03, F-11 | Relax P4 (amount's clause has no recipient of its own -> cross-clause pairing allowed). When the request has several recipients, or amount and recipient are in different sentences, ask `Q_PAIR_AMOUNT` for each affected amount (chips = possible recipients); re-run P1-P9 on the user's choices; re-ask with a hint on invalid sets. A single recipient in one sentence passes without a question. P4 as written when the amount's clause has its own recipient. | `src/plan/*`, `src/pipeline/s8-*.ts` | A-57 `it.fails` (`test/acceptance/a55-a60.ts`) becomes normal; new cases: "10 usdc and 20 usdc to mihir and riya", "send 10 usdc. send 20 usdc to Mihir", "10 to A and 20 to B" (no question, swapped pairing rejected); `pairing/checks` tests |
| SQ-D-16, F-1 to F-6 | S10 collects every broken limit (V-12 bridges, V-13/V-14 per-payment, V-15 daily, autopay per-period, autopay duration). If none of the amounts in the request came from attached content: ask `Q_LIMIT_OVERRIDE` once naming all of them; Yes sets `limit_override` for this request (DB5 never written) and S10 passes; No gives `DISCARDED` and "Cancelled. Nothing was sent." If any amount came from attached content: keep the current error for the first broken limit. Relative amounts count as typed; derived amounts follow their source amount. Group payments use the same rule (no special group case). S11 shows the new note when an override applied. | `src/pipeline/s10-validate.ts`, S11 summary, `src/session/request.ts` | V-12 to V-15 and autopay unit tests (typed: question; attached content: error); A-27, A-28, A-32 expect the question; A-15/E9 stay `LIMIT_PER_TX`; group over-limit test (README line 1945) |
| SQ-O-09 | `EXECUTION_REJECTED` text cut to 200 characters, control characters removed. | `src/handoff/execution-client.ts`, `src/pipeline/s12-handoff.ts` | S12 reject tests (300 characters; control characters); SQ-D-09 fallback unchanged |
| SQ-A-06, F-9 | After the 3rd failed hand-off (`FAILED`) choose the final text by the 3rd attempt's cause (timeout or 5xx); attempts 1 and 2 keep the §15 text. | `src/pipeline/s12-handoff.ts`, `src/session/manager.ts` | S12 retry tests (both causes) |
| SQ-08, F-10 | `INSUFFICIENT_FUNDS` lists only chains with positive spendable of that token, configured order, unreadable chains left out; no trailing zeros. | `src/pipeline/s9-plan.ts`/`s10-validate.ts` balance check | A-30 asserts the exact text |
| SQ-O-10 | Silent-reuse note names all chains whose DB2 rows for the contact hold the reused address, joined "A and B"; S9 keeps the single `reused_from_chain_id`; S11 derives the list from DB2. | `src/pipeline/s9-plan.ts` (marker), S11 note builder | A-26 asserts the exact two-chain note |

### No code change

SQ-O-05, SQ-O-02, SQ-D-15, SQ-18, SQ-11, SQ-03, SQ-C-09 (and every item-17 id). SQ-15's "No" reply is now the general limit-question "No" (covered above); the `Q_ENS_CHANGED` "Cancel" reply is unchanged.
