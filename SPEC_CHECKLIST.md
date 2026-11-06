# SPEC_CHECKLIST

One line per numbered rule / table row / test ID in spec §§5–20. Every item has exactly one owner.
Reviewed 2026-11-06 against the resolved answers in `SPEC_QUESTIONS.md`, `SPEC_ANSWERS_FOLLOWUP.md`, and the
current request to fix all review findings. See `COMPLIANCE_REPORT.md` for evidence and authorized differences.

Status values: `implemented + tested` (deterministic evidence), `deviates (human-approved; tested)`, and
`implemented; live acceptance pending`. Prompt changes under SQ-L-01 remain conditional on C-514.

## Totals

| Owner | Items | implemented + tested | approved deviation + tested | live acceptance pending |
| --- | --- | --- | --- | --- |
| Lane A | 81 | 81 | 0 | 0 |
| Lane B | 123 | 123 | 0 | 0 |
| Lane C | 73 | 73 | 0 | 0 |
| Lane D | 152 | 152 | 0 | 0 |
| Orchestrator | 85 | 81 | 3 | 1 |
| **Total** | **514** | **510** | **3** | **1** |

The three retained deviations describe approved differences from worked examples/acceptance prose, not open
questions. All six former “implemented, no test” contracts now have passing guard tests. C-514 is implemented;
its final acceptance, including the SQ-L-01 prompt condition, is tracked separately from deterministic tests.

## Items

