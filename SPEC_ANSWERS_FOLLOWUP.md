# SPEC_ANSWERS_FOLLOWUP

Consistency check of the human's answers of 2026-11-06 (recorded in `SPEC_QUESTIONS.md`). README.md is unchanged.
Each item gives the ids involved, what clashes, and one question with options. Until answered, the "Proposed default"
is what the code should do, so work is not blocked. Ids: SQ-D-16 means answer 13 (one-time limit overrides).

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
- **Item 14 vs SQ-A-03**: cancel in `HANDOFF_FAILED` still cancels (`DISCARDED`) with the same reply text; no clash.

- **SQ-O-10 vs `reused_from_chain_id`**: consistent, no human question left. DB3 stores one chain id (README line 467,
  plan schema line 1342), but the note can list all chains without a schema change: at summary time (S11), take the
  contact's DB2 rows whose address equals the reused address (the address held by the DB3 placeholder), excluding the
  payment's own chain, and list their chain display names in configured-chain order with the SQ-06 join ("A and B").
  Rows of the same contact with a different address are not listed. `reused_from_chain_id` stays the single "source"
  chain (set in S9), used only as the marker that a reuse happened. Nothing changes between S9 and S11 in one request,
  so the derived list is stable. One chain gives the same note as today.

## Follow-up questions

### F-1 (SQ-D-16, V-13/V-14/V-15) Several limits broken at once

Today S10 stops at the first broken rule. A request can break the per-payment limit and the daily limit together
(three payments of 120 with a 100 per-payment and 300 daily limit).
Question: should the user get one question for everything, or one question per limit?
- (a) One question that names every broken limit: "This is over your per-payment limit of 100 and today's limit of 300.
  Go ahead this once?" One "Yes" lifts all of them for this request. Proposed default.
- (b) One question per broken limit, one after the other; "No" to any ends the request.
- (c) Only ask about the first broken limit and treat the others as already covered by that "Yes".

Proposed wording per limit (for the human to approve or change): per-payment "This is {amount} {token}, over your
per-payment limit of {max}. Go ahead this once?"; daily "This sends {total} {token}, but only {remaining} is left of
today's {daily_max} limit. Go ahead this once?" (the existing group wording); per-period "This pays {cap} {token} a
week, over your repeating-payment limit of {max} a week. Go ahead this once?"; duration "This repeats for {weeks} weeks;
the limit is {max} weeks. Go ahead this once?"

### F-2 (SQ-D-16, SQ-15, V-15) The existing group question and its note

`Q_GROUP_OVER_LIMIT` today is asked only for group payments over the daily limit, and the summary note says "Today's
limit was lifted once for this group payment." With item 13, non-group requests over the daily limit also get a question.
Also, today a group payment whose amounts came from attached content still gets the question; under item 13's rule it
would end with `LIMIT_DAILY`.
Question: what happens to the group question and the note?
- (a) Replace it with the general one-time question (same Yes / No chips) and make the note general: "A limit was
  lifted once for this request." For attached-content amounts the limit error now stands, also for groups. Proposed
  default.
- (b) Keep the group question and note as they are, and add the new question and a second note for everything else.
- (c) Like (a), but groups keep asking even for attached-content amounts (as today).

### F-3 (SQ-D-16, autopay) What "once" means for a repeating payment

An override on a repeating payment (per-period or duration limit, or per-payment amount on a `k`) lets the whole series
run, not one payment. "Go ahead this once?" could be misread.
Question: which wording should the repeating-payment questions use?
- (a) "…Go ahead with this repeating payment anyway? Your limits stay unchanged." Proposed default.
- (b) Keep "Go ahead this once?" word for word.
- (c) Do not offer the override for repeating payments; the limit error stands.

### F-4 (SQ-D-16, V-12 / `LIMIT_BRIDGES`) Is the bridge limit a "limit" for the new question?

`max_bridges_per_request` is in DB5. Bridges are chosen by the agent, never typed, and the human's rule is about typed
amounts.
Question: when a request needs more transfers between chains than the limit, what happens?
- (a) The same one-time question: "This needs {n} transfers between chains; your limit is {max}. Go ahead this once?"
  Asked when the payment amounts are typed. Matches "all limits".
- (b) No question; `LIMIT_BRIDGES` stays an error, because the user did not type the number of transfers. Proposed
  default.

### F-5 (SQ-D-16) A request that mixes typed and attached-content amounts

