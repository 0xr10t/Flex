# Lane B spec questions

Format: **SQB-nn** · section · question · what the code does now. Interim behaviour stays until the Orchestrator or
the human answers. Entries that are not covered at all return `UNSUPPORTED_REQUEST` (spec §0) and log
`event: "unsupported_state"` with a `rule_id` (SQ-19).

**SQB-01** · §8.4 / §15 / §17.2 — lists of names or chains in one message (`{chains}` of `BALANCES_UNAVAILABLE`,
`{names}` of `Q_FOLLOWUP_WHO`).
_Now:_ the SQ-06 interim join format: "A", "A and B", "A, B and C" (`joinNames` in `src/lexical/step-util.ts`).

**SQB-02** · §8.2 steps 1, 4, 5 and §15 — the `{item}` slot (`DOCUMENT_TOO_LARGE`, note "Couldn't read anything usable
from {item}") is not worded, and the numbering of links when both `urls[]` and typed URLs exist is not given.
_Now:_ attachments → their filename; links → `link N`; pasted blocks → `pasted text N` (CCR B-1). `urls[]` entries are
links 1…u in order; URLs typed in the text continue from u+1 in order of appearance (`[link N]`).

**SQB-03** · §8.3 rule 6 — "any other chain-like word after `on`/`via` that is not an alias (`polygon`, `solana`, …)".
The list ends with "…".
_Now:_ only `polygon` and `solana` (the named examples) raise `UNSUPPORTED_CHAIN`; `polygon` not after on/via is a §6.2
mainnet word (`MAINNET_NOT_SUPPORTED`).

**SQB-04** · §8.3 rule 1 — clause separators `.` and `,` also occur inside numbers ("0.5", "1,000"), ENS names
("riya.eth"), addresses and links.
_Now:_ separators inside an address, ENS candidate, number, URL or `[link N]` marker do not split clauses.

**SQB-05** · §8.3 rule 4 / §6.2 group markers — what counts as the parent after "everyone under", "everyone in",
"all of", "all members of".
_Now:_ the following dotted name (e.g. `iitr.eth`); `@<domain>` (not part of an email) and "everyone with/at @X" take
the domain after `@`.

**SQB-06** · §8.4 step 3 — "`number` MUST match `^\d+(\.\d+)?$`. If null → `Q_AMOUNT_MISSING`." What happens when
LLM #1 returns a non-null number that does not match (e.g. "1,000" or "5k")?
_Now:_ `UNSUPPORTED_REQUEST` (`rule_id: S3_NUMBER_PATTERN`).

**SQB-07** · §6.2 cancel words — are inflections ("stopping", "cancelled", "turned off") cancel words?
_Now:_ yes: the listed words plus the suffixes s/ed/ing (and doubled-consonant forms), and "turn(s/ed/ing) off".

**SQB-08** · §8.2 step 1 — an attachment with MIME `application/pdf` that `pdf-parse` cannot read.
_Now:_ `UNSUPPORTED_REQUEST` (`rule_id: S1_PDF_UNREADABLE`), buffers dropped, nothing stored.

**SQB-09** · §8.4 step 7 / §13.4 `Q_UNTRUSTED_AMOUNT` — "Type a different amount" → "number input": which question
code carries that number input?
_Now:_ `Q_AMOUNT_MISSING` ("How much should I send?", number). The valid answer becomes the row's amount with
`source='user'`, `confirmed=1`.

**SQB-10** · §8.6 / §8.10 LLM #3 — the format of `{candidates_json}`.
_Now:_ a JSON array of the candidate texts, e.g. `["riya.eth","iitr.eth"]`.

**SQB-11** · §8.4 step 6 — "Value 0 → `INSUFFICIENT_FUNDS`", but the §15 message needs `{need}`, `{have}`, `{chains}`.
_Now:_ `token` = the token, `need` = `0`, `have` = the spendable amount (0), `chains` = the chosen chain's name.

**SQB-12** · §8.2 step 3 — the refused ranges list does not include `0.0.0.0/8` or `::` (which reach the local host
on many systems).
_Now:_ both are refused too; IPv4-mapped IPv6 addresses are checked as IPv4.

**SQB-13** · §17.2 step 6 vs step 2 — the token fallback ("if they find no token, the previous payment's token is
used") runs in S3, before S5 decides whether the request is a follow-up (back-reference word **and** no payee).
_Now:_ S3 uses the previous token when S2 found a back-reference word and the payments of the most recent history entry
all have one token; otherwise `Q_TOKEN`.

**SQB-14** · §8.5 rule 3 — "Remove `l` if S2 found no cancel word" can leave `actions` empty (the model returned only
`l`).
_Now:_ `UNSUPPORTED_REQUEST` (`rule_id: S4_ONLY_L_WITHOUT_CANCEL_WORD`).

**SQB-15** · §8.5 rule 3 `also_balance` — "the balance answer is added as the first message of the summary response".
S4 runs before any S5–S10 question, and the runner sends `prepend_messages` with the very next response.
_Now:_ S4 sets `req.also_balance = true`; S11 (Lane D) must put `buildBalanceAnswer(ctx)` first in the summary
response (or push it to `prepend_messages` right before returning the summary).

**SQB-16** · §8.6 rule 4 — an S2 candidate that LLM #3 returned with a different `kind` (e.g. an address as `name`).
_Now:_ the span keeps the model's `role`, and its `kind` is set to the S2 candidate's kind.

**SQB-17** · §8.6 rule 8 — a `QItem` with both an address and an ENS name.
_Now:_ one untrusted payee from the address; that item's ENS name is not used. Duplicate addresses/names across items
give one payee.

**SQB-18** · §8.4 step 7 — a document amount of 0, or with more decimals than its token allows.
_Now:_ the S3 rules apply: `Q_AMOUNT_MISSING` ("amount must be more than 0") / `Q_AMOUNT_PRECISION`. The typed answer
makes the row `source='user'`, `confirmed=1` (as "Type a different amount" does), so no `Q_UNTRUSTED_AMOUNT` follows.

**SQB-19** · §8.6 rule 6 / §8.8 — S7 must replace `mentioned` spans by `[person]`, but `AgentRequest` has no field for
them.
_Now:_ S5 writes `mentioned_spans: Span[]` (offsets in `masked_text_s3`), the field Lane C's S7 reads (CCR B-2, same
as Lane C's CCR C-1).

**SQB-20** · §8.4 step 6 — the chain named for a relative amount is outside `allowed_chain_ids`, or its balance is
`unavailable`.
_Now:_ not allowed → `CHAIN_NOT_ALLOWED`; unavailable → `BALANCES_UNAVAILABLE` naming that chain.

**SQB-21** · §8.5 rule 3 — `Q_RECURRING` "sets `k` or `i` for all pay amounts in the clause(s) with the recurrence
phrase", but `actions` is one list per request.
_Now:_ "Yes, repeat it" adds `k`, and removes `i` when every pay amount is in a clause with a recurrence phrase;
"No, just once" removes `k` and adds `i`.

**SQB-22** · §8.4 step 3 (c)/(d) — the token word found in the clause/prompt is a non-USD fiat word (`₹`, `rs`, …) and
the phrase itself did not mark fiat.
_Now:_ treated as fiat `OTHER` → `Q_FIAT_OTHER`. A fiat word inside the phrase (S2 rule 7) also sets `fiat` when LLM #1
returned null. Rule (c) uses the clause's token words when they all name one token; rule (d) needs exactly one token
word in the whole prompt.

**SQB-23** · §8.6 rules 1, 4, 6 / §8.8 (see SQ-O-01, open with the human) — a span text that occurs more than once in
`masked_text_s3`.
_Now (no sweep, as instructed for SQ-O-01):_ each returned span takes the first whole-word occurrence not already
taken by the same text; a text returned N times takes the first N occurrences. Occurrences not returned are left
untagged (not payee, not mentioned), so a mentioned name returned once but written twice keeps its second occurrence
visible in later masked texts. S2 candidates are de-duplicated by text: an address/ENS name written twice gives one
payee span at its first occurrence (the same recipient is not resolved twice). Offsets are always exact in
`masked_text_s3` and never overlap.

**SQB-24** · §8.4 rules 4–5 — a numeric candidate that partly overlaps a returned phrase (e.g. phrase `5`, candidate
`5k`) is "not inside any returned phrase", so `Q_AMOUNT_UNCOVERED` is asked; "Yes" would make two overlapping phrases
that cannot both be replaced by placeholders.
_Now:_ the question is asked as the spec says; "Yes" → `UNSUPPORTED_REQUEST` (`rule_id: S3_UNCOVERED_OVERLAPS_PHRASE`);
"No" → ignored.

**SQB-25** · §8.5 rule 3 / §8.4 output — the amount asked by S4's `Q_AMOUNT_MISSING` (i/k without pay amounts) has no
phrase in `typed_text`.
_Now:_ S4 mints it (DB1 `source='user'`, `origin='phrase'`, `confirmed=1`) and adds it to `req.amounts` with
`phrase: null`, `span: null`; it does not appear in `masked_text_s3` (there is nothing to replace), so LLM #4 sees it
only in its AMOUNTS list. Lane C/D: confirm S8 pairs such an amount.

**SQB-26** · §8.4 rule 1 / §8.6 rule 1 — "occur verbatim … first unused occurrence" says nothing about word edges.
_Now:_ an occurrence must not cut a word or a number: no letter next to a letter and no digit next to a digit at
either edge (`5` is not found inside `50`, `riya` not inside `riyaz`; `50` is found in `50usdc`, `riya.eth` in
`@riya.eth`).

**SQB-27** · §8.2 step 2 keystore detector — "JSON-parsable text containing keys `crypto` (or `Crypto`),
`ciphertext` and `kdf`" for a keystore pasted inside other text, or with the keys nested.
_Now:_ the whole text, and also the outermost `{…}` slice of it, are tried; the keys may be at any depth. This blocks
more than a literal reading (a keystore pasted with a sentence around it is still a secret).