| ID | Section | Item | Owner | Status |
| --- | --- | --- | --- | --- |
| C-001 | §5 | Stack exactly as §5 (Node 22 ESM strict TS, fastify, SQLCipher, keyring, ajv, viem, chrono, luxon, scure, levenshtein, pdf-parse, html-to-text, pino, vitest) | A | implemented + tested (Node 25 accepted, SQ-11) |
| C-002 | §6.1 | Config read from env AGENT_CONFIG, default ~/.agent-layer/config.json; validated | A | implemented + tested |
| C-003 | §6.1 | Token files: one random 32-byte hex token each, mode 0600, generated on first run if missing | A | implemented + tested |
| C-004 | §6.1 | config.example.json = §6.1 verbatim | O | implemented + tested |
| C-005 | §6.2 | Static tables transcribed verbatim (src/contracts/static-tables.ts) | O | implemented + tested |
| C-006 | §6.2 | Tokens table used (USDC 6 decimals, ETH 18 native, aliases) | B | implemented + tested |
| C-007 | §6.2 | Unsupported tokens → UNSUPPORTED_TOKEN | B | implemented + tested |
| C-008 | §6.2 | Mainnet words used | B | implemented + tested |
| C-009 | §6.2 | Recurrence words used | B | implemented + tested |
| C-010 | §6.2 | Cancel words used | B | implemented + tested |
| C-011 | §6.2 | Back-reference words used | B | implemented + tested |
| C-012 | §6.2 | Distributive words used | B | implemented + tested |
| C-013 | §6.2 | Split words used | B | implemented + tested |
| C-014 | §6.2 | Group markers used | B | implemented + tested |
| C-015 | §6.3 | DB5 default `per_tx_max` inserted on first run | A | implemented + tested |
| C-016 | §6.3 | DB5 default `daily_max` inserted on first run | A | implemented + tested |
| C-017 | §6.3 | DB5 default `autopay_max_per_period` inserted on first run | A | implemented + tested |
| C-018 | §6.3 | DB5 default `autopay_max_weeks` inserted on first run | A | implemented + tested |
| C-019 | §6.3 | DB5 default `max_bridges_per_request` inserted on first run | A | implemented + tested |
| C-020 | §6.3 | DB5 default `allowed_chain_ids` inserted on first run | A | implemented + tested |
| C-021 | §6.3 | DB5 default `eth_gas_reserve` inserted on first run | A | implemented + tested |
| C-022 | §6.3 | DB5 default `bridge_buffer_pct` inserted on first run | A | implemented + tested |
| C-023 | §7 | SQLCipher open with the five pragmas (cipher, key, secure_delete, foreign_keys, WAL) | A | implemented + tested |
| C-024 | §7 | Amounts stored as decimal strings, addresses EIP-55, timestamps ISO-8601 UTC | A | implemented + tested |
| C-025 | §7 | Key: 32 random bytes hex in OS keychain (service agent-layer, account db-key), generated on first run | A | implemented + tested |
| C-026 | §7.1 | schema.sql = §7.1 DDL verbatim | O | implemented + tested (v1 DDL unchanged; authorized additive encrypted journal migration) |
| C-027 | §7.1 | DB1 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-028 | §7.1 | DB2 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-029 | §7.1 | DB3 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-030 | §7.1 | DB4 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-031 | §7.1 | DB5 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-032 | §7.1 | DB6 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-033 | §7.1 | DB7 repository implements src/contracts/repos.ts | A | implemented + tested |
| C-034 | §7.1 | DB8 (sessions, prompts, history) repository implements src/contracts/repos.ts | A | implemented + tested |
| C-035 | §7.1 | DB2 invariant (same name_key ⇒ same address; same address ⇒ same name_key) enforced in a transaction | A | implemented + tested |
| C-036 | §7.1 | DB6 counts_toward_limit = 1 exactly for payment, bridge_buffer, autopay_payment | A | implemented + tested |
| C-037 | §7.1 | Migrations run schema.sql (src/db/migrate.ts) | A | implemented + tested |
| C-038 | §7.2 | DB5 written only by PUT /v1/settings/limits | A | implemented + tested |
| C-039 | §7.2 | DB8 written by session manager (prompts, answers, history) | A | implemented + tested |
| C-040 | §7.2 | DB2 written only by add_contact after explicit "Yes" + name | C | implemented + tested (ENS contact updates approved, SQ-O-07) |
| C-041 | §7.3 | Rule 1: Random source crypto.randomBytes hex lowercase | A | implemented + tested |
| C-042 | §7.3 | Rule 2: Formats amount_/address_/group_ 8 hex; req_/ap_/ses_/q_ 12 hex | A | implemented + tested |
| C-043 | §7.3 | Rule 3: Uniqueness: redraw on PK violation, max 5 tries, then internal error | A | implemented + tested |
| C-044 | §7.3 | Rule 4: Never derived from the value | A | implemented + tested |
| C-045 | §7.3 | Rule 5: One placeholder per phrase/span per request (two amounts → two placeholders; payee twice → two address placeholders) | C | implemented + tested |
| C-046 | §7.3 | Rule 6: Never reused across requests except follow-up refs via history | C | implemented + tested |
| C-047 | §7.3 | Rule 7: Not counters | A | implemented + tested |
| C-048 | §7.4 | Session close: one transaction deletes all rows of DB1, DB3, db8_prompts, db8_history, db8_sessions, then VACUUM; DB2, DB4–DB7 untouched | A | implemented + tested (DB1/DB3/DB8 and journal session history cleared; submission identity persists) |
| C-049 | §8.0 | RequestState and AgentRequest transcribed (src/contracts/types.ts) | O | implemented + tested (additive internal fields; limit_override per SQ-D-16) |
| C-050 | §8.0 | Request lives in memory in session manager; one active request per session; raw texts written to DB8 after S1 passes | A | implemented + tested |
| C-051 | §8.1 | S0 step 1: Parallel eth_getBalance + USDC balanceOf per allowed chain, 10 s timeout | B | implemented + tested |
| C-052 | §8.1 | S0 step 2: Base units → decimal strings with bigint (ETH 18, USDC 6) | B | implemented + tested |
| C-053 | §8.1 | S0 step 3: Upsert DB4 status ok, updated_at now | B | implemented + tested |
| C-054 | §8.1 | S0 step 4: Failure/timeout → both rows unavailable (old values kept, unused) + note | B | implemented + tested |
| C-055 | §8.1 | S0 step 5: All chains unavailable → BALANCES_UNAVAILABLE, FAILED | B | implemented + tested |
| C-056 | §8.1 | S0 runs only for new messages (not answers/confirmations) | B | implemented + tested (also refreshed before first submission, authorized G03) |
| C-057 | §8.2 | S1.1 every pasted block is untrusted content | B | implemented + tested |
| C-058 | §8.2 | S1.1 attachments: text/plain, text/markdown, text/csv (UTF-8), application/pdf (pdf-parse); other → ATTACHMENT_UNSUPPORTED naming file; whole request stops | B | implemented + tested |
| C-059 | §8.2 | S1.1 urls[] plus https URLs in typed text; typed URLs removed and replaced by [link N] | B | implemented + tested |
| C-060 | §8.2 | S1.1 http:// URL → URL_FETCH_FAILED | B | implemented + tested |
| C-061 | §8.2 | S1.2 secret detector: Raw private key regex (also 64-hex tx hashes) | B | implemented + tested |
| C-062 | §8.2 | S1.2 secret detector: Extended key regex + base58check | B | implemented + tested |
| C-063 | §8.2 | S1.2 secret detector: WIF key regex + base58check + 0x80 | B | implemented + tested |
| C-064 | §8.2 | S1.2 secret detector: Solana-style secret regex + 64 bytes | B | implemented + tested |
| C-065 | §8.2 | S1.2 secret detector: Seed phrase: run of ≥12 consecutive BIP-39 words, checksum or not | B | implemented + tested |
| C-066 | §8.2 | S1.2 secret detector: Keystore JSON (crypto/Crypto, ciphertext, kdf) | B | implemented + tested |
| C-067 | §8.2 | S1.2 scan covers typed_text, pasted blocks, attachment text (not fetched pages) | B | implemented + tested (SQ-O-06: URL/redirect/answer screening; B15 malformed escapes) |
| C-068 | §8.2 | S1.2 hit → SECRET_DETECTED; nothing written to DB8/DB1/DB3/logs; buffers dropped | B | implemented + tested |
| C-069 | §8.2 | S1.3 fetch only after scan passes: https GET, timeout, max_redirects each https, max_bytes | B | implemented + tested |
| C-070 | §8.2 | S1.3 refuse private/loopback/link-local ranges (8 ranges listed) | B | implemented + tested |
| C-071 | §8.2 | S1.3 accept text/html (html-to-text), text/plain, application/pdf | B | implemented + tested |
| C-072 | §8.2 | S1.3 any failure → URL_FETCH_FAILED with link number; URLs inside fetched content never fetched | B | implemented + tested |
| C-073 | §8.2 | S1.4 each item ≤ 20,000 chars else DOCUMENT_TOO_LARGE | B | implemented + tested (human-approved SQ-22) |
| C-074 | §8.2 | S1.5 one Q-LLM call per item; invalid → retry once → item yields nothing + note | B | implemented + tested |
| C-075 | §8.2 | S1.5 QItem mapping; bad address/amount → null; all-null entries dropped | B | implemented + tested |
| C-076 | §8.2 | S1.6 persist typed_text (typed) and pasted blocks (pasted) to db8_prompts; attachments/pages not stored | B | implemented + tested |
| C-077 | §8.2 | S1: ENS text records never fetched | B | implemented + tested |
| C-078 | §8.3 | S2 rule 1: Clause split at . ! ? ; newline , and words and/then/also/plus with offsets | B | implemented + tested |
| C-079 | §8.3 | S2 rule 2: Address regex candidates | B | implemented + tested |
| C-080 | §8.3 | S2 rule 3: ENS regex candidates not in email/URL; normalize() failures dropped | B | implemented + tested |
| C-081 | §8.3 | S2 rule 4: Group markers incl. @<domain> and "everyone under X" | B | implemented + tested (also recognizes all X members) |
| C-082 | §8.3 | S2 rule 5: Chain aliases whole-word; eth/ethereum chain only with on/via/over/using or chain/network/l1 | B | implemented + tested |
| C-083 | §8.3 | S2 rule 6: Mainnet word → MAINNET_NOT_SUPPORTED; unknown chain after on/via → UNSUPPORTED_CHAIN | B | implemented + tested |
| C-084 | §8.3 | S2 rule 7: Tokens: usdc aliases, eth/ether/ethereum, fiat USD, fiat OTHER; unsupported token next to number → UNSUPPORTED_TOKEN | B | implemented + tested (B12: digit-glued and complete number-word amounts) |
| C-085 | §8.3 | S2 rule 8: chrono.parse with forwardDate in session tz → spans with kind | B | implemented + tested (B16 local calendar fields; B17 typed range direction) |
| C-086 | §8.3 | S2 rule 9: Recurrence/cancel/back-ref/distributive/split flags; distributive inside recurrence not distributive | B | implemented + tested (also explicit once/twice recurrence forms) |
| C-087 | §8.3 | S2 rule 10: Numeric candidates excluding addresses, ENS, chrono spans, ordinals, counts (times\|weeks\|days\|months\|payments\|x) | B | implemented + tested |
| C-088 | §8.4 | S3 prompt input is unmasked typed_text | B | implemented + tested |
| C-089 | §8.4 | S3.1 phrase must occur verbatim (case-sensitive, first unused occurrence) else dropped | B | implemented + tested |
| C-090 | §8.4 | S3.2 role=context dropped silently; phrase → [amount] in masked texts | B | implemented + tested (B13: context masking requires textual amount evidence) |
| C-091 | §8.4 | S3.3 number must match ^\d+(\.\d+)?$; null → Q_AMOUNT_MISSING | B | implemented + tested |
| C-092 | §8.4 | S3.3 code parse equality; mismatch → Q_AMOUNT_MISMATCH with both values | B | implemented + tested (B01: code zero is compared before minting) |
| C-093 | §8.4 | S3.3 token inference order (a)–(e); fiat OTHER → Q_FIAT_OTHER; fiat USD with ETH → Q_FIAT_OTHER | B | implemented + tested |
| C-094 | §8.4 | S3.3 precision > token decimals → Q_AMOUNT_PRECISION; zero → Q_AMOUNT_MISSING | B | implemented + tested |
| C-095 | §8.4 | S3.4 uncovered numeric candidates → Q_AMOUNT_UNCOVERED (Yes → pay, No → ignore) | B | implemented + tested |
| C-096 | §8.4 | S3.5 mint amount_ per pay item → DB1 (user, phrase, confirmed 1); replace phrase | B | implemented + tested |
| C-097 | §8.4 | S3.6 relative amounts: token, chain choice order, value all/half (round down), 0 → INSUFFICIENT_FUNDS, origin relative, pinned | B | implemented + tested |
| C-098 | §8.4 | S3.7 document amounts only when zero typed pay amounts; Q_UNTRUSTED_AMOUNT each; null token → Q_TOKEN; typed amounts present → note | B | implemented + tested |
| C-099 | §8.4 | S3.8 no pay amounts → continue | B | implemented + tested |
| C-100 | §8.4 | S3 output masked_text_s3 | B | implemented + tested |
| C-101 | §8.5 | S4.1 unsupported → UNSUPPORTED_REQUEST, ANSWERED | B | implemented + tested (human-approved SQ-01) |
| C-102 | §8.5 | S4.2 balance → §13.2 answer, ANSWERED | B | implemented + tested |
| C-103 | §8.5 | S4.3 actions empty → retry once → MODEL_FAILED | B | implemented + tested |
| C-104 | §8.5 | S4.3 remove l if no cancel word | B | implemented + tested |
| C-105 | §8.5 | S4.3 recurrence cross-check → Q_RECURRING; answer sets k/i for clause amounts | B | implemented + tested |
| C-106 | §8.5 | S4.3 i/k without pay amounts → Q_AMOUNT_MISSING | B | implemented + tested |
| C-107 | §8.5 | S4.3 also_balance → balance answer first message of summary response | B | implemented + tested |
| C-108 | §8.5 | S4.3 split words + one amount + ≥2 recipients → SPLIT_UNSUPPORTED (after S5) | B | implemented + tested |
| C-109 | §8.6 | S5 rule 1: span text verbatim in masked_text_s3 else drop | B | implemented + tested (B11 Unicode identifier boundaries) |
| C-110 | §8.6 | S5 rule 2: drop chain/token alias, back-ref word, placeholder, me/my/I | B | implemented + tested (human-approved SQ-O-05; myself also excluded) |
| C-111 | §8.6 | S5 rule 3: address regex; ens/group normalize() else drop | B | implemented + tested |
| C-112 | §8.6 | S5 rule 4: missing S2 candidates added as payee | B | implemented + tested |
| C-113 | §8.6 | S5 rule 5: overlapping spans keep longest | B | implemented + tested |
| C-114 | §8.6 | S5 rule 6: mentioned dropped silently → [person] | B | implemented + tested |
| C-115 | §8.6 | S5 rule 7: follow-up: back-ref + no payee → payee from history (§17.2) | B | implemented + tested |
| C-116 | §8.6 | S5 rule 8: document addresses/ENS become untrusted payees when no payee and no follow-up | B | implemented + tested |
| C-117 | §8.6 | S5 rule 9: actions present and no payees → Q_NO_PAYEE | B | implemented + tested |
| C-118 | §8.7 | S6 resolves payees in order of appearance, one at a time, to ResolvedRecipient | C | implemented + tested |
| C-119 | §8.8 | S7 single → mint address_ + DB3 single row (chain_id pinned or NULL, source) | C | implemented + tested |
| C-120 | §8.8 | S7 group → reuse group_ placeholder from §9.6 | C | implemented + tested |
| C-121 | §8.8 | S7 follow-up refs reuse earlier placeholder (no new row) | C | implemented + tested |
| C-122 | §8.8 | S7 masked_text_s8 (payees → placeholders, mentioned → [person]) | C | implemented + tested (human-approved repeat masking and Q_NAME_ROLE, SQ-O-01/F-12) |
| C-123 | §8.9 | S8 schema: kind enum = actions | D | implemented + tested |
| C-124 | §8.9 | S8 schema: amount enum = confirmed pay placeholders + null | D | implemented + tested |
| C-125 | §8.9 | S8 schema: recipient enum = this request placeholders (single, group, follow-up) | D | implemented + tested |
| C-126 | §8.9 | S8 schema: chain enum = S2 chain IDs + "unstated" | D | implemented + tested |
| C-127 | §8.9 | S8 schema: schedule fields enums | D | implemented + tested |
| C-128 | §8.9 | S8 schema: maxItems = min(50, A×R+R) | D | implemented + tested |
| C-129 | §8.9 | S8 token = DB1 token of amount placeholder | D | implemented + tested |
| C-130 | §8.9 | S8 retry once with CORRECTION: line; second failure → PAIRING_FAILED | D | implemented + tested (G01 explicit chain checks include document-only payments) |
| C-131 | §8.9 | S8 output payments[] in model order | D | implemented + tested |
| C-132 | §8.9 | P1 kind fields | D | implemented + tested |
| C-133 | §8.9 | P2 amount coverage / distributive reuse | D | implemented + tested (human-approved distributive scope, SQ-R-02) |
| C-134 | §8.9 | P3 recipient coverage; no duplicate (amount, recipient) | D | implemented + tested |
| C-135 | §8.9 | P4 clause binding | D | implemented + tested (human-approved relaxed P4 and per-amount questions, SQ-O-03/F-11) |
| C-136 | §8.9 | P5 groups only with i; k+group → GROUP_AUTOPAY_UNSUPPORTED (no retry) | D | implemented + tested |
| C-137 | §8.9 | P6 relative only i/single/once → RELATIVE_AMOUNT_NOT_ALLOWED (no retry) | D | implemented + tested |
| C-138 | §8.9 | P7 untrusted in k → UNTRUSTED_IN_AUTOPAY (no retry) | D | implemented + tested |
| C-139 | §8.9 | P8 split → SPLIT_UNSUPPORTED (no retry) | D | implemented + tested |
| C-140 | §8.9 | P9 chain stated/pinned conflict → CHAIN_CONFLICT (no retry) | D | implemented + tested |
| C-141 | §8.10 | Prompt builder: one function per call returning {system,user,schema}; slots only; fresh chat | B | implemented + tested |
| C-142 | §8.10 | LLM #1 Amounts prompt verbatim | B | implemented + tested (SQ-L-01 system text; live acceptance pending C-514) |
| C-143 | §8.10 | LLM #2 Request type prompt verbatim | B | implemented + tested (SQ-L-01 system text; live acceptance pending C-514) |
| C-144 | §8.10 | LLM #3 Recipient spans prompt verbatim (CANDIDATES) | B | implemented + tested (SQ-L-01 system text; live acceptance pending C-514) |
| C-145 | §8.10 | Q-LLM prompt verbatim | B | implemented + tested |
| C-146 | §8.10 | Call options temperature 0, seed, format schema, stream false | B | implemented + tested |
| C-147 | §8.10 | Retries: error/timeout/invalid → one retry; second → MODEL_FAILED (Q-LLM: item yields nothing) | B | implemented + tested |
| C-148 | §8.10 | LLM #4 Pair payments prompt verbatim with AMOUNTS/RECIPIENTS/DOCUMENT ITEMS/CHAINS/ACTION KINDS/SESSION/correction slots | D | implemented + tested (SQ-L-01 system text; live acceptance pending C-514) |
| C-149 | §8.13 | S11 builds summary from real DB1/DB3/DB4 values, returns awaiting_confirmation | D | implemented + tested |
| C-150 | §8.14 | S12 step 1: swap_back allowlist; amount_ → {value,base_units,decimals}; address_ → checksummed | D | implemented + tested |
| C-151 | §8.14 | S12 step 2: validate against hand-off schema; failure → HANDOFF_INVALID/internal error, FAILED | D | implemented + tested |
| C-152 | §8.14 | S12 step 3: POST /v1/intents with Idempotency-Key = request_id | D | implemented + tested |
| C-153 | §8.14 | S12 step 4: 2xx → DB6 pending rows, DB7 pending per k, db8_history append, HANDED_OFF, reply | D | implemented + tested (authorized journal and DB6/DB7 reservation before external submission) |
| C-154 | §8.14 | S12 step 5: 4xx → EXECUTION_REJECTED with message, FAILED | D | implemented + tested |
| C-155 | §8.14 | S12 step 6: 5xx/timeout → EXECUTION_UNAVAILABLE, HANDOFF_FAILED; same envelope + key; ≤3 attempts then FAILED | A | implemented + tested (F-9 variants; submitted retries preserve durable envelope and key) |
| C-156 | §9 | Every path ends at exactly one address or stops; only loop is "No, re-enter" | C | implemented + tested |
| C-157 | §9.1 | Names 1: name_key normalisation | C | implemented + tested |
| C-158 | §9.1 | Names 2: DB2 hit → contact (stored name, source contact, chains) + ENS re-check when ens_name | C | implemented + tested |
| C-159 | §9.1 | Names 3: no rows + contains "." → ENS flow | C | implemented + tested |
| C-160 | §9.1 | Names 4: no rows → Q_WHO_IS with ≤3 Levenshtein ≤2 chips (distance, then alpha) + free input | C | implemented + tested (human-approved SQ-09) |
| C-161 | §9.1 | Names 4a: contact chip → resolved, no alias saved | C | implemented + tested |
| C-162 | §9.1 | Names 4b: address typed → §9.2 with suggested name | C | implemented + tested |
| C-163 | §9.1 | Names 4c: ENS typed → §9.3 | C | implemented + tested |
| C-164 | §9.1 | Names 4d: anything else → re-ask | C | implemented + tested |
| C-165 | §9.2 | Addresses 1: ^0x[0-9a-fA-F]{40}$; bad mixed-case checksum → re-ask; all-lower/upper accepted + checksummed | C | implemented + tested |
| C-166 | §9.2 | Addresses 2: zero address → re-ask | C | implemented + tested |
| C-167 | §9.2 | Addresses 3: wallet.address → SELF_PAYMENT | C | implemented + tested |
| C-168 | §9.2 | Addresses 4: in DB2 → known contact | C | implemented + tested |
| C-169 | §9.2 | Addresses 5: not in DB2 → Q_ADDRESS_CORRECT with emphasis; untrusted wording | C | implemented + tested (human-approved SQ-06) |
| C-170 | §9.2 | Addresses 5a: No, re-enter → Q_ADDRESS_REENTER → step 1 | C | implemented + tested |
| C-171 | §9.2 | Addresses 5b: Yes → Q_NAME_FOR_ADDRESS prefilled | C | implemented + tested (human-approved SQ-03) |
| C-172 | §9.2 | Addresses 5c: untrusted only: "Don't pay this one" removes payee; none left → Q_NO_PAYEE | C | implemented + tested |
| C-173 | §9.2 | Addresses 6: name rules (1–32 chars, charset, not alias/back-ref/0x, unique) | C | implemented + tested |
| C-174 | §9.2 | Addresses 7: add_contact rows for every allowed chain, ens_name NULL; source user/untrusted | C | implemented + tested |
| C-175 | §9.3 | ENS 1: normalize(); failure → Q_WHO_IS invalid-ENS wording | C | implemented + tested |
| C-176 | §9.3 | ENS 2: DB2 by ens_name → contact + re-check | C | implemented + tested |
| C-177 | §9.3 | ENS 3a: target chain known → query that chain | C | implemented + tested |
| C-178 | §9.3 | ENS 3b: not known → every allowed ok chain | C | implemented + tested |
| C-179 | §9.3 | ENS 3c: coinType 60 Sepolia / 0x80000000\|chainId L2; fallback 0x80000000; else none | C | implemented + tested |
| C-180 | §9.3 | ENS 4: no address anywhere → Q_ADDRESS_REENTER ENS wording | C | implemented + tested |
| C-181 | §9.3 | ENS 5: all equal → one address valid on those chains | C | implemented + tested |
| C-182 | §9.3 | ENS 6: differ → Q_ENS_CHAIN, pins chain | C | implemented + tested |
| C-183 | §9.3 | ENS 7: continue §9.2 steps 3–5 with ENS wording; name prefilled with first label; add_contact only matched chains with ens_name; source ens | C | implemented + tested |
| C-184 | §9.4 | ENS re-check: Same address → continue | C | implemented + tested |
| C-185 | §9.4 | ENS re-check: Different → Q_ENS_CHANGED (use new: update all rows / keep / cancel → DISCARDED) | C | implemented + tested |
| C-186 | §9.4 | ENS re-check: No address now → variant (keep / cancel) | C | implemented + tested |
| C-187 | §9.4 | ENS re-check: RPC unavailable → saved address + note | C | implemented + tested |
| C-188 | §9.5 | Silent reuse in S9: no DB2 write, DB3 reused_from_chain_id, summary note; never for ENS-pinned | D | implemented + tested |
| C-189 | §9.6 | Group 1: parent normalize(); failure → Q_GROUP_PARENT | C | implemented + tested |
| C-190 | §9.6 | Group 2: chain: one chain word in clause/prompt else Q_GROUP_CHAIN | C | implemented + tested |
| C-191 | §9.6 | Group 3: list_subnames via SubnameSource, direct children, 1,000 per page, reference query; error/timeout → ENS_INDEXER_UNAVAILABLE | C | implemented + tested |
| C-192 | §9.6 | Group 4: parent not in ENS → Q_GROUP_PARENT not-in-ENS wording | C | implemented + tested |
| C-193 | §9.6 | Group 5: zero subnames → GROUP_EMPTY | C | implemented + tested |
| C-194 | §9.6 | Group 6: resolve members 8 in parallel, 10 s each; unresolvable → can't pay | C | implemented + tested |
| C-195 | §9.6 | Group 7: exclude self (note); dedupe by address keep alphabetically first (note) | C | implemented + tested (human-approved SQ-07) |
| C-196 | §9.6 | Group 8: no payable → GROUP_EMPTY | C | implemented + tested |
| C-197 | §9.6 | Group 9: Q_GROUP_MEMBERS multiselect, preselected, disabled unpayable, count/total; zero → re-ask | C | implemented + tested (human-approved SQ-05) |
| C-198 | §9.6 | Group 10: DB3 group row + member rows; never DB2 | C | implemented + tested |
| C-199 | §9.6 | Group 11: no size cap | C | implemented + tested |
| C-200 | §9.7 | Questions one at a time in payee order | C | implemented + tested |
| C-201 | §9.7 | Attempt counter: first ask + ≤3 re-asks; 4th failure → TOO_MANY_RETRIES | A | implemented + tested |
| C-202 | §10.1 | spendable formula (DB4 − pending 10 min kinds − ETH gas reserve, max 0); unavailable chains excluded; stated/pinned unavailable chain → BALANCES_UNAVAILABLE | D | implemented + tested |
| C-203 | §10.1 | bigint base-unit arithmetic; display without trailing zeros | D | implemented + tested |
| C-204 | §10.2 | Expand 1: group payments expand to one i per selected member, alphabetical, at group position | D | implemented + tested |
| C-205 | §10.2 | Expand 2: k schedule and caps first (prefund = total_cap) | D | implemented + tested |
| C-206 | §10.2 | Expand 3: l gets autopay from DB7 | D | implemented + tested |
| C-207 | §10.3 | Chain 1: pinned → that chain | D | implemented + tested |
| C-208 | §10.3 | Chain 2: stated → must be allowed (CHAIN_NOT_ALLOWED) and ok | D | implemented + tested |
| C-209 | §10.3 | Chain 3: candidates by source; largest spendable−assigned ≥ need; ties allowed order | D | implemented + tested |
| C-210 | §10.3 | Chain 4: contact with none qualifying → extend to all ok chains (silent reuse) | D | implemented + tested |
| C-211 | §10.3 | Chain 5: still none → largest spendable−assigned; shortfall bridged | D | implemented + tested |
| C-212 | §10.3 | Chain 6: add need to assigned; mark silent reuse | D | implemented + tested |
| C-213 | §10.4 | Bridge algorithm (short/surplus, deliverable floor, padded ceil, DB1 bridge_padded mint) | D | implemented + tested |
| C-214 | §10.4 | INSUFFICIENT_FUNDS lists per-chain spendable vs needed | D | implemented + tested (SQ-08/F-10: positive chain balances; R4-F4: need includes per-bridge padding) |
| C-215 | §10.4 | > max_bridges_per_request → LIMIT_BRIDGES | D | implemented + tested (human-approved named one-request limit consent, SQ-D-16/F-1…F-6) |
| C-216 | §10.4 | j buffer counts toward daily limit | D | implemented + tested |
| C-217 | §10.4 | Gas check per touched chain → NO_GAS | D | implemented + tested |
| C-218 | §10.5 | Order 1: steps from 0, no gaps | D | implemented + tested |
| C-219 | §10.5 | Order 2: j first ordered by first needing payment then source allowed order | D | implemented + tested |
| C-220 | §10.5 | Order 3: then i/k/l in payment order (groups in place) | D | implemented + tested |
| C-221 | §10.5 | Order 4: i/k depends_on = j steps with dest = chain and same token | D | implemented + tested |
| C-222 | §10.5 | Order 5: j funds_steps | D | implemented + tested |
| C-223 | §10.5 | Order 6: l no depends_on | D | implemented + tested |
| C-224 | §10.6 | Schedule field: frequency (null → Q_AUTOPAY_FREQUENCY; times_per_week 7 → daily) | D | implemented + tested |
| C-225 | §10.6 | Schedule field: interval (null → 1) | D | implemented + tested |
| C-226 | §10.6 | Schedule field: days_of_week (named win; times_per_week table; else today) | D | implemented + tested |
| C-227 | §10.6 | Schedule field: day_of_month (S8 else today; 29–31 → 28 + note) | D | implemented + tested |
| C-228 | §10.6 | Schedule field: time_of_day (chrono in clause else default 10:00) | D | implemented + tested |
| C-229 | §10.6 | Schedule field: timezone = session | D | implemented + tested |
| C-230 | §10.6 | Schedule field: start_date (chrono start else today; past → Q_AUTOPAY_START); first occurrence ≥ start and strictly after now | D | implemented + tested (SQ-R-05: late start asks again before first submission) |
| C-231 | §10.6 | Schedule field: end (after_count / on_date N units −1 day / until / until_cancelled; nothing → Q_AUTOPAY_END → COUNT/DATE) | D | implemented + tested |
| C-232 | §10.6 | Derived 1: occurrences enumeration with interval and end | D | implemented + tested |
| C-233 | §10.6 | Derived 2: zero → AUTOPAY_NO_OCCURRENCES | D | implemented + tested |
| C-234 | §10.6 | Derived 3: beyond max weeks → LIMIT_AUTOPAY_DURATION | D | implemented + tested |
| C-235 | §10.6 | Derived 4: per_period_cap and LIMIT_AUTOPAY_PERIOD | D | implemented + tested (human-approved short cap min(window cap, total cap), SQ-R-03) |
| C-236 | §10.6 | Derived 5: amount_per_payment ≤ per_tx_max → LIMIT_PER_TX | D | implemented + tested |
| C-237 | §10.6 | Derived 6: total_cap = amount × occurrences = prefund | D | implemented + tested |
| C-238 | §10.6 | Derived 7: caps minted in DB1 derived | D | implemented + tested |
| C-239 | §10.6 | Derived 8: expires_at 23:59:59 last date in tz as UTC | D | implemented + tested (human-approved SQ-D-15) |
| C-240 | §10.6 | Derived 9: cron strings daily/weekly/monthly | D | implemented + tested |
| C-241 | §10.6 | Derived 10: autopay_id minted | D | implemented + tested |
| C-242 | §10.7 | Cancel 1: find_autopays by recipient active | D | implemented + tested |
| C-243 | §10.7 | Cancel 2: pending only → AUTOPAY_NOT_READY; none → NO_ACTIVE_AUTOPAY | D | implemented + tested |
| C-244 | §10.7 | Cancel 3: several → Q_AUTOPAY_PICK | D | implemented + tested |
| C-245 | §10.7 | Cancel 4: l takes autopay_id, chain_id, delegate from DB7; refund_remaining true | D | implemented + tested |
| C-246 | §11 | V-01 | D | implemented + tested |
| C-247 | §11 | V-02 | D | implemented + tested |
| C-248 | §11 | V-03 | D | implemented + tested |
| C-249 | §11 | V-04 | D | implemented + tested |
| C-250 | §11 | V-05 | D | implemented + tested |
| C-251 | §11 | V-06 | D | implemented + tested |
| C-252 | §11 | V-07 | D | implemented + tested |
| C-253 | §11 | V-08 | D | implemented + tested |
| C-254 | §11 | V-09 | D | implemented + tested |
| C-255 | §11 | V-10 | D | implemented + tested |
| C-256 | §11 | V-11 | D | implemented + tested |
| C-257 | §11 | V-12 | D | implemented + tested |
| C-258 | §11 | V-13 | D | implemented + tested |
| C-259 | §11 | V-14 | D | implemented + tested |
| C-260 | §11 | V-15 | D | implemented + tested |
| C-261 | §11.1 | INTERNAL_ERROR logs rule ID, user message, FAILED | D | implemented + tested |
| C-262 | §11.4 | DB6 at hand-off: i → payment row counts 1 | D | implemented + tested |
| C-263 | §11.4 | DB6 at hand-off: j → bridge_out (0) + bridge_buffer (1) | D | implemented + tested |
| C-264 | §11.4 | DB6 at hand-off: k → autopay_prefund (0) | D | implemented + tested |
| C-265 | §11.4 | DB6 at hand-off: l → none | D | implemented + tested (no DB6 spend for l; authorized durable journal records l identity) |
| C-266 | §11.4 | autopay_payment reports inserted executed, counts 1 | A | implemented + tested (SQ-R-04 duplicate hashes ignored; authorized report correlation) |
| C-267 | §12.1 | amounts schema verbatim | O | implemented + tested |
| C-268 | §12.1 | request-type schema verbatim | O | implemented + tested |
| C-269 | §12.1 | recipient-spans schema verbatim | O | implemented + tested |
| C-270 | §12.1 | quarantine schema verbatim | O | implemented + tested |
| C-271 | §12.1 | Shared Ajv 2020 strict allErrors + formats | O | implemented + tested |
| C-272 | §12.2 | S8 template builder (slots) | O | implemented + tested |
| C-273 | §12.3 | Internal plan types + generated internal-plan.schema.json | O | implemented + tested |
| C-274 | §12.5 | Hand-off envelope schema verbatim | O | implemented + tested |
| C-275 | §12.5 | token_address rule (usdc_address / null; j both) | D | implemented + tested |
| C-276 | §12.5 | base_units via bigint; value no trailing zeros | D | implemented + tested |
| C-277 | §12.5 | addresses checksummed before validation | D | implemented + tested |
| C-278 | §12.5 | prefund = limits.total_cap | D | implemented + tested |
| C-279 | §13.1 | Summary: j line | D | implemented + tested |
| C-280 | §13.1 | Summary: i line + "After step n." | D | implemented + tested |
| C-281 | §13.1 | Summary: i group collapsed line | D | implemented + tested |
| C-282 | §13.1 | Summary: k line | D | implemented + tested |
| C-283 | §13.1 | Summary: l line | D | implemented + tested |
| C-284 | §13.1 | Summary: {Name} precedence | D | implemented + tested |
| C-285 | §13.1 | Summary: {cadence} forms | D | implemented + tested |
| C-286 | §13.1 | Summary: {end text} forms | D | implemented + tested |
| C-287 | §13.1 | Summary: Footer per token | D | implemented + tested |
| C-288 | §13.1 | Summary: "Please confirm:" / "Confirm?" framing | D | implemented + tested |
| C-289 | §13.1 | Summary: Address display 0x+4…4, amounts no trailing zeros, chain display names | D | implemented + tested |
| C-290 | §13.1 | Note emitted: Same address as on {Chain} | D | implemented + tested |
| C-291 | §13.1 | Note emitted: Recipient and chain from your last payment | D | implemented + tested |
| C-292 | §13.1 | Note emitted: You wrote '{phrase}' → … | D | implemented + tested |
| C-293 | §13.1 | Note emitted: From attached content … | D | implemented + tested |
| C-294 | §13.1 | Note emitted: {Chain} balance couldn't be read … | B | implemented + tested |
| C-295 | §13.1 | Note emitted: Couldn't re-check {ens} … | C | implemented + tested |
| C-296 | §13.1 | Note emitted: Paid on the 28th … | D | implemented + tested |
| C-297 | §13.1 | Note emitted: Skipped {name}: … | C | implemented + tested |
| C-298 | §13.1 | Note emitted: Today's limit was lifted once … | D | implemented + tested (human-approved generalized override note, SQ-D-16/F-2) |
| C-299 | §13.1 | Note emitted: Amounts in the attached content weren't used | B | implemented + tested |
| C-300 | §13.1 | Note emitted: Couldn't read anything usable from {item} | B | implemented + tested |
| C-301 | §13.2 | Balance answer format; every allowed chain in order; raw ETH + spendable; totals | D | implemented + tested |
| C-302 | §13.3 | Reply: Sent to your wallet for signing. | D | implemented + tested |
| C-303 | §13.3 | Reply: OK, I've dropped that… | A | implemented + tested |
| C-304 | §13.3 | Reply: Cancelled. Nothing was sent. | A | implemented + tested (F-8 old handoff reply; SQ-R-06 ambiguous timeout cancellation) |
| C-305 | §13.3 | Reply: I dropped the previous plan… (prepended) | A | implemented + tested |
| C-306 | §13.4 | Question JSON shape; texts and fixed chips in catalog; chip answer parsing (matchChip) | O | implemented + tested (28 codes; approved Q_LIMIT_OVERRIDE/Q_PAIR_AMOUNT/Q_NAME_ROLE and SQ-CX-01 copy) |
| C-307 | §13.4 | Q_AMOUNT_MISSING: asked when specified; answer validated; effect applied | B | implemented + tested (human-approved SQ-09) |
| C-308 | §13.4 | Q_AMOUNT_MISMATCH: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-309 | §13.4 | Q_AMOUNT_UNCOVERED: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-310 | §13.4 | Q_AMOUNT_PRECISION: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-311 | §13.4 | Q_TOKEN: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-312 | §13.4 | Q_FIAT_OTHER: asked when specified; answer validated; effect applied | B | implemented + tested (human-approved SQ-09) |
| C-313 | §13.4 | Q_UNTRUSTED_AMOUNT: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-314 | §13.4 | Q_RECURRING: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-315 | §13.4 | Q_NO_PAYEE: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-316 | §13.4 | Q_FOLLOWUP_WHO: asked when specified; answer validated; effect applied | B | implemented + tested |
| C-317 | §13.4 | Q_WHO_IS: asked when specified; answer validated; effect applied | C | implemented + tested (human-approved SQ-09) |
| C-318 | §13.4 | Q_ADDRESS_CORRECT: asked when specified; answer validated; effect applied | C | implemented + tested (human-approved SQ-06) |
| C-319 | §13.4 | Q_ADDRESS_REENTER: asked when specified; answer validated; effect applied | C | implemented + tested |
| C-320 | §13.4 | Q_NAME_FOR_ADDRESS: asked when specified; answer validated; effect applied | C | implemented + tested (human-approved SQ-03) |
| C-321 | §13.4 | Q_ENS_CHAIN: asked when specified; answer validated; effect applied | C | implemented + tested |
| C-322 | §13.4 | Q_ENS_CHANGED: asked when specified; answer validated; effect applied | C | implemented + tested (human-approved SQ-15) |
| C-323 | §13.4 | Q_GROUP_PARENT: asked when specified; answer validated; effect applied | C | implemented + tested |
| C-324 | §13.4 | Q_GROUP_CHAIN: asked when specified; answer validated; effect applied | C | implemented + tested |
| C-325 | §13.4 | Q_GROUP_MEMBERS: asked when specified; answer validated; effect applied | C | implemented + tested |
| C-326 | §13.4 | Q_GROUP_OVER_LIMIT: asked when specified; answer validated; effect applied | D | implemented + tested (human-approved replacement by Q_LIMIT_OVERRIDE, SQ-D-16/F-2/SQ-CX-01) |
| C-327 | §13.4 | Q_AUTOPAY_FREQUENCY: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-328 | §13.4 | Q_AUTOPAY_START: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-329 | §13.4 | Q_AUTOPAY_END: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-330 | §13.4 | Q_AUTOPAY_COUNT: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-331 | §13.4 | Q_AUTOPAY_DATE: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-332 | §13.4 | Q_AUTOPAY_PICK: asked when specified; answer validated; effect applied | D | implemented + tested |
| C-333 | §13.4 | Number answers via S3 code parser (parseAmountText) | B | implemented + tested |
| C-334 | §13.4 | Address answers via §9.2 step 1; ENS typed where address asked → §9.3 | C | implemented + tested |
| C-335 | §13.4 | Date answers via chrono in session tz | D | implemented + tested |
| C-336 | §14.1 | API: Bearer UI token on every route | A | implemented + tested |
| C-337 | §14.1 | API: JSON bodies, base64 attachments, max body 20 MB | A | implemented + tested |
| C-338 | §14.1 | API: AgentResponse shape; HTTP 200 unless request invalid | A | implemented + tested |
| C-339 | §14.1 | API: POST /v1/sessions (timezone IANA, invalid → 400; closes open session) | A | implemented + tested |
| C-340 | §14.1 | API: DELETE /v1/sessions/{id} (204; unknown → 404) | A | implemented + tested |
| C-341 | §14.1 | API: POST /v1/sessions/{id}/messages | A | implemented + tested |
| C-342 | §14.1 | API: POST /v1/sessions/{id}/answers (stale question_id → 409) | A | implemented + tested |
| C-343 | §14.1 | API: POST /v1/sessions/{id}/confirm (409 rules) | A | implemented + tested |
| C-344 | §14.1 | API: POST /v1/sessions/{id}/cancel | A | implemented + tested |
| C-345 | §14.1 | API: GET /v1/settings/limits | A | implemented + tested |
| C-346 | §14.1 | API: PUT /v1/settings/limits validation (400 field errors) | A | implemented + tested |
| C-347 | §14.1 | API: GET /v1/health {ok, ollama, db} | A | implemented + tested |
| C-348 | §14.1 | API: Concurrent call same session → 409 | A | implemented + tested |
| C-349 | §14.2 | Execution client: headers (Bearer outbound token, Idempotency-Key, JSON); 2xx accepted; 4xx message; 5xx/timeout unavailable | D | implemented + tested |
| C-350 | §14.3 | Reports: Report auth: execution report token | A | implemented + tested |
| C-351 | §14.3 | Reports: intent_result updates DB6; k → DB7 active + delegate/cre_job_id (or failed); l → cancelled | A | implemented + tested |
| C-352 | §14.3 | Reports: autopay_payment inserts DB6 row | A | implemented + tested |
| C-353 | §14.3 | Reports: autopay_status updates DB7 | A | implemented + tested |
| C-354 | §14.3 | Reports: unknown id → 404; malformed → 400; success → 204 | A | implemented + tested |
| C-355 | §14.4 | Ollama /api/chat request shape; parse message.content; Ajv validate | B | implemented + tested (SQ-L-01 valid action-kind deduplication before unchanged schema validation) |
| C-356 | §14.4 | Startup GET /api/tags check; missing model → health ollama false and every request MODEL_FAILED | B | implemented + tested |
| C-357 | §14.5 | One viem public client per chain, http(rpc_url), 10 s, no retries | B | implemented + tested |
| C-358 | §14.5 | ENS client on ens.rpc_chain_id with universalResolverAddress | C | implemented + tested |
| C-359 | §14.5 | Indexer HTTPS POST GraphQL, 10 s timeout | C | implemented + tested |
| C-360 | §15 | SECRET_DETECTED raised in its stated case with catalog message | B | implemented + tested |
| C-361 | §15 | ATTACHMENT_UNSUPPORTED raised in its stated case with catalog message | B | implemented + tested |
| C-362 | §15 | URL_FETCH_FAILED raised in its stated case with catalog message | B | implemented + tested |
| C-363 | §15 | DOCUMENT_TOO_LARGE raised in its stated case with catalog message | B | implemented + tested (human-approved SQ-22) |
| C-364 | §15 | BALANCES_UNAVAILABLE raised in its stated case with catalog message | B | implemented + tested |
| C-365 | §15 | MAINNET_NOT_SUPPORTED raised in its stated case with catalog message | B | implemented + tested |
| C-366 | §15 | UNSUPPORTED_CHAIN raised in its stated case with catalog message | B | implemented + tested |
| C-367 | §15 | UNSUPPORTED_TOKEN raised in its stated case with catalog message | B | implemented + tested |
| C-368 | §15 | UNSUPPORTED_REQUEST raised in its stated case with catalog message | B | implemented + tested (human-approved SQ-01) |
| C-369 | §15 | SPLIT_UNSUPPORTED raised in its stated case with catalog message | D | implemented + tested |
| C-370 | §15 | RELATIVE_AMOUNT_NOT_ALLOWED raised in its stated case with catalog message | D | implemented + tested |
| C-371 | §15 | GROUP_AUTOPAY_UNSUPPORTED raised in its stated case with catalog message | D | implemented + tested |
| C-372 | §15 | UNTRUSTED_IN_AUTOPAY raised in its stated case with catalog message | D | implemented + tested |
| C-373 | §15 | CHAIN_CONFLICT raised in its stated case with catalog message | D | implemented + tested |
| C-374 | §15 | PAIRING_FAILED raised in its stated case with catalog message | D | implemented + tested |
| C-375 | §15 | SELF_PAYMENT raised in its stated case with catalog message | C | implemented + tested |
| C-376 | §15 | ENS_INDEXER_UNAVAILABLE raised in its stated case with catalog message | C | implemented + tested |
| C-377 | §15 | GROUP_EMPTY raised in its stated case with catalog message | C | implemented + tested |
| C-378 | §15 | NO_ACTIVE_AUTOPAY raised in its stated case with catalog message | D | implemented + tested |
| C-379 | §15 | AUTOPAY_NOT_READY raised in its stated case with catalog message | D | implemented + tested |
| C-380 | §15 | AUTOPAY_NO_OCCURRENCES raised in its stated case with catalog message | D | implemented + tested |
| C-381 | §15 | INSUFFICIENT_FUNDS raised in its stated case with catalog message | D | implemented + tested (SQ-08/F-10 positive chain list; per-bridge padded need) |
| C-382 | §15 | NO_GAS raised in its stated case with catalog message | D | implemented + tested |
| C-383 | §15 | CHAIN_NOT_ALLOWED raised in its stated case with catalog message | D | implemented + tested |
| C-384 | §15 | LIMIT_PER_TX raised in its stated case with catalog message | D | implemented + tested |
| C-385 | §15 | LIMIT_DAILY raised in its stated case with catalog message | D | implemented + tested |
| C-386 | §15 | LIMIT_AUTOPAY_PERIOD raised in its stated case with catalog message | D | implemented + tested |
| C-387 | §15 | LIMIT_AUTOPAY_DURATION raised in its stated case with catalog message | D | implemented + tested |
| C-388 | §15 | LIMIT_BRIDGES raised in its stated case with catalog message | D | implemented + tested |
| C-389 | §15 | TOO_MANY_RETRIES raised in its stated case with catalog message | A | implemented + tested |
| C-390 | §15 | MODEL_FAILED raised in its stated case with catalog message | B | implemented + tested |
| C-391 | §15 | EXECUTION_REJECTED raised in its stated case with catalog message | D | implemented + tested |
| C-392 | §15 | EXECUTION_UNAVAILABLE raised in its stated case with catalog message | D | implemented + tested (human-approved third-attempt variants, SQ-A-06/F-9) |
| C-393 | §15 | INTERNAL_ERROR raised in its stated case with catalog message | D | implemented + tested |
| C-394 | §15 | CANCELLED raised in its stated case with catalog message | A | implemented + tested |
| C-395 | §15 | All 35 error messages verbatim in catalog | O | implemented + tested (34 literal base messages; approved F-7/F-9/F-10 variants) |
| C-396 | §15 | Errors returned in AgentResponse.error with state "error"; FAILED or ANSWERED for refusals | A | implemented + tested |
| C-397 | §16.1 | Q-LLM values used only when typed text has no amounts / no payees | B | implemented + tested |
| C-398 | §16.1 | Each untrusted amount needs Q_UNTRUSTED_AMOUNT | B | implemented + tested |
| C-399 | §16.1 | Q-LLM output never in a P-LLM prompt except as placeholder (LLM #1–#3 builders) | B | implemented + tested |
| C-400 | §16.1 | Each untrusted address via Q_ADDRESS_CORRECT with content wording unless saved contact | C | implemented + tested |
| C-401 | §16.1 | Untrusted never fills k (unless saved contact); LLM #4 builder uses placeholders only for content values | D | implemented + tested |
| C-402 | §16.2 | Only §12.5 fields reach execution layer (swap_back allowlist) | D | implemented + tested |
| C-403 | §16.2 | Names/ENS/summary never sent to execution layer | D | implemented + tested |
| C-404 | §16.2 | Context amounts / mentioned names dropped at S3/S5 (no DB, no later model call) | B | implemented + tested |
| C-405 | §16.3 | Name rules reject injection-like names | C | implemented + tested |
| C-406 | §16.3 | No DB5 chat write path | A | implemented + tested |
| C-407 | §16.4 | HTTP bound to 127.0.0.1; tokens from 0600 files; UI and report tokens differ | A | implemented + tested |
| C-408 | §16.4 | secure_delete + VACUUM after session clears | A | implemented + tested |
| C-409 | §16.4 | Outbound requests only to Ollama, RPC URLs, user https URLs (fetcher) | B | implemented + tested |
| C-410 | §17.1 | One open session; no idle timeout | A | implemented + tested |
| C-411 | §17.1 | Close clears every row of DB1/DB3/DB8; in-progress request DISCARDED; handed-off unaffected | A | implemented + tested |
| C-412 | §17.2 | Step 1: history = last 5 db8_history rows of session | A | implemented + tested |
| C-413 | §17.2 | Step 2: follow-up = back-ref word and no payee | B | implemented + tested |
| C-414 | §17.2 | Step 3: previous single payees of most recent entry; one → use; several → Q_FOLLOWUP_WHO; none → Q_NO_PAYEE | B | implemented + tested |
| C-415 | §17.2 | Step 5: new amount always required (no pay amount → Q_AMOUNT_MISSING) | B | implemented + tested |
| C-416 | §17.2 | Step 6: token fallback to previous payment token | B | implemented + tested |
| C-417 | §17.2 | Step 4a: chosen payee placeholder offered to S8 under SESSION, no new DB3 row | C | implemented + tested |
| C-418 | §17.2 | Step 4b: "unstated" chain → previous chain as stated | D | implemented + tested |
| C-419 | §17.2 | Step 7: follow-up summary note | D | implemented + tested |
| C-420 | §17.3 | Table: Awaiting answer + answers call → validate, attempt+1, TOO_MANY_RETRIES after 4th | A | implemented + tested |
| C-421 | §17.3 | Table: Awaiting answer + messages call → free-text answer | A | implemented + tested |
| C-422 | §17.3 | Table: Cancel texts or cancel endpoint → DISCARDED, CANCELLED | A | implemented + tested (human-approved SQ-18) |
| C-423 | §17.3 | Table: Awaiting confirmation + yes texts/confirm yes → S12 | A | implemented + tested (authorized pre-submit balance/settings/limit revalidation, G03) |
| C-424 | §17.3 | Table: Awaiting confirmation + no texts/confirm no → DISCARDED + reply | A | implemented + tested (human-approved SQ-18) |
| C-425 | §17.3 | Table: Awaiting confirmation + other text → discard + new request + prepend line | A | implemented + tested |
| C-426 | §17.3 | Table: HANDOFF_FAILED + confirm yes → retry S12 ≤3 total | A | implemented + tested (authorized immutable retry after ambiguous submission, B19) |
| C-427 | §17.3 | Discarded/cancelled requests keep DB1/DB3 rows but are never written to db8_history | A | implemented + tested |
| C-428 | §18 | pino JSON to ~/.agent-layer/logs/agent.log, rotate 10 MB × 5, level info | A | implemented + tested |
| C-429 | §18 | Allowlist serializer drops every other field; no debug mode | A | implemented + tested |
| C-430 | §18 | Never-logged values (prompt, answers, amounts, addresses, names, ENS, tx hashes, LLM IO, documents, URLs) | A | implemented + tested |
| C-431 | §18 | Metrics counters in logs (final states, question codes, LLM retries, pairing failures, hand-off failures) | A | implemented + tested |
| C-432 | §19 | E1 reproduced by acceptance tests | O | implemented + tested |
| C-433 | §19 | E2 reproduced by acceptance tests | O | implemented + tested |
| C-434 | §19 | E3 reproduced by acceptance tests | O | implemented + tested |
| C-435 | §19 | E4 reproduced by acceptance tests | O | implemented + tested |
| C-436 | §19 | E5 reproduced by acceptance tests | O | implemented + tested |
| C-437 | §19 | E6 reproduced by acceptance tests | O | deviates (human-approved SQ-D-15: expiry on last occurrence date; tested) |
| C-438 | §19 | E7 reproduced by acceptance tests | O | implemented + tested |
| C-439 | §19 | E8 reproduced by acceptance tests | O | implemented + tested |
| C-440 | §19 | E9 reproduced by acceptance tests | O | deviates (human-approved SQ-D-16: default invoice limit applies; A-15 raises fixture limit; tested) |
| C-441 | §19 | E10 reproduced by acceptance tests | O | implemented + tested |
| C-442 | §20.1 | Unit tests: guard/secrets (every "must cover" item) | B | implemented + tested |
| C-443 | §20.1 | Unit tests: lexical (every "must cover" item) | B | implemented + tested |
| C-444 | §20.1 | Unit tests: amounts/parser (every "must cover" item) | B | implemented + tested |
| C-445 | §20.1 | Unit tests: amounts/verify (every "must cover" item) | B | implemented + tested |
| C-446 | §20.1 | Unit tests: recipients (every "must cover" item) | C | implemented + tested |
| C-447 | §20.1 | Unit tests: pairing/checks (every "must cover" item) | D | implemented + tested |
| C-448 | §20.1 | Unit tests: plan (every "must cover" item) | D | implemented + tested |
| C-449 | §20.1 | Unit tests: schedule (every "must cover" item) | D | implemented + tested |
| C-450 | §20.1 | Unit tests: validate (every "must cover" item) | D | implemented + tested |
| C-451 | §20.1 | Unit tests: handoff (every "must cover" item) | D | implemented + tested |
| C-452 | §20.1 | Unit tests: session (every "must cover" item) | A | implemented + tested |
| C-453 | §20.1 | Unit tests: logging (every "must cover" item) | A | implemented + tested |
| C-454 | §20.2 | A-01 | O | implemented + tested |
| C-455 | §20.2 | A-02 | O | implemented + tested |
| C-456 | §20.2 | A-03 | O | implemented + tested |
| C-457 | §20.2 | A-04 | O | implemented + tested |
| C-458 | §20.2 | A-05 | O | implemented + tested |
| C-459 | §20.2 | A-06 | O | implemented + tested |
| C-460 | §20.2 | A-07 | O | implemented + tested |
| C-461 | §20.2 | A-08 | O | implemented + tested (human-approved SQ-D-15) |
| C-462 | §20.2 | A-09 | O | implemented + tested |
| C-463 | §20.2 | A-10 | O | implemented + tested |
| C-464 | §20.2 | A-11 | O | implemented + tested |
| C-465 | §20.2 | A-12 | O | implemented + tested |
| C-466 | §20.2 | A-13 | O | implemented + tested |
| C-467 | §20.2 | A-14 | O | implemented + tested |
| C-468 | §20.2 | A-15 | O | implemented + tested (human-approved SQ-D-16) |
| C-469 | §20.2 | A-16 | O | implemented + tested |
| C-470 | §20.2 | A-17 | O | implemented + tested |
| C-471 | §20.2 | A-18 | O | implemented + tested |
| C-472 | §20.2 | A-19 | O | implemented + tested |
| C-473 | §20.2 | A-20 | O | implemented + tested |
| C-474 | §20.2 | A-21 | O | implemented + tested |
| C-475 | §20.2 | A-22 | O | implemented + tested |
| C-476 | §20.2 | A-23 | O | implemented + tested |
| C-477 | §20.2 | A-24 | O | implemented + tested |
| C-478 | §20.2 | A-25 | O | implemented + tested |
| C-479 | §20.2 | A-26 | O | implemented + tested |
| C-480 | §20.2 | A-27 | O | implemented + tested |
| C-481 | §20.2 | A-28 | O | implemented + tested |
| C-482 | §20.2 | A-29 | O | implemented + tested |
| C-483 | §20.2 | A-30 | O | implemented + tested |
| C-484 | §20.2 | A-31 | O | implemented + tested |
| C-485 | §20.2 | A-32 | O | implemented + tested |
| C-486 | §20.2 | A-33 | O | implemented + tested |
| C-487 | §20.2 | A-34 | O | implemented + tested |
| C-488 | §20.2 | A-35 | O | implemented + tested |
| C-489 | §20.2 | A-36 | O | implemented + tested |
| C-490 | §20.2 | A-37 | O | implemented + tested |
| C-491 | §20.2 | A-38 | O | implemented + tested |
| C-492 | §20.2 | A-39 | O | implemented + tested |
| C-493 | §20.2 | A-40 | O | implemented + tested |
| C-494 | §20.2 | A-41 | O | implemented + tested |
| C-495 | §20.2 | A-42 | O | implemented + tested |
| C-496 | §20.2 | A-43 | O | implemented + tested |
| C-497 | §20.2 | A-44 | O | deviates (human-approved SQ-O-05: me gives Q_NO_PAYEE, own address gives SELF_PAYMENT; tested) |
| C-498 | §20.2 | A-45 | O | implemented + tested |
| C-499 | §20.2 | A-46 | O | implemented + tested |
| C-500 | §20.2 | A-47 | O | implemented + tested |
| C-501 | §20.2 | A-48 | O | implemented + tested |
| C-502 | §20.2 | A-49 | O | implemented + tested |
| C-503 | §20.2 | A-50 | O | implemented + tested |
| C-504 | §20.2 | A-51 | O | implemented + tested |
| C-505 | §20.2 | A-52 | O | implemented + tested |
| C-506 | §20.2 | A-53 | O | implemented + tested |
| C-507 | §20.2 | A-54 | O | implemented + tested |
| C-508 | §20.2 | A-55 | O | implemented + tested |
| C-509 | §20.2 | A-56 | O | implemented + tested |
| C-510 | §20.2 | A-57 | O | implemented + tested (human-approved relaxed P4, SQ-O-03/F-11) |
| C-511 | §20.2 | A-58 | O | implemented + tested |
| C-512 | §20.2 | A-59 | O | implemented + tested |
| C-513 | §20.2 | A-60 | O | implemented + tested |
| C-514 | §20.3 | Live-model evaluation: acceptance prompts + 100 paraphrases; pairing exact-match, question rate, wrong-hand-off rate 0 | O | implemented; live acceptance pending (full 154-case run, SQ-L-01) |
