# COMPLIANCE_REPORT (Phase 3, section 3.3)

Reviewed commit: `69bbbf1` (`agentic_layer`, four lanes merged). Baseline: `npm run typecheck` clean, `npm test` 48 files / 1,416 tests green.

## Summary

| Owner | Items | implemented + tested | implemented, no test | missing | deviates |
| --- | --- | --- | --- | --- | --- |
| Lane A | 81 | 81 | 0 | 0 | 0 |
| Lane B | 123 | 123 | 0 | 0 | 0 |
| Lane C | 73 | 73 | 0 | 0 | 0 |
| Lane D | 152 | 152 | 0 | 0 | 0 |
| Orchestrator | 85 | 74 | 6 | 1 | 4 |
| **Total** | **514** | **503** | **6** | **1** | **4** |

27 of the "implemented + tested" rows carry an `(interim SQ-xx)` tag: the code follows a binding interim answer in `SPEC_QUESTIONS.md`.

Method and its limits:

- A row is `implemented + tested` when a passing test names its id (`C-nnn`) in `test/**`. 437 of the 514 ids are named. The other 77 are 60 acceptance rows (C-454..C-513), which the suite names `A-01`..`A-60` (mapping `C-453 + n`; all 60 names present, A-57 is an `it.fails`), C-514 (missing) and 16 Orchestrator rows handled individually below.
- The two exact-text artefacts that a test would have to enforce (catalog texts, DDL, static tables) were verified by script instead (next section).
- I did not independently re-read every rule's implementation. Beyond the test evidence, the code was checked directly for: the four known conflicts, the verbatim artefacts, the section 14.1 settings ranges, log rotation, token-file mode, the 127.0.0.1 bind, the section 13.1 and 13.2 templates (identical to `src/messages/templates.ts`), and the 10 s RPC timeout.
- No test is skipped (`grep` for `skip`, `todo`, `xit`: none). The only `it.fails` is A-57.
- Production code was not changed.

## Deviations (4)

All four are known conflicts between the section 8 / 10 text and a worked example or acceptance row. Each is open with the human.