Example: one payment typed by the user and one taken from an attached invoice, over the daily limit. Daily limit is the
sum of all payments.
Question: when does attached content block the one-time question?
- (a) If any amount anywhere in the request came from attached content, no question; the limit error stands. Safest.
  Proposed default.
- (b) Only if an amount that counts toward the broken limit came from attached content (per-payment: that payment;
  daily or per-period: any payment in the sum).
- (c) Ask whenever the payment that breaks the limit is typed, whatever else is in the request.

### F-6 (SQ-D-16) Do "half my eth" and agent-calculated amounts count as typed?

Relative amounts ("all", "half"; `source='user'`, `origin='relative'`) come from the user's words but the number comes
from balances. Derived amounts (bridge padding, autopay caps; `source='derived'`) come from a typed amount plus settings.
Question: how do they count?
- (a) Relative amounts count as typed (the user asked for "all"). Derived amounts count as typed when the amount they
  come from is typed, and as untrusted when it came from attached content. Proposed default.
- (b) Relative and derived amounts never count as typed; any limit broken by them stays an error.
- (c) Relative amounts count as typed, derived amounts never do.

### F-7 (SQ-01 vs planned bridging) The new reply promises something it refuses

The new text says "I can … bridge funds between chains", but a user asking "move my USDC from Base to Arbitrum" must still
get this same reply ("I can't help with that part"). The agent does bridge internally to fund a payment (§10.4), but the
user cannot ask for a bridge.
Question: should the sentence say what is true today?
- (a) Keep the human's text exactly. Bridging by request is planned (CCIP). Accept the mismatch for now.
- (b) Use "…bridge funds between chains when a payment needs it…" until direct bridging is built.
- (c) Drop "bridge funds between chains" from the sentence until direct bridging is built.

### F-8 (SQ-A-01 vs HANDED_OFF) "Nothing was sent" after a request was already handed to the wallet

The cancel endpoint now answers "Cancelled. Nothing was sent." even for an already-ended request. If that request is
`HANDED_OFF` (the wallet already received it), the text is false.
Question: what should cancel say for an already handed-off request?
- (a) Same text for every ended request, as decided. Simple, but wrong after a hand-off.
- (b) For `HANDED_OFF`, reply "That request was already sent to your wallet, so it can't be cancelled here." (still HTTP
  200, nothing changed); everything else keeps "Cancelled. Nothing was sent." Proposed default.
- (c) For every already-ended request reply "There is nothing to cancel." and use "Cancelled. Nothing was sent." only when
  something was actually cancelled.

### F-9 (SQ-A-06) "Nothing was sent" after a timeout

The final-failure text says "Nothing was sent." The hand-off fails on a server error or a timeout; after a timeout the
wallet may in fact have received the request (the repeat key protects against double execution, but not against this
sentence being untrue).
Question: keep the sentence?
- (a) Keep the human's text exactly. Proposed default.
- (b) Use "I couldn't confirm that your wallet got it after 3 tries. Check your wallet before trying again." for
  timeouts; the human's text for server errors.
- (c) Use the (b) text for every third failure.

### F-10 (SQ-08) Which chains does the funds message list?

The example lists the two chains that hold USDC and leaves out a chain with 0. Not said: chains with zero balance, chains
whose balance could not be read, and the order. Also the zero-value case (SQB-11: "you need 0").
Question: what goes in the list?
- (a) Only chains that hold a positive amount, in the order of the configured chains; unavailable chains are left out
  (they already have their own note). If no chain holds any, "…can use 0 across {chosen chain} (0)". Proposed default.
- (b) Every allowed chain, including zero ones ("Sepolia (0)").
- (c) Positive chains first, largest amount first.

### F-11 (SQ-O-03, P4) How far the relaxed P4 reaches

With P4 relaxed, an amount whose clause has no recipient can pair with any recipient in another clause. Cases: "send 10
usdc and 20 usdc to mihir and riya" (which amount goes to whom?), and "send 10 usdc. Send 20 usdc to Mihir" (the 10 USDC has
no recipient; it could now be paid to Mihir too, where before P4 would block it).
Question: should the relaxation be limited?
- (a) Only when the amount and recipient clauses are joined by "and"/"plus"/"also" in one sentence, as in A-57; other
  cases keep P4 as written. Proposed default.
