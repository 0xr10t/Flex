# SPEC_QUESTIONS

Format: **SQ-nn** · section · question · what the code does now · status.
Status: `ANSWERED (spec §x)` = settled by the Orchestrator from the spec text; `OPEN (human)` = needs the human;
until answered, the affected code path follows the stated interim behaviour (or returns `UNSUPPORTED_REQUEST` where marked).

## Open — need the human

**SQ-01** · §8.5 rule 1 vs §15 `UNSUPPORTED_REQUEST`
§8.5 says the reply is "I can send USDC or ETH, set up or stop repeating payments, and show balances. I can't do: <short reason>". §15 says "… I can't help with that part." By §0 precedence §8 wins, but nothing produces a `<short reason>` (the LLM #2 schema has no reason field and code has no list of reasons).
*Now:* §15 wording everywhere (`ERROR_MESSAGE.UNSUPPORTED_REQUEST`).
*Status:* OPEN (human). Options: (a) use §15 wording always; (b) code-generated reason from a fixed list (which?).

**SQ-03** · §9.2 step 5 / §13.4 `Q_NAME_FOR_ADDRESS` "text, prefilled"
The §13.4 question JSON has no field for a prefilled value.
*Now:* contracts add optional `prefill` to `Question` (omitted when none). The UI team must read it.
*Status:* OPEN (human) — confirm the field name `prefill`.

**SQ-04** · §9.2 steps 1, 2, 6 and §8.4 step 3 — re-ask wording
The spec quotes hint sentences for invalid answers ("That address has a typo: its checksum doesn't match.", "That's not a usable address.", "That name is already saved…", and "amount must be more than 0") but not how they combine with the question.
*Now:* re-ask text = hint + one space + original question text (`withHint`), hint text verbatim (including the lower-case "amount must be more than 0").
*Status:* OPEN (human).

**SQ-05** · §9.6 step 9 `Q_GROUP_MEMBERS` total
"The question text shows the count and the total (amount × selected) when the amount is known", but §13.4 text has no slot for the total.
*Now:* text without the total.
*Status:* OPEN (human) — give the wording with the total.

**SQ-06** · §9.2 step 5 / §9.3 step 7 `Q_ADDRESS_CORRECT`
(a) "the full address and its first and last 4 hex characters emphasised": the API is plain text — no emphasis format is defined. (b) ENS wording "riya.eth → 0x3fA9…c21E on Base Sepolia. Correct?" names one chain; when the record matched several chains, how are they listed?
*Now:* (a) plain full address, no emphasis markup; (b) chain names joined with ", " and a final " and ".
*Status:* OPEN (human).

**SQ-07** · §9.6 step 7 duplicate-address note
"Duplicate addresses → keep the alphabetically first subname, note the others" — no note wording given (`Skipped {name}: …`).
*Now:* the duplicate is excluded as specified, but no note is added until the wording is given.
*Status:* OPEN (human) — give the reason wording.

**SQ-08** · §10.4 vs §15 `INSUFFICIENT_FUNDS`
§10.4: "message lists per chain: spendable vs needed, for the token". §15 template: "You don't have enough {token}: you need {need}, and can use {have} across {chains}." A-30 expects "per-chain numbers".
*Now:* §15 template; `{have}`/`{chains}` filled with totals and chain names.
*Status:* OPEN (human) — give the per-chain wording (or confirm §15 with `{chains}` = "Base Sepolia (30), Arbitrum Sepolia (60)" style).

**SQ-09** · §13.4 mixed inputs
`Q_WHO_IS` = chips + free input (address or ENS); `Q_AMOUNT_MISSING` = number (+ token chips if unknown); `Q_FIAT_OTHER` = number + token chips. The question JSON has one `input` value, and §13.4 answer parsing says free text to a chips question is invalid unless it equals a chip label.
*Now:* `Q_WHO_IS` uses `input: "chips"`; free text that is not a chip label is processed by §9.1 step 4 (address → §9.2, ENS → §9.3, else re-ask) — §9.1 is the more specific rule. `Q_AMOUNT_MISSING` / `Q_FIAT_OTHER` use `input: "number"`; when the token is unknown the token is asked afterwards with `Q_TOKEN`.
*Status:* OPEN (human) — confirm, or define a combined input kind.

**SQ-11** · §5 Node.js version
Spec: Node.js 22 LTS. This machine has Node 23.11.1. `package.json` declares `engines.node >= 22`.
*Status:* OPEN (human) — install Node 22 (nvm/fnm) for the final clean-clone run, or accept 23.
*Update 2026-11-05:* the cloud build environment runs Node 22.23.4; the clean-clone checks run there. Proposed resolution: closed by using Node 22.
*Update 2026-11-06:* this machine runs Node 25.9.0; the human declined installing Node 22 here. All suites pass on 25.9.0. Still open: confirm 25 is acceptable, or run the final clean-clone check on Node 22.

**SQ-15** · §9.4 `Q_ENS_CHANGED` "Cancel" and §11.3 `Q_GROUP_OVER_LIMIT` "No" → `DISCARDED`
No reply text is given for these discards.
*Now:* reply `Cancelled. Nothing was sent.` (§13.3 "User cancelled").
*Status:* OPEN (human).

**SQ-18** · §17.3 "stop" while awaiting confirmation
"stop" is in both the cancel list (→ `DISCARDED`, reply `CANCELLED`) and the confirmation "no" list (→ `DISCARDED`, reply "OK, I've dropped that…"). Same state, different reply.
*Now:* the cancel row (listed first) wins: reply `Cancelled. Nothing was sent.`
*Status:* OPEN (human).

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
*Status:* OPEN (human) — confirm the labels, especially `pasted text N`.


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

### Open — need the human (interim behaviour applies)

- **SQ-A-01** `/cancel` with no active request → now 200 + `UNSUPPORTED_REQUEST`.
- **SQ-A-02** settings validation details (precision, `eth_gas_reserve` keys, duplicates, string pct, unknown keys) → now strict.
- **SQ-A-03** `messages` while `HANDOFF_FAILED` → now cancel words cancel; other text → `UNSUPPORTED_REQUEST`.
- **SQB-03** which "chain-like words" raise `UNSUPPORTED_CHAIN` → now only `polygon`, `solana`.
- **SQB-06** LLM #1 `number` not matching `^\d+(\.\d+)?$` → now `UNSUPPORTED_REQUEST`.
- **SQB-07** inflected cancel words ("cancelled", "stopping") → now counted.
- **SQB-08** unreadable PDF → now `UNSUPPORTED_REQUEST`.
- **SQB-12** also refuse `0.0.0.0/8` and `::` in the SSRF check → now refused.
- **SQB-14** model returned only `l` with no cancel word → now `UNSUPPORTED_REQUEST`.
- **SQB-17** a `QItem` with both address and ENS name → now the address is used.
- **SQ-C-01** ENS RPC failure for a payee → now `UNSUPPORTED_REQUEST`.
- **SQ-C-02** re-check returns two different new addresses → now `UNSUPPORTED_REQUEST`.
- **SQ-C-03** "Use new address" when it is saved under another name → now `UNSUPPORTED_REQUEST`.
- **SQ-C-09** `Q_GROUP_MEMBERS` preselection has no chip flag → now "all enabled chips are preselected" (UI rule).
- **SQ-C-10** §9 flowchart vs §9.4: which resolved contacts get the ENS re-check? → now a `Q_WHO_IS` contact chip does; an address already in DB2 does not.
- **SQ-C-11** viem returns null on `HttpError`/`ResolverError` reverts, so a gateway failure reads as "no address" → now the user is asked (no wrong address can result).
- **SQ-O-01** (raised by the Orchestrator from Lane C's report) §8.8 / §16.1 / §16.2 / §7.3 rule 5: §8.8 masks spans only, but §16.1 says LLM #4 sees recipients masked. If S5 tags one occurrence of a name and the same name appears again untagged, the name reaches LLM #4. Tagging every occurrence as a payee would mint extra placeholders that P3 then requires to be paid. → now spans only. Options: (a) keep; (b) replace further occurrences of a tagged text by that span's placeholder, with no new DB3 row; (c) replace them by `[person]`.
- **SQ-A-04** how an `intent_result` finds the DB7 row → now by `autopay.autopay_id`; a failed `l` leaves the row unchanged; a `k` report with no `autopay` updates DB6 only.
- **SQ-A-05** closing a leftover session id while another session is open → now 404, clears nothing.
- **SQ-A-06** after the third failed hand-off the request is `FAILED`, but the only text says "Confirm again to retry" and confirm returns 409 → now the §15 text unchanged. Wording needed.
- **SQ-A-07** an existing token file not at mode 0600 → now refused at startup, including 0400.
- **SQ-A-08** base64 attachments → now strict RFC 4648, no whitespace; non-zero trailing bits accepted.
