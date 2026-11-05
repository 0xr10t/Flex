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
