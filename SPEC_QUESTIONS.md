# SPEC_QUESTIONS

Format: **SQ-nn** · section · question · what the code does now · status.
Status: `ANSWERED (spec §x)` = settled by the Orchestrator from the spec text; `ANSWERED (human, 2026-11-06)` = answered by
the human (see the section below).
No entry is open any more.

## Answered by the human (2026-11-06)

The human's answers (given in chat) are binding. README.md (the spec) is not edited; where an answer differs from
the spec text, the difference is human-approved and recorded here. Follow-up questions raised by the consistency check were answered the same day (F-1 to F-13 in
`SPEC_ANSWERS_FOLLOWUP.md`) and are folded into the answers below. Code changes are listed in that file under
"Code changes required". Lanes: A platform, B S0–S5, C S6–S7, D S8–S12, O Orchestrator contracts.

### Answered with a decision

- **SQ-O-01** and **SQB-23** (masking repeated names): option (b). Every further occurrence of a tagged span's text in
  the masked text is replaced by that span's placeholder (payee: its `address_…`/`group_…` placeholder; mentioned:
  `[person]`). No new DB3 row, no extra payment. (code change needed: lane B, lane C; audit `it.fails` tests become
  normal). Refined: a name labelled both payee and mentioned is not swept; the user is asked "Yes, pay {name}" / "No, they're only mentioned" (new question), and all occurrences follow the answer (a name is one contact, D-11).
- **SQ-O-06** (secret scan of URLs): run the S1 secret scan over every `urls[]` entry and every redirect target before
  fetching. A hit gives `SECRET_DETECTED`; nothing is fetched or stored. (code change needed: lane B)
- **SQ-O-08** (extends **SQB-12**): the fetcher also refuses `100.64.0.0/10`, `64:ff9b::/96` and `2002::/16`
  (decoding the embedded IPv4), `::7f00:1`-style IPv4-compatible addresses, `192.0.0.0/24`, `198.18.0.0/15`, multicast
  (`224.0.0.0/4`, `ff00::/8`), `255.255.255.255` and `fec0::/10`. It keeps refusing `0.0.0.0/8` and `::`; SQB-12 is
  confirmed. Refined: `64:ff9b::/96` and `2002::/16` are refused entirely. (code change needed: lane B)
- **SQ-O-09**: the `EXECUTION_REJECTED` text shows the execution layer's message cut to at most 200 characters, with
  control characters removed. (code change needed: lane D)
- **SQ-O-02** and **SQ-D-15**: the §10.6 rule wins over worked example E6: `expires_at` is 23:59:59 on the last
  occurrence's date. (no code change)
- **SQ-O-03** (A-57 vs P4): relax P4. A payment whose amount and recipient are in different clauses passes P4 when the
  amount's clause contains no recipient placeholder of its own ("send 10 usdc and 0.01 eth to mihir" gives two payments
  to Mihir). When the amount's clause has its own recipient ("10 to A and 20 to B"), P4 applies as written.
  (code change needed: lane D, lane O; A-57 `it.fails` becomes normal). Refined: cross-clause pairings are allowed more widely, but when the request has several recipients and a payment's amount and recipient are in different clauses, the user is asked who gets which amount (new question; "10 usdc and 20 usdc to mihir and riya", "send 10 usdc. send 20 usdc to Mihir"). A single-recipient case in one sentence ("10 usdc and 0.01 eth to mihir") passes without a question.
- **SQ-O-05**: "send 10 usdc to me" gives `Q_NO_PAYEE`, the current behaviour; A-44's "me" variant keeps that
  expectation. Human-approved difference from the A-44 row of README §20.2. (no code change)
- **SQ-08**: `INSUFFICIENT_FUNDS` lists each chain's spendable amount: "You don't have enough USDC: you need 150, and can
  use 140 across Base Sepolia (80) and Arbitrum Sepolia (60)." (code change needed: lane O catalog, lane D, lane B for
  the relative-amount case). Refined: the list holds only chains with a positive spendable amount of that token, in configured chain order; unreadable chains are left out.
- **SQ-A-06**: after the 3rd failed hand-off (request `FAILED`) the reply is "I couldn't reach your wallet after 3
  tries. Nothing was sent. Please try again later." Failures 1 and 2 keep the §15 `EXECUTION_UNAVAILABLE` text.
  (code change needed: lane D, lane O catalog). Refined: if the 3rd attempt failed on a timeout, the reply is "I couldn't confirm your wallet received this after 3 tries. Check your wallet before trying again."; on a 5xx it is the text above.