| Row | Spec | Code location | Difference | Lane |
| --- | --- | --- | --- | --- |
| C-437 (E6 reproduced) | SQ-D-15. Section 19 E6 prints `expires_at` `2026-12-31T18:29:59Z` (the `on_date`) | `src/plan/schedule.ts:139-145` (`expiresAt`) | Code follows section 10.6 rule 8 (23:59:59 on the last occurrence's date) and emits `2026-12-25T18:29:59Z`. `test/unit/D/examples.test.ts:397` and `test/acceptance/a01-a16.ts:347` assert the code value and cite the conflict. A-08 (C-461) passes on the code value, tagged interim. | D (Orchestrator-owned row) |
| C-440 (E9 reproduced) | SQ-D-16. E9 uses 120 USDC; default `per_tx_max` is 100 (section 6.3) | `src/plan/limits.ts:40-42` (V-13) | As written E9 ends in `LIMIT_PER_TX`. A-15 (C-468) passes only because its setup raises the limit. | D / Orchestrator |
| C-497 (A-44) | SQ-O-05. Section 20.2 A-44: "send 10 usdc to me" gives `SELF_PAYMENT` | `src/pipeline/s5-spans.ts:76` (`droppedWords` includes `SELF_WORDS`, section 8.6 rule 2) | "me" is dropped as a span, so the request reaches `Q_NO_PAYEE`. The own-address variant gives `SELF_PAYMENT` (`test/acceptance/a33-a52.ts:190`). The "me" variant is tested as `Q_NO_PAYEE` (`a33-a52.ts:203`). | B / Orchestrator |
| C-510 (A-57) | SQ-O-03. Section 20.2 A-57: "10 usdc and 0.01 eth to mihir" gives two `i` intents | `src/plan/pairing-checks.ts:81-` (P4 clause binding) | Clause split at "and" puts the 10 USDC in another clause than Mihir, so P4 rejects the pairing: `PAIRING_FAILED`. `test/acceptance/a55-a60.ts:79` is `it.fails`. Row C-135 (P4 as written) is `implemented + tested`. | D / Orchestrator |

## Missing (1)

| Row | Spec | Note | Lane |
| --- | --- | --- | --- |
| C-514 | Section 20.3 live-model evaluation (acceptance prompts + 100 paraphrases; pairing exact-match, question rate, wrong-hand-off rate 0) | `vitest.live.config.ts` and `npm run test:live` exist, but `test/live/` is empty. Needs a real Ollama model, so it is not part of the green run. | Orchestrator |

## Implemented, no test (6, all Orchestrator-owned frozen contracts)

| Row | Item | Status of the content |
| --- | --- | --- |
| C-005 | `src/contracts/static-tables.ts` (section 6.2 tables) | Word lists checked by eye against section 6.2 (identical). Only `TOKENS` and the cancel/confirm texts are asserted by other tests (`test/unit/A/config.test.ts:213`, `session.test.ts:11`). No test compares the lists. |
| C-026 | `src/db/schema.sql` = section 7.1 | Identical (below). Used by the DB tests, but no test asserts equality with the spec. |
| C-049 | `RequestState` and `AgentRequest` (section 8.0) | Identical state union and fields. Extra internal fields (`input`, `masked_text_s3`, `resolved`, `mentioned_spans`, ...) are additive (contracts-v3). No test. |
| C-271 | Shared Ajv: 2020, `strict`, `allErrors`, formats | `src/schemas/index.ts:26` (also `allowUnionTypes: true`). Used by every schema test, never asserted directly. |
| C-306 | Question shape, catalog texts, fixed chips, `matchChip` | Texts identical (below). `matchChip` is exercised only indirectly through the pipeline question tests. `test/unit/contracts/contracts.test.ts:85` checks code coverage only. |
| C-395 | All 35 section 15 messages in the catalog | Identical (below). The same test only checks that every code has a function. |

Minor test-labelling issue: the E8 test in `test/unit/D/examples.test.ts:439` is titled `C-440 E8`. The checklist has E8 = C-439 and E9 = C-440. E8 is also covered by A-14, so C-439 is `implemented + tested`.

## Interim-answer rows (not deviations)

C-461 (SQ-D-15), C-468 (SQ-D-16), C-239 (SQ-D-15), C-135 (SQ-O-03), C-110 (SQ-O-05), C-101 and C-368 (SQ-01), C-169 and C-318 (SQ-06), C-171 and C-320 (SQ-03), C-195 (SQ-07: no duplicate-skip note yet), C-197 (SQ-05: Q_GROUP_MEMBERS text has no total), C-214 and C-381 (SQ-08: section 15 template used, not per-chain lines), C-155 and C-426 (SQ-A-06), C-322 and C-326 (SQ-15), C-424 and C-422 (SQ-18), C-307, C-312, C-317 and C-160 (SQ-09), C-363 and C-073 (SQ-22). The tags are by keyword match on the row, so a lane should confirm them.

## Verbatim checks

Script (kept out of the repo, in the session scratchpad, not committed): extracts the fenced blocks from `README.md` by line range and language, compares them with the source file, and prints the first differing character. Catalog texts were compared by calling `QUESTION_TEXT` and `ERROR_MESSAGE` with a proxy that returns `{slot}` for every parameter, against the table text column.

| Artefact | Result |
| --- | --- |
| Prompts, section 8.10 (5 fences) vs `src/llm/prompts/{amounts,requestType,spans,payments,quarantine}.txt` | Identical, including the `SYSTEM` and `USER` header lines, for amounts, requestType, spans and quarantine. `payments.txt` is identical after removing the trailing `// ...` remarks from the five slot lines (`AMOUNTS:`, `RECIPIENTS:`, `DOCUMENT ITEMS:`, `SESSION:`, `{correction_line}`) and the spaces before them: this is the allowed difference SQ-21. Spec line 32 (`AMOUNTS: {amounts_json}            // [...]`) is `AMOUNTS: {amounts_json}` in code, and so on. No other difference. |
| Schemas, section 12.1 (4 fences) vs `llm-amounts`, `llm-request-type`, `llm-recipient-spans`, `llm-quarantine` `.schema.json` | Identical, byte for byte (text) and parsed. |
| Hand-off envelope, section 12.5 vs `handoff-envelope.schema.json` | Identical, byte for byte. |
| Section 12.2 template (`payments-template.ts`) and 12.3 internal plan schema | Not a verbatim copy by nature (slots filled by code; schema generated by `scripts/gen-internal-plan-schema.mjs`). Behaviour covered by `test/unit/contracts/contracts.test.ts:22,70` and the D tests. |
| Section 13.4 question texts (26 codes) vs `QUESTION_TEXT` | Identical. Slot notation differs only where the spec writes an optional slot: `{ to Name}` and `{ for name}` are built as ` to ${name}` and ` for ${name}` only when `name` is given; `{USDC or ETH}` is the literal when no token is known. `Q_ENS_CHANGED` is identical to the section 9.4 text ("riya.eth now points to 0xNEW... (saved: 0xOLD...). Use the new address?"). `Q_ADDRESS_CORRECT` base text identical; ENS and untrusted variants are in `QUESTION_VARIANT` (checked against sections 9.2, 9.3). |
| Section 15 error messages (35 codes) vs `ERROR_MESSAGE` | 34 identical, `UNSUPPORTED_REQUEST` human-approved difference (SQ-01, F-7) (the table's markdown-escaped `\"` in `SPLIT_UNSUPPORTED` is `"` in code). |
| DDL, section 7.1 vs `src/db/schema.sql` | Identical after the first line of the file, which is an added comment: `-- Implements: section 7.1 DDL (verbatim). Owned by the Orchestrator; lanes must not edit.` (character for character: it is an extra line before spec's first line `-- DB1: amount placeholders (session-scoped)`). The pragmas fence (6 lines) is applied in `src/db/open.ts`, tested by `test/unit/A/db-pragmas.test.ts`. |
| Config, section 6.1 vs `config.example.json` | Identical as parsed JSON (key order and values). Text differs in whitespace only: the spec has some chain objects on one line (`"name": "Sepolia", "is_l2": false,` on one line), the file has one key per line. |
| Defaults, section 6.3 vs `src/config/defaults.ts` `DB5_DEFAULTS` | Identical (8 keys, values and types: strings for amounts and `bridge_buffer_pct`, numbers for ids and counts). |
| Static tables, section 6.2 vs `src/contracts/static-tables.ts` | Identical word lists (compared by eye). The "+ autopay/recurring/subscription context" note on cancel words is not part of the list and is handled in the lexical scan. |
| Section 13.1 and 13.2 templates vs `src/messages/templates.ts` | Identical (compared by eye). |

## Not done

- A per-rule re-read of all 514 implementations; status relies on named, passing tests for 503 rows. A named test does not prove the assertion is complete; the lane test titles were not individually audited.
- The Node 22 question (SQ-11) is out of scope; the suite ran on Node 25.9.0.