- (b) As the human said (any case where the amount's clause has no recipient), and when the pairing is unclear, ask
  the user who gets which amount.
- (c) As the human said, with no extra rule; the summary the user confirms is the safeguard.

### F-12 (SQ-O-01 / SQB-23) The same name tagged two ways, and overlaps

If the same text is returned once as a payee and once as "mentioned" (or two different spans share text), the sweep
cannot give one placeholder to all occurrences. Also, the sweep must keep S7's rule that offsets never overlap
(`s7_span_mismatch`, fail closed); a name inside a longer tagged span (a name that is part of an ENS name) must not be
swept inside it.
Question: which placeholder wins, and what if it is unclear?
- (a) Payee wins over mentioned; occurrences inside another tagged span are left alone; any remaining conflict stops
  the request (fail closed, `UNSUPPORTED_REQUEST`). Proposed default.
- (b) Mentioned wins (the name shows as `[person]` everywhere; the payee keeps only the occurrence the model tagged).
- (c) If one text carries both roles, ask the user which it is.

### F-13 (SQ-O-08) Refuse the whole range or only dangerous addresses?

For `64:ff9b::/96` and `2002::/16` the human said "decoding the embedded IPv4". It is not clear if the whole range is
refused or only addresses whose embedded IPv4 is itself refused (a 2002: address wrapping a public IPv4 can be a real
public host).
Question:
- (a) Refuse both ranges entirely, always. Simplest and safest. Proposed default.
- (b) Refuse only when the decoded IPv4 is in a refused range (127.x, 10.x, 100.64.x, ...); allow public ones.

## Code changes required

Describe only; nothing is implemented. Lanes: A platform, B S0–S5, C S6–S7, D S8–S12, O Orchestrator-owned
contracts/catalog/question codes. "default" = proposed default of the F-question above.

| id | Change (behaviour) | Likely files | Lane | Tests affected |
|---|---|---|---|---|
| SQ-O-01, SQB-23 | After S5 tags spans, replace every further whole-word occurrence of a tagged payee text by that payee's placeholder, and of a mentioned text by `[person]`, in the masked text LLM #4 sees. No new DB3 row, no extra payment. Offsets stay exact and non-overlapping; conflicts fail closed (F-12 default). | `src/pipeline/s5-*.ts`, `src/quarantine/*`, S7 `src/recipients/*` (mention masking), `src/llm/prompt-builder/` | B (S5), C (S7 offsets check) | `test/audit/prompts.test.ts` two `it.fails` for SQ-O-01 become normal; B lane tests for SQB-23 (second occurrence now swept, no longer "left untagged"); S7 span tests |
| SQ-O-06 | Run the S1 secret scan over every `urls[]` entry and every redirect target before any fetch; a hit gives `SECRET_DETECTED`; nothing fetched or stored. | `src/guard/secrets.ts`, `src/guard/urls.ts`, S1 step | B | `test/audit/secrets.test.ts` `it.fails` (secret in `urls[]`) becomes normal; add a redirect-target case |
| SQ-O-08 | Extend the URL fetcher's refused ranges: `100.64.0.0/10`, `64:ff9b::/96`, `2002::/16` (decode embedded IPv4, check it too), `::a.b.c.d` IPv4-compatible, `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `ff00::/8`, `255.255.255.255`, `fec0::/10`; keep `0.0.0.0/8`, `::`. | `src/guard/urls.ts` | B | SSRF unit tests (SQB-12 tests stay; add the new ranges and the wrapped-loopback cases); audit tests for O3 |
| SQ-O-09 | `EXECUTION_REJECTED` message: cut to at most 200 characters and strip control characters. | `src/handoff/execution-client.ts`, `src/pipeline/s12-handoff.ts` | D | S12 reject-message tests; add a 300-character and a control-character case; SQ-D-09 `HTTP <status>` fallback unchanged |
| SQ-O-03 | Relax P4: a payment whose amount and recipient are in different clauses passes when the amount's clause has no recipient placeholder of its own; P4 as written when it has one (limits per F-11 default). | `src/plan/*` pairing checks (P1–P9), `src/pipeline/s8-*.ts` | D | A-57 `it.fails` (`test/acceptance/a55-a60.ts`) becomes normal; add "10 to A and 20 to B" still rejected on swapped pairing; `pairing/checks` unit tests |
| SQ-O-05, SQ-O-02, SQ-D-15, SQ-18, SQ-15 (current parts), SQ-11 | None: current behaviour is the answer. Update docs only (`SPEC_CHECKLIST.md` C-497 stays "deviates"; STATUS note for Node 25). | none | none | none |
| SQ-08 | `INSUFFICIENT_FUNDS` shows per-chain spendable amounts: "…you need 150, and can use 140 across Base Sepolia (80) and Arbitrum Sepolia (60)." List join as SQ-06; no trailing zeros; chain rules per F-10. Catalog slot values change (`{chains}` carries names with amounts). | `src/contracts/catalog.ts` (slot/format), `src/pipeline/s9-*.ts`/`s10-validate.ts` (balance check), `src/pipeline/s4-type.ts` (relative amount value 0, SQB-11) | O (catalog), D, B | A-30 test and `test/unit/contracts/error-messages.test.ts` INSUFFICIENT_FUNDS sample (C-395); SQB-11 test |
| SQ-A-06 | After the 3rd failed hand-off (request `FAILED`) the reply is "I couldn't reach your wallet after 3 tries. Nothing was sent. Please try again later." Attempts 1 and 2 keep the §15 `EXECUTION_UNAVAILABLE` text. Keep the 35-code catalogue (new text variant, not a new code). | `src/pipeline/s12-handoff.ts`, `src/contracts/catalog.ts`, `src/session/manager.ts` | D, O (catalog) | S12 retry tests (3rd failure text); C-395 test (add the variant) |
| SQ-01 | `ERROR_MESSAGE.UNSUPPORTED_REQUEST` becomes "I can send USDC or ETH, bridge funds between chains, set up or stop repeating payments, and show balances. I can't help with that part." Used everywhere; no short reason. Record direct user bridging as a planned CCIP feature (still unsupported now). | `src/contracts/catalog.ts`; `src/pipeline/s4-type.ts` (no reason generated) | O | `test/unit/contracts/error-messages.test.ts` (C-395, `UNSUPPORTED_REQUEST` case); A-18, A-19 text expectations; `COMPLIANCE_REPORT.md` row "35 identical" (human-approved difference); any test matching the old text (grep `help with that part`); wording per F-7 |
| SQ-A-01 | Cancel with nothing active, a wrong `request_id`, or an already-ended request: HTTP 200, state `done`, reply "Cancelled. Nothing was sent.", nothing changed, repeatable. No `UNSUPPORTED_REQUEST`, no `unsupported_state` log for this path. `HANDOFF_FAILED` still counts as active (`DISCARDED`). `HANDED_OFF` text per F-8. | `src/session/manager.ts`, `src/server/*` | A | Lane A cancel tests (`cancel:no_active_request` expectations flip to `CANCELLED`, state done); repeat-cancel idempotence test |
| SQ-D-16 (one-time limit overrides) | S10 asks a one-time Yes / No question ("go ahead this once?") instead of ending with `LIMIT_PER_TX` (V-13, V-14 amount), `LIMIT_DAILY` (V-15), `LIMIT_AUTOPAY_PERIOD`, `LIMIT_AUTOPAY_DURATION` when the amounts involved are typed. Yes sets a request-level override (DB5 unchanged; summary gets a note); No gives `DISCARDED` and "Cancelled. Nothing was sent." Untrusted-sourced amounts keep the limit error (E9 still `LIMIT_PER_TX`). Questions per limit, grouping, bridges, mixed and relative cases per F-1 to F-6. Replaces/generalizes `Q_GROUP_OVER_LIMIT` and `daily_limit_override` and the note "Today's limit was lifted once…" (F-2). | `src/pipeline/s10-validate.ts`, `src/contracts/types.ts` (request override flag, question codes), `src/contracts/catalog.ts` (question texts, note), `src/session/request.ts`, S11 summary note | D (S10, S11), O (question codes, catalog, flag) | Validate unit tests V-13…V-15 and autopay duration/period (now ask when typed, still error when untrusted); A-27, A-28 (expect the question, not the error) ; A-15 and E9 stay `LIMIT_PER_TX` (default limits); group-over-limit test (E5 variant at 1945); `C-395` list unchanged unless a new code is added |
| SQ-O-10 | Silent-reuse note names every chain whose DB2 row for the contact holds the reused address, joined "A and B" / "A, B and C". S9 keeps setting the single `reused_from_chain_id`; S11 derives the list from DB2 at summary time (no schema or contract change). | `src/pipeline/s9-plan.ts` (marker only), S11 summary note builder, `src/contracts/catalog.ts` (note slot) | D | A-26 (`test/acceptance/a17-a32.ts`) asserts the exact two-chain note instead of accepting either chain; a one-chain case stays "Same address as on {Chain}." |
| SQ-03, SQ-C-09, item 17 | None: current behaviour (`prefill`, UI pre-ticks all enabled chips) stands. | none | none | none |