- **SQ-01** (`UNSUPPORTED_REQUEST` text): the reply becomes "I can send USDC or ETH, bridge funds between chains, set up
  or stop repeating payments, and show balances. I can't help with that part." It is used everywhere
  `UNSUPPORTED_REQUEST` is shown; no short reason is generated. Human-approved difference from §8.5 rule 1 and §15. A
  direct user request to bridge ("move my USDC from Base to Arbitrum") stays unsupported for now. **Planned feature:
  direct user bridging, to be integrated via CCIP**; until then such a request gets this reply. (code change needed:
  lane O catalog; the C-395 error-message test and the compliance row). Refined (final text): "I can send USDC or ETH, bridge funds between chains when a payment needs it, set up or stop repeating payments, and show balances. I can't help with that part."
- **SQ-18**: "stop" while a summary waits for confirmation gives the cancel reply "Cancelled. Nothing was sent.", the
  current behaviour. (no code change)
- **SQ-15**: `Q_ENS_CHANGED` "Cancel" and `Q_GROUP_OVER_LIMIT` "No" give "Cancelled. Nothing was sent.", the current
  behaviour. (no code change) `Q_GROUP_OVER_LIMIT` is merged into the general one-time limit question (SQ-D-16); its "No" is that question's "No", same reply.
- **SQ-D-16** (plus new behaviour: one-time limit overrides): when a request breaks any DB5 limit (V-13, V-14
  `amount_per_payment`, V-15, autopay per-period, autopay duration; "all limits"), the agent asks a one-time "go ahead
  this once?" question (Yes / No) instead of ending with the limit error. Example: "This is 120 USDC, over your
  per-payment limit of 100. Go ahead this once?" Yes overrides for this request only; DB5 is never changed. No gives
  `DISCARDED` and "Cancelled. Nothing was sent." The question is asked only when the amounts involved were typed by the
  user; if any amount involved came from attached content (untrusted), the limit error stands, so the E9 invoice still
  ends with `LIMIT_PER_TX` under the default limits. Human-approved difference from §11.3 ("the only question S10 can
  ask is `Q_GROUP_OVER_LIMIT`"). Consistent with §1.3 ("DB5 can only be changed from settings, never from chat") because
  DB5 stays unchanged, as with the existing group override. (code change needed: lane D, lane O catalog and question
  codes). Refined: (1) one question names every broken limit ("This is 150 USDC, over your per-payment limit of 100 and today's limit of 300. Go ahead this once?"); (2) `Q_GROUP_OVER_LIMIT` and its note are generalized into this question and a general note; a group payment with attached-content amounts now ends with the limit error; (3) repeating payments use "This repeating payment is over your weekly autopay limit of 100. Set it up anyway?" (same for the duration limit); (4) `LIMIT_BRIDGES` asks too ("This needs 4 transfers between chains; your limit is 3. Go ahead this once?"); (5) any amount from attached content in the request means no question, the limit error stands; (6) relative amounts count as typed, calculated amounts (bridge padding, autopay caps) count as the amount they come from.
- **SQ-A-01**: the cancel endpoint with nothing active (or an already-ended request) replies "Cancelled. Nothing was
  sent." (HTTP 200, state done), changes nothing, and is safe to repeat. (code change needed: lane A)
  Refined: if the request was already handed off, the reply is "That was already sent to your wallet for signing, so it can't be cancelled here." (state unchanged); every other no-active-request cancel keeps "Cancelled. Nothing was sent."
- **SQ-11**: Node 25 is accepted. Closed. (no code change)

- **SQ-O-10** (new; §9.5 / §13.1 silent-reuse note; first seen in A-26): when a contact's address is reused on a chain
  with no DB2 row and it is saved on several other chains, the note names all of them, joined as other lists are:
  "Same address as on Base Sepolia and Arbitrum Sepolia." The chains are derived from the DB2 rows at summary time;
  DB3 `reused_from_chain_id` and the internal plan schema stay single-valued. Human-approved refinement of the §13.1
  note. (code change needed: lane D)

### Answered by the default rule (item 17: accepted as currently implemented)

Each "Now" / interim behaviour in the entry below becomes the answer. (no code change) for all of them, except where
noted by the decisions above.

- **SQ-03** and **SQ-C-09** (UI fields): the human did not choose, so item 17 applies: keep the `prefill` field name;
  the UI pre-ticks every enabled chip of `Q_GROUP_MEMBERS`.
- **SQ-04, SQ-05, SQ-06** (also settles **SQB-01**), **SQ-07, SQ-09, SQ-22** (also settles **SQB-02**).
- **SQ-A-02, SQ-A-03, SQ-A-04, SQ-A-05, SQ-A-07, SQ-A-08**.
- **SQB-03, SQB-06, SQB-07, SQB-08, SQB-14, SQB-17, SQB-24, SQB-25, SQB-26, SQB-27**.
- **SQ-C-01, SQ-C-02, SQ-C-03, SQ-C-10, SQ-C-11**.
- **SQ-D-01 to SQ-D-14, SQ-D-17, SQ-D-18**.
- **SQ-O-07**.

Totals: 65 ids answered (including SQ-O-10), all fully answered; no follow-up is open.

## Previously open — now answered (original entries)

**SQ-01** · §8.5 rule 1 vs §15 `UNSUPPORTED_REQUEST`
§8.5 says the reply is "I can send USDC or ETH, set up or stop repeating payments, and show balances. I can't do: <short reason>". §15 says "… I can't help with that part." By §0 precedence §8 wins, but nothing produces a `<short reason>` (the LLM #2 schema has no reason field and code has no list of reasons).
*Now:* §15 wording everywhere (`ERROR_MESSAGE.UNSUPPORTED_REQUEST`).
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-03** · §9.2 step 5 / §13.4 `Q_NAME_FOR_ADDRESS` "text, prefilled"
The §13.4 question JSON has no field for a prefilled value.
*Now:* contracts add optional `prefill` to `Question` (omitted when none). The UI team must read it.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-04** · §9.2 steps 1, 2, 6 and §8.4 step 3 — re-ask wording
The spec quotes hint sentences for invalid answers ("That address has a typo: its checksum doesn't match.", "That's not a usable address.", "That name is already saved…", and "amount must be more than 0") but not how they combine with the question.
*Now:* re-ask text = hint + one space + original question text (`withHint`), hint text verbatim (including the lower-case "amount must be more than 0").
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-05** · §9.6 step 9 `Q_GROUP_MEMBERS` total
"The question text shows the count and the total (amount × selected) when the amount is known", but §13.4 text has no slot for the total.
*Now:* text without the total.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-06** · §9.2 step 5 / §9.3 step 7 `Q_ADDRESS_CORRECT`
(a) "the full address and its first and last 4 hex characters emphasised": the API is plain text — no emphasis format is defined. (b) ENS wording "riya.eth → 0x3fA9…c21E on Base Sepolia. Correct?" names one chain; when the record matched several chains, how are they listed?
*Now:* (a) plain full address, no emphasis markup; (b) chain names joined with ", " and a final " and ".
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-07** · §9.6 step 7 duplicate-address note
"Duplicate addresses → keep the alphabetically first subname, note the others" — no note wording given (`Skipped {name}: …`).
*Now:* the duplicate is excluded as specified, but no note is added until the wording is given.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-08** · §10.4 vs §15 `INSUFFICIENT_FUNDS`
§10.4: "message lists per chain: spendable vs needed, for the token". §15 template: "You don't have enough {token}: you need {need}, and can use {have} across {chains}." A-30 expects "per-chain numbers".
*Now:* §15 template; `{have}`/`{chains}` filled with totals and chain names.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-09** · §13.4 mixed inputs
`Q_WHO_IS` = chips + free input (address or ENS); `Q_AMOUNT_MISSING` = number (+ token chips if unknown); `Q_FIAT_OTHER` = number + token chips. The question JSON has one `input` value, and §13.4 answer parsing says free text to a chips question is invalid unless it equals a chip label.
*Now:* `Q_WHO_IS` uses `input: "chips"`; free text that is not a chip label is processed by §9.1 step 4 (address → §9.2, ENS → §9.3, else re-ask) — §9.1 is the more specific rule. `Q_AMOUNT_MISSING` / `Q_FIAT_OTHER` use `input: "number"`; when the token is unknown the token is asked afterwards with `Q_TOKEN`.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-11** · §5 Node.js version
Spec: Node.js 22 LTS. This machine has Node 23.11.1. `package.json` declares `engines.node >= 22`.
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-15** · §9.4 `Q_ENS_CHANGED` "Cancel" and §11.3 `Q_GROUP_OVER_LIMIT` "No" → `DISCARDED`
No reply text is given for these discards.
*Now:* reply `Cancelled. Nothing was sent.` (§13.3 "User cancelled").
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

**SQ-18** · §17.3 "stop" while awaiting confirmation
"stop" is in both the cancel list (→ `DISCARDED`, reply `CANCELLED`) and the confirmation "no" list (→ `DISCARDED`, reply "OK, I've dropped that…"). Same state, different reply.
*Now:* the cancel row (listed first) wins: reply `Cancelled. Nothing was sent.`
*Status:* ANSWERED (human, 2026-11-06). See the section "Answered by the human".

## Answered from the spec

**SQ-02** · §8.14 step 2 `HANDOFF_INVALID` is not in the §15 catalogue.
*Answer:* §8.14 calls it an "internal error … (bug; request `FAILED`)"; §11.1 defines internal errors as `INTERNAL_ERROR` with the rule ID logged. → user gets `INTERNAL_ERROR`; log `rule_id: "HANDOFF_INVALID"`. ANSWERED (spec §8.14, §11.1).

**SQ-10** · §18 log rotation (10 MB × 5) needs a rotation mechanism; no rotation package is in §5.
*Answer:* behaviour is fully specified; Lane A implements size-based rotation in `src/util/` with `node:fs` (no extra dependency). ANSWERED (spec §5, §18).

**SQ-12** · Broken cross-references: "§17.4" (session clearing) and "§11.3 kinds" in §8.14 step 4.
*Answer:* session clearing is §7.4 (+ §17.1); DB6 kinds at hand-off are §11.4. ANSWERED.

**SQ-13** · §21 shows `src/llm/prompt-builder.ts` (one file); the lane map splits builders across lanes.
*Answer:* `src/llm/prompt-builder/` directory with one file per call (`amounts`, `requestType`, `spans`, `quarantine` — Lane B; `payments` — Lane D) and an `index.ts` re-export. Same function set as §8.10 ("one function per LLM call"). ANSWERED (layout only; behaviour unchanged).

**SQ-14** · `ts-json-schema-generator` is not in §5.
*Answer:* §12.3 names it as the generator for `internal-plan.schema.json`; dev dependency only, not used at runtime. ANSWERED (spec §12.3).

**SQ-16** · §10.4 gas check "raw ETH balance minus pending ETH": which pending rows?
*Answer:* "pending" as defined in §10.1 (status `pending`, last 10 minutes, kinds `payment`/`bridge_out`/`autopay_prefund`, ETH, that chain); the gas reserve itself is the threshold, not subtracted. ANSWERED (spec §10.1, §10.4).

**SQ-17** · V-15 counts "`j` buffers (`padded − deliverable`)"; §10.4 defines the buffer as `padded − x`.
*Answer:* `deliverable` in V-15 / `PlanJ.deliverable_base_units` is `x` (the amount the bridge must deliver). E2: padded 20.4, x 20 → buffer 0.4 = the "50.4 counted" in E2. ANSWERED (spec §10.4, §11.3, E2).

**SQ-19** · §0 "log the internal state code" for uncovered states — no such log field.
*Answer:* log `event: "unsupported_state"` with `state` = the RequestState and `rule_id` = the step/branch identifier; both are allowlisted (§18). ANSWERED.

**SQ-20** · A-10 "with the standard balances" — §19 gives no single standard USDC balance set.
*Answer:* test-fixture choice, not behaviour: acceptance tests use the E1 balances (Base 80, Arbitrum 60, Sepolia 0 USDC; ETH 0.1 each) unless the row says otherwise. ANSWERED (Orchestrator, test data).

**SQ-21** · §8.10 LLM #4 prompt text: the AMOUNTS / RECIPIENTS / DOCUMENT ITEMS / SESSION / `{correction_line}` lines carry trailing `// …` remarks.
*Answer:* those remarks describe slot contents ("only on the retry", example JSON shapes); §8.10 says prompts are "fixed text with `{…}` slots filled by code; nothing else is ever added". → `payments.txt` holds the text without the `// …` remarks; `{correction_line}` = `CORRECTION: <problems>` on the retry only and the line is omitted on the first call. ANSWERED (spec §8.10).

**SQ-22** · §8.2 steps 4–5, §15 `DOCUMENT_TOO_LARGE`, §13.1 note "Couldn't read anything usable from {item}" — the `{item}` slot has no wording (raised by Lane B as SQB-02; CCR B-1).
*Now (contracts-v3 `ITEM_LABEL`):* attachment → its filename; link → `link N` (as in `[link N]` / `URL_FETCH_FAILED`); pasted block → `pasted text N`.
*Status:* ANSWERED (human, 2026-11-06): accepted as implemented (see the section "Answered by the human").


## Lane questions — Orchestrator triage (2026-11-06)

Lane files: `spec-questions/A.md` (lane/a-platform), `spec-questions/B.md` (lane/b-understanding),
`spec-questions/C.md` (lane/c-recipients). Each lane's "Now" behaviour stays binding until answered.

### Settled from the spec (the lane's "Now" is confirmed)

- **SQB-01** → same as SQ-06 interim join ("A", "A and B", "A, B and C").
- **SQB-02** → SQ-22 (open, human).
- **SQB-04** → §8.3 rule 1 splits sentences into clauses; a `.`/`,` inside a number, address, ENS name or link is not
  a sentence separator (rules 2, 3, 10 need those tokens intact). Confirmed.
- **SQB-05, SQB-09, SQB-10, SQB-11, SQB-13, SQB-16, SQB-18, SQB-21, SQB-22** → readings consistent with the cited
  sections; confirmed.
- **SQB-15** → §8.5 rule 3: S11 (Lane D) puts `buildBalanceAnswer(ctx)` first in the summary response when
  `req.also_balance` is set. Lane D task.
- **SQB-19** → contracts-v3 (`AgentRequest.mentioned_spans`).
- **SQB-20** → §10.3 step 2 / §10.1 apply to a relative amount's chain too: `CHAIN_NOT_ALLOWED` / `BALANCES_UNAVAILABLE`.
- **SQ-C-05** → §9.2 step 5: the re-entered address is typed by the user, so it is `source='user'` with no content
  wording. Confirmed.
- **SQ-C-06** → §9.2 steps 1–2 "re-ask": the first ask is `Q_ADDRESS_REENTER` at attempt 1 with the hint. Confirmed
  (hint format follows SQ-04).
- **SQ-C-07** → "exactly one chain word" means one distinct chain. Confirmed.
- **SQ-C-08** → §17.2 step 4 needs the previous chain. Ruling: each `db8_history.payments_json` item is the S8
  payment (placeholders only) plus `chain_id` = the chain S9 assigned to it (Lane D writes it; Lane C's S7 reads a
  numeric `chain_id` first). Still placeholders + chain ids only (§16.2).

- **SQ-C-04** → unreachable: §8.1 step 5 stops the request when every allowed chain is unavailable and §14.1 rejects an
  empty `allowed_chain_ids`. The branch stays as a guard.

### Previously open — now answered by the human (2026-11-06)

- ANSWERED (human, 2026-11-06) · **SQ-A-01** `/cancel` with no active request → now 200 + `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQ-A-02** settings validation details (precision, `eth_gas_reserve` keys, duplicates, string pct, unknown keys) → now strict.
- ANSWERED (human, 2026-11-06) · **SQ-A-03** `messages` while `HANDOFF_FAILED` → now cancel words cancel; other text → `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQB-03** which "chain-like words" raise `UNSUPPORTED_CHAIN` → now only `polygon`, `solana`.
- ANSWERED (human, 2026-11-06) · **SQB-06** LLM #1 `number` not matching `^\d+(\.\d+)?$` → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQB-07** inflected cancel words ("cancelled", "stopping") → now counted.
- ANSWERED (human, 2026-11-06) · **SQB-08** unreadable PDF → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQB-12** also refuse `0.0.0.0/8` and `::` in the SSRF check → now refused.
- ANSWERED (human, 2026-11-06) · **SQB-14** model returned only `l` with no cancel word → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQB-17** a `QItem` with both address and ENS name → now the address is used.
- ANSWERED (human, 2026-11-06) · **SQ-C-01** ENS RPC failure for a payee → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQ-C-02** re-check returns two different new addresses → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQ-C-03** "Use new address" when it is saved under another name → now `UNSUPPORTED_REQUEST`.
- ANSWERED (human, 2026-11-06) · **SQ-C-09** `Q_GROUP_MEMBERS` preselection has no chip flag → now "all enabled chips are preselected" (UI rule).
- ANSWERED (human, 2026-11-06) · **SQ-C-10** §9 flowchart vs §9.4: which resolved contacts get the ENS re-check? → now a `Q_WHO_IS` contact chip does; an address already in DB2 does not.
- ANSWERED (human, 2026-11-06) · **SQ-C-11** viem returns null on `HttpError`/`ResolverError` reverts, so a gateway failure reads as "no address" → now the user is asked (no wrong address can result).
- ANSWERED (human, 2026-11-06) · **SQ-O-01** (raised by the Orchestrator from Lane C's report) §8.8 / §16.1 / §16.2 / §7.3 rule 5: §8.8 masks spans only, but §16.1 says LLM #4 sees recipients masked. If S5 tags one occurrence of a name and the same name appears again untagged, the name reaches LLM #4. Tagging every occurrence as a payee would mint extra placeholders that P3 then requires to be paid. → now spans only. Options: (a) keep; (b) replace further occurrences of a tagged text by that span's placeholder, with no new DB3 row; (c) replace them by `[person]`.
- ANSWERED (human, 2026-11-06) · **SQ-A-04** how an `intent_result` finds the DB7 row → now by `autopay.autopay_id`; a failed `l` leaves the row unchanged; a `k` report with no `autopay` updates DB6 only.
- ANSWERED (human, 2026-11-06) · **SQ-A-05** closing a leftover session id while another session is open → now 404, clears nothing.
- ANSWERED (human, 2026-11-06) · **SQ-A-06** after the third failed hand-off the request is `FAILED`, but the only text says "Confirm again to retry" and confirm returns 409 → now the §15 text unchanged. Wording needed.
- ANSWERED (human, 2026-11-06) · **SQ-A-07** an existing token file not at mode 0600 → now refused at startup, including 0400.
- ANSWERED (human, 2026-11-06) · **SQ-A-08** base64 attachments → now strict RFC 4648, no whitespace; non-zero trailing bits accepted.
- ANSWERED (human, 2026-11-06) · **SQ-D-15 / SQ-O-02** §10.6 rule 8 vs §19 E6 `expires_at`: rule 8 gives 23:59:59 on the last occurrence's date (E6: Fri 2026-12-25 → `2026-12-25T18:29:59Z`); E6 prints `2026-12-31T18:29:59Z` (the `on_date`). → now §10.6 rule 8.
- ANSWERED (human, 2026-11-06) · **SQ-D-16** §19 E9's 120 USDC is over the default `per_tx_max` 100 (§6.3), so E9 as written ends in `LIMIT_PER_TX`. → now V-13 applies; A-15 raises the limit in its setup.
- ANSWERED (human, 2026-11-06) · **SQ-O-03** §8.9 P4 vs §20.2 A-57 ("10 usdc and 0.01 eth to mihir"): the clause split at "and" puts the 10 USDC in a different clause from Mihir, whose clause holds the 0.01 ETH amount, so P4 rejects the pairing; A-57 expects two `i` intents. By §0 precedence §8 wins. → now P4 as written.
- ANSWERED (human, 2026-11-06) · Lane questions added since the last batch (interim behaviour applies; full text in each lane's `spec-questions/` file, merged into `agentic_layer`): SQB-23…27 (B), SQ-D-01…18 (D).
- ANSWERED (human, 2026-11-06) · **SQ-O-05** §8.6 rule 2 vs §20.2 A-44 ("send 10 usdc to me"): rule 2 drops "me" as a span, so the request reaches `Q_NO_PAYEE`; A-44 expects `SELF_PAYMENT`. By §0 precedence §8 wins. → now `Q_NO_PAYEE` (A-44's own-address variant does give `SELF_PAYMENT`).
- ANSWERED (spec §0) · **SQ-O-04** (raised by the Acceptance Tester) → answered by §0: "All examples use … illustrative (non-checksummed) addresses." Tests use `getAddress()` of the examples; the code checksums (§7, §12.5).
- ANSWERED (human, 2026-11-06) · **SQ-O-06** (audit V1) §8.2 step 2 scans typed text, pasted blocks and attachments, but not `urls[]` entries. A raw key put in a `urls[]` query string (`https://host/?k=<64 hex>`) is sent out in the fetch; the same URL typed in the text is blocked. → now the spec's literal list (not scanned). Recommended: also scan `urls[]` and redirect targets before step 3.
- ANSWERED (human, 2026-11-06) · **SQ-O-01 update** (audit V2): confirmed with tests: "Send 50 usdc to Aradhya. Aradhya is my flatmate…" leaves two "Aradhya" in the LLM #4 prompt; a repeated mentioned name likewise. Recommended: option (b).
- ANSWERED (human, 2026-11-06) · **SQ-O-07** (audit O2) §16.4 "DB2 is written only by `add_contact`" vs §9.4 "Use new address (update the address on all of this name's DB2 rows)". → now §9.4's update runs. Spec wording question only.
- ANSWERED (human, 2026-11-06) · **SQ-O-08** (audit O3) SSRF: besides the §8.2 ranges, should the fetcher refuse `100.64.0.0/10`, `64:ff9b::/96`, `2002::/16` (these two can wrap 127.0.0.1), `192.0.0.0/24`, `198.18.0.0/15`, multicast and `fec0::/10`? → now only the spec's ranges (plus `0.0.0.0/8`, `::`, SQB-12).
- ANSWERED (human, 2026-11-06) · **SQ-O-09** (audit O5) the `EXECUTION_REJECTED` reply passes the execution layer's 4xx `message` unchanged (§8.14 step 5), with no length cap. → now unchanged. Option: cap at e.g. 200 characters and strip control characters.

## Review swarm (2026-11-06): human answers and accepted gaps

Six Opus reviewers checked `d5389df`. Findings are in
`/private/tmp/…/scratchpad/review1…6/findings.md` (session scratchpad). Human answers given in chat on 2026-11-06:

- **SQ-R-01, name variants** (Reviewer 6 F1): sweep only **exact** repeats of a tagged name (case-insensitive, whole
  word). "Mihirs", "Mihir2", and a part of a multi-word name ("Riya" after "Riya Shah") are **not** swept. No code change.
- **SQ-R-02, distributive scope** (Reviewer 4 G2): a distributive word ("each", …) relaxes P2, P4 and the
  `Q_PAIR_AMOUNT` trigger **only for amounts in its own clause**. Other amounts are checked normally. Lane D change.
- **SQ-R-03, short autopays** (Reviewer 4 G3): `per_period_cap` = min(amount × most payments in any 7-day window,
  `total_cap`). "20 usdc daily for 2 payments" → 40. Lane D change.
- **SQ-R-04, duplicate execution reports** (Reviewer 5 gap): an `autopay_payment` report whose `tx_hash` is already in
  DB6 is accepted (204) but inserts nothing, so it never counts twice. Lane A change.
- **SQ-R-05, late confirmation of an autopay** (Reviewer 5 gap): at confirm, if a `k`'s `first_occurrence` is no
  longer after now, the agent asks `Q_AUTOPAY_START` ("When should this start?"), re-plans from S9 and shows a new
  summary for a fresh confirmation; nothing is handed off with a past first occurrence. Lane A + D change.
- **SQ-R-06, cancel after a timed-out hand-off** (Reviewer 1 gap): cancelling a `HANDOFF_FAILED` request whose last
  failure was a timeout replies "Cancelled here, but your wallet may already have received it. Check your wallet."
  (state `DISCARDED`). Cancel after a 5xx failure keeps "Cancelled. Nothing was sent.". Orchestrator catalog + Lane A.

Accepted as currently implemented (the human may revisit any of these):
"polygon" after on/via → `UNSUPPORTED_CHAIN`, elsewhere `MAINNET_NOT_SUPPORTED`; a person named like a ticker ("pay sol
5 usdc") → `UNSUPPORTED_TOKEN`; token rule (d) counts token-word occurrences; balance answer before "I dropped the
previous plan…"; after F-12 "No", rules 7–8 run before `Q_NO_PAYEE`; the 10-minute pending window measured at S9/S10;
the group summary line has no " After step n."; an `l`-only request's `request_id` is not recorded (reports match by
`autopay_id`); the subgraph `skip` cap (> 6000 subnames → `ENS_INDEXER_UNAVAILABLE`); `Q_ADDRESS_REENTER` for an
untrusted payee has no "Don't pay this one" chip; `INSUFFICIENT_FUNDS` `{need}` now includes the bridge fee (fix below).

## Prompt changes approved by the human (2026-11-06)

**SQ-L-01** (from the live-model evaluation): the human approved changing the §8.10 prompt texts, and normalising
LLM output in code where the model's answer is reasonable but fails a strict schema rule (e.g. `actions: ["i","i"]` →
deduplicated). Conditions: every change is re-tested on the full live set (`test/live`, 154 prompts); it is kept only if
the wrong-hand-off count stays 0 and the number of unnecessary stops falls; every changed prompt is recorded as a
human-approved difference from §8.10 (the compliance check reports it as such). `README.md` stays unchanged.

## Codex review remediation (2026-11-06)

The human requested fixing every finding and gap in `codex_review_report.md` and completing `HANDOFF_PROMPT.md`.
The following are implementation decisions made under that request, rather than quotations of the original spec:

- **B03/B04/B19/G02:** add an encrypted, persistent submission journal and commit the confirmed envelope plus DB6/DB7
  reservations before submitting it. Reports must match the actual request, step, intent kind and autopay ID. This
  supersedes the earlier accepted gap for an unrecorded `l`-only request. Timeouts/5xx keep reservations; definite
  rejections mark them failed. Execution cannot be undone by an older report, and terminal autopays cannot be revived.
  Session history held temporarily by the journal is erased on session clear.
- **G03:** refresh balances and settings before the first submission. Changed settings require replanning and a new
  confirmation; newly broken limits require consent. Revalidate current funding and spend accounting before sending.
- **B19 retry identity / SQ-R-05 boundary:** late-start replanning applies before the first external submission.
  After an ambiguous submission, a retry uses the original envelope and idempotency key, even if its scheduled start
  has since passed. Replacing an already-submitted payload under the same key could create an inconsistent or duplicate
  autopay. The user can cancel locally with the existing uncertainty warning and check the wallet.
- **G01:** independently enforce explicit chain binding to payment clauses, including a global leading/trailing chain.
  A model omission or swap triggers the existing correction retry and then `PAIRING_FAILED` if still wrong.

**SQ-CX-01 — interim copy: ANSWERED (human, 2026-11-06).** The human selected “Keep these texts” in response to the
`HANDOFF_PROMPT.md` §5.4 wording check. Approved exactly: “That would leave {name} with nothing.”;
“Yes, this once” / “Yes, set it up” / “No”; and “today's limit of {daily_max} (only {remaining} is left)”.
These texts no longer await approval. This does not authorize pushing or deleting branches, worktrees or process files.

## Failed-payment corrections (2026-11-06)

**SQ-S-01 — requested by the human in chat.** After an insufficient-funds rejection of “send 100 USDC on Arbitrum
to abhivansh sir”, “ok no worries, send 70” in the same session should retain the recipient, token and chain.
This extends §17.2 beyond handed-off history. The implementation uses the immediately preceding failed request's
resolved details in memory; failed requests are still never appended to `db8_history`.

Implementation scope under this request: one resolved, trusted, absolute-amount, one-time payment that failed with
`INSUFFICIENT_FUNDS` before any hand-off attempt or submission. A correction is an optional acknowledgement followed
by `send`, `pay` or `transfer` and one new code-parseable amount, optionally a token, `on`/`via` a configured chain,
or `instead`/`please`/`then`. Explicit token and chain choices take precedence. New payee text, multiple payments,
recurrence, relative amounts and attached/URL content do not use this implicit fallback. An intervening request,
cancellation or session close clears it. Repeated insufficient-funds corrections may retain the most recent details.
Every correction has a fresh request ID and amount placeholder, runs balances, pairing, planning and validation again,
and requires a fresh summary confirmation. Its summary notes “Continuing your previous request with a new amount.”

**SQ-S-02 — follow-up correction from the human in chat.** The human reproduced: “Pay 200 dollars to Riya” →
`INSUFFICIENT_FUNDS`, then “okay, send 50 instead. I want to send her some funds for the medicine she bought me” →
`Q_TOKEN` and `Q_NO_PAYEE`. The added explanation must not break the reference to Riya or the earlier USDC token.

The eligible failed payment is now also the nearest context for S2 back-reference words under §17.2, independent
of the prose accompanying them. S3 uses its token only as a fallback; explicit current tokens retain precedence.
S5 reuses its recipient only for one fresh, confirmed, absolute user amount in a one-time payment, with no explicit
payee and no other mentioned person. An explicit new payee goes through ordinary resolution without the prior
recipient's chain or correction note; a mentioned-person ambiguity asks `Q_NO_PAYEE`. Missing amounts still ask
`Q_AMOUNT_MISSING`; the previous amount is never copied. Repeating/cancel/group/split requests, conflicting tokens
and messages with attachments, pasted content or URLs do not receive this implicit failed-payment reference.
The prior eligibility, session lifetime, submission safety and fresh-confirmation requirements remain in force.

## Recipient-question wording (2026-11-06)

**SQ-UI-01 — requested by the human in chat.** When the agent asks about a person, it should explicitly say that
it needs an address. `Q_WHO_IS` now asks “What is the wallet address for \"{name}\"? You can also enter an ENS name.”
`Q_NO_PAYEE` says “Who should receive this? Enter their wallet address, ENS name or saved contact name.” The
invalid-ENS variant says “That isn't a valid ENS name. Paste the recipient's wallet address or a valid ENS name.”
These wording changes override the corresponding §9 / §13.4 texts; accepted inputs, saved-contact chips, validation
and confirmation requirements are unchanged. `README.md` remains unchanged.
