# SPEC_CHECKLIST

One line per numbered rule / table row / test ID in spec §§5–20. Every item has exactly one owner.
Status values: `open`, `implemented + tested`, `implemented, no test`, `missing`, `deviates (…)`.


## Totals

| Owner | Items |
| --- | --- |
| Lane A | 81 |
| Lane B | 123 |
| Lane C | 73 |
| Lane D | 152 |
| Orchestrator | 85 |
| **Total** | **514** |

## Items

| ID | Section | Item | Owner | Status |
| --- | --- | --- | --- | --- |
| C-001 | §5 | Stack exactly as §5 (Node 22 ESM strict TS, fastify, SQLCipher, keyring, ajv, viem, chrono, luxon, scure, levenshtein, pdf-parse, html-to-text, pino, vitest) | A | open |
| C-002 | §6.1 | Config read from env AGENT_CONFIG, default ~/.agent-layer/config.json; validated | A | open |
| C-003 | §6.1 | Token files: one random 32-byte hex token each, mode 0600, generated on first run if missing | A | open |
| C-004 | §6.1 | config.example.json = §6.1 verbatim | O | implemented + tested |
| C-005 | §6.2 | Static tables transcribed verbatim (src/contracts/static-tables.ts) | O | implemented, no test |
| C-006 | §6.2 | Tokens table used (USDC 6 decimals, ETH 18 native, aliases) | B | open |
| C-007 | §6.2 | Unsupported tokens → UNSUPPORTED_TOKEN | B | open |
| C-008 | §6.2 | Mainnet words used | B | open |
| C-009 | §6.2 | Recurrence words used | B | open |
| C-010 | §6.2 | Cancel words used | B | open |
| C-011 | §6.2 | Back-reference words used | B | open |
| C-012 | §6.2 | Distributive words used | B | open |
| C-013 | §6.2 | Split words used | B | open |
| C-014 | §6.2 | Group markers used | B | open |
| C-015 | §6.3 | DB5 default `per_tx_max` inserted on first run | A | open |
| C-016 | §6.3 | DB5 default `daily_max` inserted on first run | A | open |
| C-017 | §6.3 | DB5 default `autopay_max_per_period` inserted on first run | A | open |
| C-018 | §6.3 | DB5 default `autopay_max_weeks` inserted on first run | A | open |
| C-019 | §6.3 | DB5 default `max_bridges_per_request` inserted on first run | A | open |
| C-020 | §6.3 | DB5 default `allowed_chain_ids` inserted on first run | A | open |
| C-021 | §6.3 | DB5 default `eth_gas_reserve` inserted on first run | A | open |
| C-022 | §6.3 | DB5 default `bridge_buffer_pct` inserted on first run | A | open |
| C-023 | §7 | SQLCipher open with the five pragmas (cipher, key, secure_delete, foreign_keys, WAL) | A | open |
| C-024 | §7 | Amounts stored as decimal strings, addresses EIP-55, timestamps ISO-8601 UTC | A | open |
| C-025 | §7 | Key: 32 random bytes hex in OS keychain (service agent-layer, account db-key), generated on first run | A | open |
| C-026 | §7.1 | schema.sql = §7.1 DDL verbatim | O | implemented, no test |
| C-027 | §7.1 | DB1 repository implements src/contracts/repos.ts | A | open |
| C-028 | §7.1 | DB2 repository implements src/contracts/repos.ts | A | open |
| C-029 | §7.1 | DB3 repository implements src/contracts/repos.ts | A | open |
| C-030 | §7.1 | DB4 repository implements src/contracts/repos.ts | A | open |
| C-031 | §7.1 | DB5 repository implements src/contracts/repos.ts | A | open |
| C-032 | §7.1 | DB6 repository implements src/contracts/repos.ts | A | open |
| C-033 | §7.1 | DB7 repository implements src/contracts/repos.ts | A | open |
| C-034 | §7.1 | DB8 (sessions, prompts, history) repository implements src/contracts/repos.ts | A | open |
| C-035 | §7.1 | DB2 invariant (same name_key ⇒ same address; same address ⇒ same name_key) enforced in a transaction | A | open |
| C-036 | §7.1 | DB6 counts_toward_limit = 1 exactly for payment, bridge_buffer, autopay_payment | A | open |
| C-037 | §7.1 | Migrations run schema.sql (src/db/migrate.ts) | A | open |
| C-038 | §7.2 | DB5 written only by PUT /v1/settings/limits | A | open |
| C-039 | §7.2 | DB8 written by session manager (prompts, answers, history) | A | open |
| C-040 | §7.2 | DB2 written only by add_contact after explicit "Yes" + name | C | open |
| C-041 | §7.3 | Rule 1: Random source crypto.randomBytes hex lowercase | A | open |
| C-042 | §7.3 | Rule 2: Formats amount_/address_/group_ 8 hex; req_/ap_/ses_/q_ 12 hex | A | open |
| C-043 | §7.3 | Rule 3: Uniqueness: redraw on PK violation, max 5 tries, then internal error | A | open |
| C-044 | §7.3 | Rule 4: Never derived from the value | A | open |
| C-045 | §7.3 | Rule 5: One placeholder per phrase/span per request (two amounts → two placeholders; payee twice → two address placeholders) | C | open |
| C-046 | §7.3 | Rule 6: Never reused across requests except follow-up refs via history | C | open |
| C-047 | §7.3 | Rule 7: Not counters | A | open |
| C-048 | §7.4 | Session close: one transaction deletes all rows of DB1, DB3, db8_prompts, db8_history, db8_sessions, then VACUUM; DB2, DB4–DB7 untouched | A | open |
| C-049 | §8.0 | RequestState and AgentRequest transcribed (src/contracts/types.ts) | O | implemented, no test |
| C-050 | §8.0 | Request lives in memory in session manager; one active request per session; raw texts written to DB8 after S1 passes | A | open |
| C-051 | §8.1 | S0 step 1: Parallel eth_getBalance + USDC balanceOf per allowed chain, 10 s timeout | B | open |
| C-052 | §8.1 | S0 step 2: Base units → decimal strings with bigint (ETH 18, USDC 6) | B | open |
| C-053 | §8.1 | S0 step 3: Upsert DB4 status ok, updated_at now | B | open |
| C-054 | §8.1 | S0 step 4: Failure/timeout → both rows unavailable (old values kept, unused) + note | B | open |
| C-055 | §8.1 | S0 step 5: All chains unavailable → BALANCES_UNAVAILABLE, FAILED | B | open |
| C-056 | §8.1 | S0 runs only for new messages (not answers/confirmations) | B | open |
| C-057 | §8.2 | S1.1 every pasted block is untrusted content | B | open |
| C-058 | §8.2 | S1.1 attachments: text/plain, text/markdown, text/csv (UTF-8), application/pdf (pdf-parse); other → ATTACHMENT_UNSUPPORTED naming file; whole request stops | B | open |
| C-059 | §8.2 | S1.1 urls[] plus https URLs in typed text; typed URLs removed and replaced by [link N] | B | open |
| C-060 | §8.2 | S1.1 http:// URL → URL_FETCH_FAILED | B | open |
| C-061 | §8.2 | S1.2 secret detector: Raw private key regex (also 64-hex tx hashes) | B | open |
| C-062 | §8.2 | S1.2 secret detector: Extended key regex + base58check | B | open |
| C-063 | §8.2 | S1.2 secret detector: WIF key regex + base58check + 0x80 | B | open |
| C-064 | §8.2 | S1.2 secret detector: Solana-style secret regex + 64 bytes | B | open |
| C-065 | §8.2 | S1.2 secret detector: Seed phrase: run of ≥12 consecutive BIP-39 words, checksum or not | B | open |
| C-066 | §8.2 | S1.2 secret detector: Keystore JSON (crypto/Crypto, ciphertext, kdf) | B | open |
| C-067 | §8.2 | S1.2 scan covers typed_text, pasted blocks, attachment text (not fetched pages) | B | open |
| C-068 | §8.2 | S1.2 hit → SECRET_DETECTED; nothing written to DB8/DB1/DB3/logs; buffers dropped | B | open |
| C-069 | §8.2 | S1.3 fetch only after scan passes: https GET, timeout, max_redirects each https, max_bytes | B | open |
| C-070 | §8.2 | S1.3 refuse private/loopback/link-local ranges (8 ranges listed) | B | open |
| C-071 | §8.2 | S1.3 accept text/html (html-to-text), text/plain, application/pdf | B | open |
| C-072 | §8.2 | S1.3 any failure → URL_FETCH_FAILED with link number; URLs inside fetched content never fetched | B | open |
| C-073 | §8.2 | S1.4 each item ≤ 20,000 chars else DOCUMENT_TOO_LARGE | B | open |
| C-074 | §8.2 | S1.5 one Q-LLM call per item; invalid → retry once → item yields nothing + note | B | open |
| C-075 | §8.2 | S1.5 QItem mapping; bad address/amount → null; all-null entries dropped | B | open |
| C-076 | §8.2 | S1.6 persist typed_text (typed) and pasted blocks (pasted) to db8_prompts; attachments/pages not stored | B | open |
| C-077 | §8.2 | S1: ENS text records never fetched | B | open |
| C-078 | §8.3 | S2 rule 1: Clause split at . ! ? ; newline , and words and/then/also/plus with offsets | B | open |
| C-079 | §8.3 | S2 rule 2: Address regex candidates | B | open |
| C-080 | §8.3 | S2 rule 3: ENS regex candidates not in email/URL; normalize() failures dropped | B | open |
| C-081 | §8.3 | S2 rule 4: Group markers incl. @<domain> and "everyone under X" | B | open |
| C-082 | §8.3 | S2 rule 5: Chain aliases whole-word; eth/ethereum chain only with on/via/over/using or chain/network/l1 | B | open |
| C-083 | §8.3 | S2 rule 6: Mainnet word → MAINNET_NOT_SUPPORTED; unknown chain after on/via → UNSUPPORTED_CHAIN | B | open |
| C-084 | §8.3 | S2 rule 7: Tokens: usdc aliases, eth/ether/ethereum, fiat USD, fiat OTHER; unsupported token next to number → UNSUPPORTED_TOKEN | B | open |
| C-085 | §8.3 | S2 rule 8: chrono.parse with forwardDate in session tz → spans with kind | B | open |
| C-086 | §8.3 | S2 rule 9: Recurrence/cancel/back-ref/distributive/split flags; distributive inside recurrence not distributive | B | open |
| C-087 | §8.3 | S2 rule 10: Numeric candidates excluding addresses, ENS, chrono spans, ordinals, counts (times\|weeks\|days\|months\|payments\|x) | B | open |
| C-088 | §8.4 | S3 prompt input is unmasked typed_text | B | open |
| C-089 | §8.4 | S3.1 phrase must occur verbatim (case-sensitive, first unused occurrence) else dropped | B | open |
| C-090 | §8.4 | S3.2 role=context dropped silently; phrase → [amount] in masked texts | B | open |
| C-091 | §8.4 | S3.3 number must match ^\d+(\.\d+)?$; null → Q_AMOUNT_MISSING | B | open |
| C-092 | §8.4 | S3.3 code parse equality; mismatch → Q_AMOUNT_MISMATCH with both values | B | open |
| C-093 | §8.4 | S3.3 token inference order (a)–(e); fiat OTHER → Q_FIAT_OTHER; fiat USD with ETH → Q_FIAT_OTHER | B | open |
| C-094 | §8.4 | S3.3 precision > token decimals → Q_AMOUNT_PRECISION; zero → Q_AMOUNT_MISSING | B | open |
| C-095 | §8.4 | S3.4 uncovered numeric candidates → Q_AMOUNT_UNCOVERED (Yes → pay, No → ignore) | B | open |
| C-096 | §8.4 | S3.5 mint amount_ per pay item → DB1 (user, phrase, confirmed 1); replace phrase | B | open |
| C-097 | §8.4 | S3.6 relative amounts: token, chain choice order, value all/half (round down), 0 → INSUFFICIENT_FUNDS, origin relative, pinned | B | open |
| C-098 | §8.4 | S3.7 document amounts only when zero typed pay amounts; Q_UNTRUSTED_AMOUNT each; null token → Q_TOKEN; typed amounts present → note | B | open |
| C-099 | §8.4 | S3.8 no pay amounts → continue | B | open |
| C-100 | §8.4 | S3 output masked_text_s3 | B | open |
| C-101 | §8.5 | S4.1 unsupported → UNSUPPORTED_REQUEST, ANSWERED | B | open |
| C-102 | §8.5 | S4.2 balance → §13.2 answer, ANSWERED | B | open |
| C-103 | §8.5 | S4.3 actions empty → retry once → MODEL_FAILED | B | open |
| C-104 | §8.5 | S4.3 remove l if no cancel word | B | open |
| C-105 | §8.5 | S4.3 recurrence cross-check → Q_RECURRING; answer sets k/i for clause amounts | B | open |
| C-106 | §8.5 | S4.3 i/k without pay amounts → Q_AMOUNT_MISSING | B | open |
| C-107 | §8.5 | S4.3 also_balance → balance answer first message of summary response | B | open |
| C-108 | §8.5 | S4.3 split words + one amount + ≥2 recipients → SPLIT_UNSUPPORTED (after S5) | B | open |
| C-109 | §8.6 | S5 rule 1: span text verbatim in masked_text_s3 else drop | B | open |
| C-110 | §8.6 | S5 rule 2: drop chain/token alias, back-ref word, placeholder, me/my/I | B | open |
| C-111 | §8.6 | S5 rule 3: address regex; ens/group normalize() else drop | B | open |
| C-112 | §8.6 | S5 rule 4: missing S2 candidates added as payee | B | open |
| C-113 | §8.6 | S5 rule 5: overlapping spans keep longest | B | open |
| C-114 | §8.6 | S5 rule 6: mentioned dropped silently → [person] | B | open |
| C-115 | §8.6 | S5 rule 7: follow-up: back-ref + no payee → payee from history (§17.2) | B | open |
| C-116 | §8.6 | S5 rule 8: document addresses/ENS become untrusted payees when no payee and no follow-up | B | open |
| C-117 | §8.6 | S5 rule 9: actions present and no payees → Q_NO_PAYEE | B | open |
| C-118 | §8.7 | S6 resolves payees in order of appearance, one at a time, to ResolvedRecipient | C | open |
| C-119 | §8.8 | S7 single → mint address_ + DB3 single row (chain_id pinned or NULL, source) | C | open |
| C-120 | §8.8 | S7 group → reuse group_ placeholder from §9.6 | C | open |
| C-121 | §8.8 | S7 follow-up refs reuse earlier placeholder (no new row) | C | open |
| C-122 | §8.8 | S7 masked_text_s8 (payees → placeholders, mentioned → [person]) | C | open |
| C-123 | §8.9 | S8 schema: kind enum = actions | D | open |
| C-124 | §8.9 | S8 schema: amount enum = confirmed pay placeholders + null | D | open |
| C-125 | §8.9 | S8 schema: recipient enum = this request placeholders (single, group, follow-up) | D | open |
| C-126 | §8.9 | S8 schema: chain enum = S2 chain IDs + "unstated" | D | open |
| C-127 | §8.9 | S8 schema: schedule fields enums | D | open |
| C-128 | §8.9 | S8 schema: maxItems = min(50, A×R+R) | D | open |
| C-129 | §8.9 | S8 token = DB1 token of amount placeholder | D | open |
| C-130 | §8.9 | S8 retry once with CORRECTION: line; second failure → PAIRING_FAILED | D | open |
| C-131 | §8.9 | S8 output payments[] in model order | D | open |
| C-132 | §8.9 | P1 kind fields | D | open |
| C-133 | §8.9 | P2 amount coverage / distributive reuse | D | open |
| C-134 | §8.9 | P3 recipient coverage; no duplicate (amount, recipient) | D | open |
| C-135 | §8.9 | P4 clause binding | D | open |
| C-136 | §8.9 | P5 groups only with i; k+group → GROUP_AUTOPAY_UNSUPPORTED (no retry) | D | open |
| C-137 | §8.9 | P6 relative only i/single/once → RELATIVE_AMOUNT_NOT_ALLOWED (no retry) | D | open |
| C-138 | §8.9 | P7 untrusted in k → UNTRUSTED_IN_AUTOPAY (no retry) | D | open |
| C-139 | §8.9 | P8 split → SPLIT_UNSUPPORTED (no retry) | D | open |
| C-140 | §8.9 | P9 chain stated/pinned conflict → CHAIN_CONFLICT (no retry) | D | open |
| C-141 | §8.10 | Prompt builder: one function per call returning {system,user,schema}; slots only; fresh chat | B | open |
| C-142 | §8.10 | LLM #1 Amounts prompt verbatim | B | open |
| C-143 | §8.10 | LLM #2 Request type prompt verbatim | B | open |
| C-144 | §8.10 | LLM #3 Recipient spans prompt verbatim (CANDIDATES) | B | open |
| C-145 | §8.10 | Q-LLM prompt verbatim | B | open |
| C-146 | §8.10 | Call options temperature 0, seed, format schema, stream false | B | open |
| C-147 | §8.10 | Retries: error/timeout/invalid → one retry; second → MODEL_FAILED (Q-LLM: item yields nothing) | B | open |
| C-148 | §8.10 | LLM #4 Pair payments prompt verbatim with AMOUNTS/RECIPIENTS/DOCUMENT ITEMS/CHAINS/ACTION KINDS/SESSION/correction slots | D | open |
| C-149 | §8.13 | S11 builds summary from real DB1/DB3/DB4 values, returns awaiting_confirmation | D | open |
| C-150 | §8.14 | S12 step 1: swap_back allowlist; amount_ → {value,base_units,decimals}; address_ → checksummed | D | open |
| C-151 | §8.14 | S12 step 2: validate against hand-off schema; failure → HANDOFF_INVALID/internal error, FAILED | D | open |
| C-152 | §8.14 | S12 step 3: POST /v1/intents with Idempotency-Key = request_id | D | open |
| C-153 | §8.14 | S12 step 4: 2xx → DB6 pending rows, DB7 pending per k, db8_history append, HANDED_OFF, reply | D | open |
| C-154 | §8.14 | S12 step 5: 4xx → EXECUTION_REJECTED with message, FAILED | D | open |
| C-155 | §8.14 | S12 step 6: 5xx/timeout → EXECUTION_UNAVAILABLE, HANDOFF_FAILED; same envelope + key; ≤3 attempts then FAILED | A | open |
| C-156 | §9 | Every path ends at exactly one address or stops; only loop is "No, re-enter" | C | open |
| C-157 | §9.1 | Names 1: name_key normalisation | C | open |
| C-158 | §9.1 | Names 2: DB2 hit → contact (stored name, source contact, chains) + ENS re-check when ens_name | C | open |
| C-159 | §9.1 | Names 3: no rows + contains "." → ENS flow | C | open |
| C-160 | §9.1 | Names 4: no rows → Q_WHO_IS with ≤3 Levenshtein ≤2 chips (distance, then alpha) + free input | C | open |
| C-161 | §9.1 | Names 4a: contact chip → resolved, no alias saved | C | open |
| C-162 | §9.1 | Names 4b: address typed → §9.2 with suggested name | C | open |
| C-163 | §9.1 | Names 4c: ENS typed → §9.3 | C | open |
| C-164 | §9.1 | Names 4d: anything else → re-ask | C | open |
| C-165 | §9.2 | Addresses 1: ^0x[0-9a-fA-F]{40}$; bad mixed-case checksum → re-ask; all-lower/upper accepted + checksummed | C | open |
| C-166 | §9.2 | Addresses 2: zero address → re-ask | C | open |
| C-167 | §9.2 | Addresses 3: wallet.address → SELF_PAYMENT | C | open |
| C-168 | §9.2 | Addresses 4: in DB2 → known contact | C | open |
| C-169 | §9.2 | Addresses 5: not in DB2 → Q_ADDRESS_CORRECT with emphasis; untrusted wording | C | open |
| C-170 | §9.2 | Addresses 5a: No, re-enter → Q_ADDRESS_REENTER → step 1 | C | open |
| C-171 | §9.2 | Addresses 5b: Yes → Q_NAME_FOR_ADDRESS prefilled | C | open |
| C-172 | §9.2 | Addresses 5c: untrusted only: "Don't pay this one" removes payee; none left → Q_NO_PAYEE | C | open |
| C-173 | §9.2 | Addresses 6: name rules (1–32 chars, charset, not alias/back-ref/0x, unique) | C | open |
| C-174 | §9.2 | Addresses 7: add_contact rows for every allowed chain, ens_name NULL; source user/untrusted | C | open |
| C-175 | §9.3 | ENS 1: normalize(); failure → Q_WHO_IS invalid-ENS wording | C | open |
| C-176 | §9.3 | ENS 2: DB2 by ens_name → contact + re-check | C | open |
| C-177 | §9.3 | ENS 3a: target chain known → query that chain | C | open |
| C-178 | §9.3 | ENS 3b: not known → every allowed ok chain | C | open |
| C-179 | §9.3 | ENS 3c: coinType 60 Sepolia / 0x80000000\|chainId L2; fallback 0x80000000; else none | C | open |
| C-180 | §9.3 | ENS 4: no address anywhere → Q_ADDRESS_REENTER ENS wording | C | open |
| C-181 | §9.3 | ENS 5: all equal → one address valid on those chains | C | open |
| C-182 | §9.3 | ENS 6: differ → Q_ENS_CHAIN, pins chain | C | open |
| C-183 | §9.3 | ENS 7: continue §9.2 steps 3–5 with ENS wording; name prefilled with first label; add_contact only matched chains with ens_name; source ens | C | open |
| C-184 | §9.4 | ENS re-check: Same address → continue | C | open |
| C-185 | §9.4 | ENS re-check: Different → Q_ENS_CHANGED (use new: update all rows / keep / cancel → DISCARDED) | C | open |
| C-186 | §9.4 | ENS re-check: No address now → variant (keep / cancel) | C | open |
| C-187 | §9.4 | ENS re-check: RPC unavailable → saved address + note | C | open |
| C-188 | §9.5 | Silent reuse in S9: no DB2 write, DB3 reused_from_chain_id, summary note; never for ENS-pinned | D | open |
| C-189 | §9.6 | Group 1: parent normalize(); failure → Q_GROUP_PARENT | C | open |
| C-190 | §9.6 | Group 2: chain: one chain word in clause/prompt else Q_GROUP_CHAIN | C | open |
| C-191 | §9.6 | Group 3: list_subnames via SubnameSource, direct children, 1,000 per page, reference query; error/timeout → ENS_INDEXER_UNAVAILABLE | C | open |
| C-192 | §9.6 | Group 4: parent not in ENS → Q_GROUP_PARENT not-in-ENS wording | C | open |
| C-193 | §9.6 | Group 5: zero subnames → GROUP_EMPTY | C | open |
| C-194 | §9.6 | Group 6: resolve members 8 in parallel, 10 s each; unresolvable → can't pay | C | open |
| C-195 | §9.6 | Group 7: exclude self (note); dedupe by address keep alphabetically first (note) | C | open |
| C-196 | §9.6 | Group 8: no payable → GROUP_EMPTY | C | open |
| C-197 | §9.6 | Group 9: Q_GROUP_MEMBERS multiselect, preselected, disabled unpayable, count/total; zero → re-ask | C | open |
| C-198 | §9.6 | Group 10: DB3 group row + member rows; never DB2 | C | open |
| C-199 | §9.6 | Group 11: no size cap | C | open |
| C-200 | §9.7 | Questions one at a time in payee order | C | open |
| C-201 | §9.7 | Attempt counter: first ask + ≤3 re-asks; 4th failure → TOO_MANY_RETRIES | A | open |
| C-202 | §10.1 | spendable formula (DB4 − pending 10 min kinds − ETH gas reserve, max 0); unavailable chains excluded; stated/pinned unavailable chain → BALANCES_UNAVAILABLE | D | open |
| C-203 | §10.1 | bigint base-unit arithmetic; display without trailing zeros | D | open |
| C-204 | §10.2 | Expand 1: group payments expand to one i per selected member, alphabetical, at group position | D | open |
| C-205 | §10.2 | Expand 2: k schedule and caps first (prefund = total_cap) | D | open |
| C-206 | §10.2 | Expand 3: l gets autopay from DB7 | D | open |
| C-207 | §10.3 | Chain 1: pinned → that chain | D | open |
| C-208 | §10.3 | Chain 2: stated → must be allowed (CHAIN_NOT_ALLOWED) and ok | D | open |
| C-209 | §10.3 | Chain 3: candidates by source; largest spendable−assigned ≥ need; ties allowed order | D | open |
| C-210 | §10.3 | Chain 4: contact with none qualifying → extend to all ok chains (silent reuse) | D | open |
| C-211 | §10.3 | Chain 5: still none → largest spendable−assigned; shortfall bridged | D | open |
| C-212 | §10.3 | Chain 6: add need to assigned; mark silent reuse | D | open |
| C-213 | §10.4 | Bridge algorithm (short/surplus, deliverable floor, padded ceil, DB1 bridge_padded mint) | D | open |
| C-214 | §10.4 | INSUFFICIENT_FUNDS lists per-chain spendable vs needed | D | open |
| C-215 | §10.4 | > max_bridges_per_request → LIMIT_BRIDGES | D | open |
| C-216 | §10.4 | j buffer counts toward daily limit | D | open |
| C-217 | §10.4 | Gas check per touched chain → NO_GAS | D | open |
| C-218 | §10.5 | Order 1: steps from 0, no gaps | D | open |
| C-219 | §10.5 | Order 2: j first ordered by first needing payment then source allowed order | D | open |
| C-220 | §10.5 | Order 3: then i/k/l in payment order (groups in place) | D | open |
| C-221 | §10.5 | Order 4: i/k depends_on = j steps with dest = chain and same token | D | open |
| C-222 | §10.5 | Order 5: j funds_steps | D | open |
| C-223 | §10.5 | Order 6: l no depends_on | D | open |
| C-224 | §10.6 | Schedule field: frequency (null → Q_AUTOPAY_FREQUENCY; times_per_week 7 → daily) | D | open |
| C-225 | §10.6 | Schedule field: interval (null → 1) | D | open |
| C-226 | §10.6 | Schedule field: days_of_week (named win; times_per_week table; else today) | D | open |
| C-227 | §10.6 | Schedule field: day_of_month (S8 else today; 29–31 → 28 + note) | D | open |
| C-228 | §10.6 | Schedule field: time_of_day (chrono in clause else default 10:00) | D | open |
| C-229 | §10.6 | Schedule field: timezone = session | D | open |
| C-230 | §10.6 | Schedule field: start_date (chrono start else today; past → Q_AUTOPAY_START); first occurrence ≥ start and strictly after now | D | open |
| C-231 | §10.6 | Schedule field: end (after_count / on_date N units −1 day / until / until_cancelled; nothing → Q_AUTOPAY_END → COUNT/DATE) | D | open |
| C-232 | §10.6 | Derived 1: occurrences enumeration with interval and end | D | open |
| C-233 | §10.6 | Derived 2: zero → AUTOPAY_NO_OCCURRENCES | D | open |
| C-234 | §10.6 | Derived 3: beyond max weeks → LIMIT_AUTOPAY_DURATION | D | open |
| C-235 | §10.6 | Derived 4: per_period_cap and LIMIT_AUTOPAY_PERIOD | D | open |
| C-236 | §10.6 | Derived 5: amount_per_payment ≤ per_tx_max → LIMIT_PER_TX | D | open |
| C-237 | §10.6 | Derived 6: total_cap = amount × occurrences = prefund | D | open |
| C-238 | §10.6 | Derived 7: caps minted in DB1 derived | D | open |
| C-239 | §10.6 | Derived 8: expires_at 23:59:59 last date in tz as UTC | D | open |
| C-240 | §10.6 | Derived 9: cron strings daily/weekly/monthly | D | open |
| C-241 | §10.6 | Derived 10: autopay_id minted | D | open |
| C-242 | §10.7 | Cancel 1: find_autopays by recipient active | D | open |
| C-243 | §10.7 | Cancel 2: pending only → AUTOPAY_NOT_READY; none → NO_ACTIVE_AUTOPAY | D | open |
| C-244 | §10.7 | Cancel 3: several → Q_AUTOPAY_PICK | D | open |
| C-245 | §10.7 | Cancel 4: l takes autopay_id, chain_id, delegate from DB7; refund_remaining true | D | open |
| C-246 | §11 | V-01 | D | open |
| C-247 | §11 | V-02 | D | open |
| C-248 | §11 | V-03 | D | open |
| C-249 | §11 | V-04 | D | open |
| C-250 | §11 | V-05 | D | open |
| C-251 | §11 | V-06 | D | open |
| C-252 | §11 | V-07 | D | open |
| C-253 | §11 | V-08 | D | open |
| C-254 | §11 | V-09 | D | open |
| C-255 | §11 | V-10 | D | open |
| C-256 | §11 | V-11 | D | open |
| C-257 | §11 | V-12 | D | open |
| C-258 | §11 | V-13 | D | open |
| C-259 | §11 | V-14 | D | open |
| C-260 | §11 | V-15 | D | open |
| C-261 | §11.1 | INTERNAL_ERROR logs rule ID, user message, FAILED | D | open |
| C-262 | §11.4 | DB6 at hand-off: i → payment row counts 1 | D | open |
| C-263 | §11.4 | DB6 at hand-off: j → bridge_out (0) + bridge_buffer (1) | D | open |
| C-264 | §11.4 | DB6 at hand-off: k → autopay_prefund (0) | D | open |
| C-265 | §11.4 | DB6 at hand-off: l → none | D | open |
| C-266 | §11.4 | autopay_payment reports inserted executed, counts 1 | A | open |
| C-267 | §12.1 | amounts schema verbatim | O | implemented + tested |
| C-268 | §12.1 | request-type schema verbatim | O | implemented + tested |
| C-269 | §12.1 | recipient-spans schema verbatim | O | implemented + tested |
| C-270 | §12.1 | quarantine schema verbatim | O | implemented + tested |
| C-271 | §12.1 | Shared Ajv 2020 strict allErrors + formats | O | implemented + tested |
| C-272 | §12.2 | S8 template builder (slots) | O | implemented + tested |
| C-273 | §12.3 | Internal plan types + generated internal-plan.schema.json | O | implemented + tested |
| C-274 | §12.5 | Hand-off envelope schema verbatim | O | implemented + tested |
| C-275 | §12.5 | token_address rule (usdc_address / null; j both) | D | open |
| C-276 | §12.5 | base_units via bigint; value no trailing zeros | D | open |
| C-277 | §12.5 | addresses checksummed before validation | D | open |
| C-278 | §12.5 | prefund = limits.total_cap | D | open |
| C-279 | §13.1 | Summary: j line | D | open |
| C-280 | §13.1 | Summary: i line + "After step n." | D | open |
| C-281 | §13.1 | Summary: i group collapsed line | D | open |
| C-282 | §13.1 | Summary: k line | D | open |
| C-283 | §13.1 | Summary: l line | D | open |
| C-284 | §13.1 | Summary: {Name} precedence | D | open |
| C-285 | §13.1 | Summary: {cadence} forms | D | open |
| C-286 | §13.1 | Summary: {end text} forms | D | open |
| C-287 | §13.1 | Summary: Footer per token | D | open |
| C-288 | §13.1 | Summary: "Please confirm:" / "Confirm?" framing | D | open |
| C-289 | §13.1 | Summary: Address display 0x+4…4, amounts no trailing zeros, chain display names | D | open |
| C-290 | §13.1 | Note emitted: Same address as on {Chain} | D | open |
| C-291 | §13.1 | Note emitted: Recipient and chain from your last payment | D | open |
| C-292 | §13.1 | Note emitted: You wrote '{phrase}' → … | D | open |
| C-293 | §13.1 | Note emitted: From attached content … | D | open |
| C-294 | §13.1 | Note emitted: {Chain} balance couldn't be read … | B | open |
| C-295 | §13.1 | Note emitted: Couldn't re-check {ens} … | C | open |
| C-296 | §13.1 | Note emitted: Paid on the 28th … | D | open |
| C-297 | §13.1 | Note emitted: Skipped {name}: … | C | open |
| C-298 | §13.1 | Note emitted: Today's limit was lifted once … | D | open |
| C-299 | §13.1 | Note emitted: Amounts in the attached content weren't used | B | open |
| C-300 | §13.1 | Note emitted: Couldn't read anything usable from {item} | B | open |
| C-301 | §13.2 | Balance answer format; every allowed chain in order; raw ETH + spendable; totals | D | open |
| C-302 | §13.3 | Reply: Sent to your wallet for signing. | D | open |
| C-303 | §13.3 | Reply: OK, I've dropped that… | A | open |
| C-304 | §13.3 | Reply: Cancelled. Nothing was sent. | A | open |
| C-305 | §13.3 | Reply: I dropped the previous plan… (prepended) | A | open |
| C-306 | §13.4 | Question JSON shape; texts and fixed chips in catalog; chip answer parsing (matchChip) | O | implemented + tested |
| C-307 | §13.4 | Q_AMOUNT_MISSING: asked when specified; answer validated; effect applied | B | open |
| C-308 | §13.4 | Q_AMOUNT_MISMATCH: asked when specified; answer validated; effect applied | B | open |
| C-309 | §13.4 | Q_AMOUNT_UNCOVERED: asked when specified; answer validated; effect applied | B | open |
| C-310 | §13.4 | Q_AMOUNT_PRECISION: asked when specified; answer validated; effect applied | B | open |
| C-311 | §13.4 | Q_TOKEN: asked when specified; answer validated; effect applied | B | open |
| C-312 | §13.4 | Q_FIAT_OTHER: asked when specified; answer validated; effect applied | B | open |
| C-313 | §13.4 | Q_UNTRUSTED_AMOUNT: asked when specified; answer validated; effect applied | B | open |
| C-314 | §13.4 | Q_RECURRING: asked when specified; answer validated; effect applied | B | open |
| C-315 | §13.4 | Q_NO_PAYEE: asked when specified; answer validated; effect applied | B | open |
| C-316 | §13.4 | Q_FOLLOWUP_WHO: asked when specified; answer validated; effect applied | B | open |
| C-317 | §13.4 | Q_WHO_IS: asked when specified; answer validated; effect applied | C | open |
| C-318 | §13.4 | Q_ADDRESS_CORRECT: asked when specified; answer validated; effect applied | C | open |
| C-319 | §13.4 | Q_ADDRESS_REENTER: asked when specified; answer validated; effect applied | C | open |
| C-320 | §13.4 | Q_NAME_FOR_ADDRESS: asked when specified; answer validated; effect applied | C | open |
| C-321 | §13.4 | Q_ENS_CHAIN: asked when specified; answer validated; effect applied | C | open |
| C-322 | §13.4 | Q_ENS_CHANGED: asked when specified; answer validated; effect applied | C | open |
| C-323 | §13.4 | Q_GROUP_PARENT: asked when specified; answer validated; effect applied | C | open |
| C-324 | §13.4 | Q_GROUP_CHAIN: asked when specified; answer validated; effect applied | C | open |
| C-325 | §13.4 | Q_GROUP_MEMBERS: asked when specified; answer validated; effect applied | C | open |
| C-326 | §13.4 | Q_GROUP_OVER_LIMIT: asked when specified; answer validated; effect applied | D | open |
| C-327 | §13.4 | Q_AUTOPAY_FREQUENCY: asked when specified; answer validated; effect applied | D | open |
| C-328 | §13.4 | Q_AUTOPAY_START: asked when specified; answer validated; effect applied | D | open |
| C-329 | §13.4 | Q_AUTOPAY_END: asked when specified; answer validated; effect applied | D | open |
| C-330 | §13.4 | Q_AUTOPAY_COUNT: asked when specified; answer validated; effect applied | D | open |
| C-331 | §13.4 | Q_AUTOPAY_DATE: asked when specified; answer validated; effect applied | D | open |
| C-332 | §13.4 | Q_AUTOPAY_PICK: asked when specified; answer validated; effect applied | D | open |
| C-333 | §13.4 | Number answers via S3 code parser (parseAmountText) | B | open |
| C-334 | §13.4 | Address answers via §9.2 step 1; ENS typed where address asked → §9.3 | C | open |
| C-335 | §13.4 | Date answers via chrono in session tz | D | open |
| C-336 | §14.1 | API: Bearer UI token on every route | A | open |
| C-337 | §14.1 | API: JSON bodies, base64 attachments, max body 20 MB | A | open |
| C-338 | §14.1 | API: AgentResponse shape; HTTP 200 unless request invalid | A | open |
| C-339 | §14.1 | API: POST /v1/sessions (timezone IANA, invalid → 400; closes open session) | A | open |
| C-340 | §14.1 | API: DELETE /v1/sessions/{id} (204; unknown → 404) | A | open |
| C-341 | §14.1 | API: POST /v1/sessions/{id}/messages | A | open |
| C-342 | §14.1 | API: POST /v1/sessions/{id}/answers (stale question_id → 409) | A | open |
| C-343 | §14.1 | API: POST /v1/sessions/{id}/confirm (409 rules) | A | open |
| C-344 | §14.1 | API: POST /v1/sessions/{id}/cancel | A | open |
| C-345 | §14.1 | API: GET /v1/settings/limits | A | open |
| C-346 | §14.1 | API: PUT /v1/settings/limits validation (400 field errors) | A | open |
| C-347 | §14.1 | API: GET /v1/health {ok, ollama, db} | A | open |
| C-348 | §14.1 | API: Concurrent call same session → 409 | A | open |
| C-349 | §14.2 | Execution client: headers (Bearer outbound token, Idempotency-Key, JSON); 2xx accepted; 4xx message; 5xx/timeout unavailable | D | open |
| C-350 | §14.3 | Reports: Report auth: execution report token | A | open |
| C-351 | §14.3 | Reports: intent_result updates DB6; k → DB7 active + delegate/cre_job_id (or failed); l → cancelled | A | open |
| C-352 | §14.3 | Reports: autopay_payment inserts DB6 row | A | open |
| C-353 | §14.3 | Reports: autopay_status updates DB7 | A | open |
| C-354 | §14.3 | Reports: unknown id → 404; malformed → 400; success → 204 | A | open |
| C-355 | §14.4 | Ollama /api/chat request shape; parse message.content; Ajv validate | B | open |
| C-356 | §14.4 | Startup GET /api/tags check; missing model → health ollama false and every request MODEL_FAILED | B | open |
| C-357 | §14.5 | One viem public client per chain, http(rpc_url), 10 s, no retries | B | open |
| C-358 | §14.5 | ENS client on ens.rpc_chain_id with universalResolverAddress | C | open |
| C-359 | §14.5 | Indexer HTTPS POST GraphQL, 10 s timeout | C | open |
| C-360 | §15 | SECRET_DETECTED raised in its stated case with catalog message | B | open |
| C-361 | §15 | ATTACHMENT_UNSUPPORTED raised in its stated case with catalog message | B | open |
| C-362 | §15 | URL_FETCH_FAILED raised in its stated case with catalog message | B | open |
| C-363 | §15 | DOCUMENT_TOO_LARGE raised in its stated case with catalog message | B | open |
| C-364 | §15 | BALANCES_UNAVAILABLE raised in its stated case with catalog message | B | open |
| C-365 | §15 | MAINNET_NOT_SUPPORTED raised in its stated case with catalog message | B | open |
| C-366 | §15 | UNSUPPORTED_CHAIN raised in its stated case with catalog message | B | open |
| C-367 | §15 | UNSUPPORTED_TOKEN raised in its stated case with catalog message | B | open |
| C-368 | §15 | UNSUPPORTED_REQUEST raised in its stated case with catalog message | B | open |
| C-369 | §15 | SPLIT_UNSUPPORTED raised in its stated case with catalog message | D | open |
| C-370 | §15 | RELATIVE_AMOUNT_NOT_ALLOWED raised in its stated case with catalog message | D | open |
| C-371 | §15 | GROUP_AUTOPAY_UNSUPPORTED raised in its stated case with catalog message | D | open |
| C-372 | §15 | UNTRUSTED_IN_AUTOPAY raised in its stated case with catalog message | D | open |
| C-373 | §15 | CHAIN_CONFLICT raised in its stated case with catalog message | D | open |
| C-374 | §15 | PAIRING_FAILED raised in its stated case with catalog message | D | open |
| C-375 | §15 | SELF_PAYMENT raised in its stated case with catalog message | C | open |
| C-376 | §15 | ENS_INDEXER_UNAVAILABLE raised in its stated case with catalog message | C | open |
| C-377 | §15 | GROUP_EMPTY raised in its stated case with catalog message | C | open |
| C-378 | §15 | NO_ACTIVE_AUTOPAY raised in its stated case with catalog message | D | open |
| C-379 | §15 | AUTOPAY_NOT_READY raised in its stated case with catalog message | D | open |
| C-380 | §15 | AUTOPAY_NO_OCCURRENCES raised in its stated case with catalog message | D | open |
| C-381 | §15 | INSUFFICIENT_FUNDS raised in its stated case with catalog message | D | open |
| C-382 | §15 | NO_GAS raised in its stated case with catalog message | D | open |
| C-383 | §15 | CHAIN_NOT_ALLOWED raised in its stated case with catalog message | D | open |
| C-384 | §15 | LIMIT_PER_TX raised in its stated case with catalog message | D | open |
| C-385 | §15 | LIMIT_DAILY raised in its stated case with catalog message | D | open |
| C-386 | §15 | LIMIT_AUTOPAY_PERIOD raised in its stated case with catalog message | D | open |
| C-387 | §15 | LIMIT_AUTOPAY_DURATION raised in its stated case with catalog message | D | open |
| C-388 | §15 | LIMIT_BRIDGES raised in its stated case with catalog message | D | open |
| C-389 | §15 | TOO_MANY_RETRIES raised in its stated case with catalog message | A | open |
| C-390 | §15 | MODEL_FAILED raised in its stated case with catalog message | B | open |
| C-391 | §15 | EXECUTION_REJECTED raised in its stated case with catalog message | D | open |
| C-392 | §15 | EXECUTION_UNAVAILABLE raised in its stated case with catalog message | D | open |
| C-393 | §15 | INTERNAL_ERROR raised in its stated case with catalog message | D | open |
| C-394 | §15 | CANCELLED raised in its stated case with catalog message | A | open |
| C-395 | §15 | All 35 error messages verbatim in catalog | O | implemented + tested |
| C-396 | §15 | Errors returned in AgentResponse.error with state "error"; FAILED or ANSWERED for refusals | A | open |
| C-397 | §16.1 | Q-LLM values used only when typed text has no amounts / no payees | B | open |
| C-398 | §16.1 | Each untrusted amount needs Q_UNTRUSTED_AMOUNT | B | open |
| C-399 | §16.1 | Q-LLM output never in a P-LLM prompt except as placeholder (LLM #1–#3 builders) | B | open |
| C-400 | §16.1 | Each untrusted address via Q_ADDRESS_CORRECT with content wording unless saved contact | C | open |
| C-401 | §16.1 | Untrusted never fills k (unless saved contact); LLM #4 builder uses placeholders only for content values | D | open |
| C-402 | §16.2 | Only §12.5 fields reach execution layer (swap_back allowlist) | D | open |
| C-403 | §16.2 | Names/ENS/summary never sent to execution layer | D | open |
| C-404 | §16.2 | Context amounts / mentioned names dropped at S3/S5 (no DB, no later model call) | B | open |
| C-405 | §16.3 | Name rules reject injection-like names | C | open |
| C-406 | §16.3 | No DB5 chat write path | A | open |
| C-407 | §16.4 | HTTP bound to 127.0.0.1; tokens from 0600 files; UI and report tokens differ | A | open |
| C-408 | §16.4 | secure_delete + VACUUM after session clears | A | open |
| C-409 | §16.4 | Outbound requests only to Ollama, RPC URLs, user https URLs (fetcher) | B | open |
| C-410 | §17.1 | One open session; no idle timeout | A | open |
| C-411 | §17.1 | Close clears every row of DB1/DB3/DB8; in-progress request DISCARDED; handed-off unaffected | A | open |
| C-412 | §17.2 | Step 1: history = last 5 db8_history rows of session | A | open |
| C-413 | §17.2 | Step 2: follow-up = back-ref word and no payee | B | open |
| C-414 | §17.2 | Step 3: previous single payees of most recent entry; one → use; several → Q_FOLLOWUP_WHO; none → Q_NO_PAYEE | B | open |
| C-415 | §17.2 | Step 5: new amount always required (no pay amount → Q_AMOUNT_MISSING) | B | open |
| C-416 | §17.2 | Step 6: token fallback to previous payment token | B | open |
| C-417 | §17.2 | Step 4a: chosen payee placeholder offered to S8 under SESSION, no new DB3 row | C | open |
| C-418 | §17.2 | Step 4b: "unstated" chain → previous chain as stated | D | open |
| C-419 | §17.2 | Step 7: follow-up summary note | D | open |
| C-420 | §17.3 | Table: Awaiting answer + answers call → validate, attempt+1, TOO_MANY_RETRIES after 4th | A | open |
| C-421 | §17.3 | Table: Awaiting answer + messages call → free-text answer | A | open |
| C-422 | §17.3 | Table: Cancel texts or cancel endpoint → DISCARDED, CANCELLED | A | open |
| C-423 | §17.3 | Table: Awaiting confirmation + yes texts/confirm yes → S12 | A | open |
| C-424 | §17.3 | Table: Awaiting confirmation + no texts/confirm no → DISCARDED + reply | A | open |
| C-425 | §17.3 | Table: Awaiting confirmation + other text → discard + new request + prepend line | A | open |
| C-426 | §17.3 | Table: HANDOFF_FAILED + confirm yes → retry S12 ≤3 total | A | open |
| C-427 | §17.3 | Discarded/cancelled requests keep DB1/DB3 rows but are never written to db8_history | A | open |
| C-428 | §18 | pino JSON to ~/.agent-layer/logs/agent.log, rotate 10 MB × 5, level info | A | open |
| C-429 | §18 | Allowlist serializer drops every other field; no debug mode | A | open |
| C-430 | §18 | Never-logged values (prompt, answers, amounts, addresses, names, ENS, tx hashes, LLM IO, documents, URLs) | A | open |
| C-431 | §18 | Metrics counters in logs (final states, question codes, LLM retries, pairing failures, hand-off failures) | A | open |
| C-432 | §19 | E1 reproduced by acceptance tests | O | open |
| C-433 | §19 | E2 reproduced by acceptance tests | O | open |
| C-434 | §19 | E3 reproduced by acceptance tests | O | open |
| C-435 | §19 | E4 reproduced by acceptance tests | O | open |
| C-436 | §19 | E5 reproduced by acceptance tests | O | open |
| C-437 | §19 | E6 reproduced by acceptance tests | O | open |
| C-438 | §19 | E7 reproduced by acceptance tests | O | open |
| C-439 | §19 | E8 reproduced by acceptance tests | O | open |
| C-440 | §19 | E9 reproduced by acceptance tests | O | open |
| C-441 | §19 | E10 reproduced by acceptance tests | O | open |
| C-442 | §20.1 | Unit tests: guard/secrets (every "must cover" item) | B | open |
| C-443 | §20.1 | Unit tests: lexical (every "must cover" item) | B | open |
| C-444 | §20.1 | Unit tests: amounts/parser (every "must cover" item) | B | open |
| C-445 | §20.1 | Unit tests: amounts/verify (every "must cover" item) | B | open |
| C-446 | §20.1 | Unit tests: recipients (every "must cover" item) | C | open |
| C-447 | §20.1 | Unit tests: pairing/checks (every "must cover" item) | D | open |
| C-448 | §20.1 | Unit tests: plan (every "must cover" item) | D | open |
| C-449 | §20.1 | Unit tests: schedule (every "must cover" item) | D | open |
| C-450 | §20.1 | Unit tests: validate (every "must cover" item) | D | open |
| C-451 | §20.1 | Unit tests: handoff (every "must cover" item) | D | open |
| C-452 | §20.1 | Unit tests: session (every "must cover" item) | A | open |
| C-453 | §20.1 | Unit tests: logging (every "must cover" item) | A | open |
| C-454 | §20.2 | A-01 | O | open |
| C-455 | §20.2 | A-02 | O | open |
| C-456 | §20.2 | A-03 | O | open |
| C-457 | §20.2 | A-04 | O | open |
| C-458 | §20.2 | A-05 | O | open |
| C-459 | §20.2 | A-06 | O | open |
| C-460 | §20.2 | A-07 | O | open |
| C-461 | §20.2 | A-08 | O | open |
| C-462 | §20.2 | A-09 | O | open |
| C-463 | §20.2 | A-10 | O | open |
| C-464 | §20.2 | A-11 | O | open |
| C-465 | §20.2 | A-12 | O | open |
| C-466 | §20.2 | A-13 | O | open |
| C-467 | §20.2 | A-14 | O | open |
| C-468 | §20.2 | A-15 | O | open |
| C-469 | §20.2 | A-16 | O | open |
| C-470 | §20.2 | A-17 | O | open |
| C-471 | §20.2 | A-18 | O | open |
| C-472 | §20.2 | A-19 | O | open |
| C-473 | §20.2 | A-20 | O | open |
| C-474 | §20.2 | A-21 | O | open |
| C-475 | §20.2 | A-22 | O | open |
| C-476 | §20.2 | A-23 | O | open |
| C-477 | §20.2 | A-24 | O | open |
| C-478 | §20.2 | A-25 | O | open |
| C-479 | §20.2 | A-26 | O | open |
| C-480 | §20.2 | A-27 | O | open |
| C-481 | §20.2 | A-28 | O | open |
| C-482 | §20.2 | A-29 | O | open |
| C-483 | §20.2 | A-30 | O | open |
| C-484 | §20.2 | A-31 | O | open |
| C-485 | §20.2 | A-32 | O | open |
| C-486 | §20.2 | A-33 | O | open |
| C-487 | §20.2 | A-34 | O | open |
| C-488 | §20.2 | A-35 | O | open |
| C-489 | §20.2 | A-36 | O | open |
| C-490 | §20.2 | A-37 | O | open |
| C-491 | §20.2 | A-38 | O | open |
| C-492 | §20.2 | A-39 | O | open |
| C-493 | §20.2 | A-40 | O | open |
| C-494 | §20.2 | A-41 | O | open |
| C-495 | §20.2 | A-42 | O | open |
| C-496 | §20.2 | A-43 | O | open |
| C-497 | §20.2 | A-44 | O | open |
| C-498 | §20.2 | A-45 | O | open |
| C-499 | §20.2 | A-46 | O | open |
| C-500 | §20.2 | A-47 | O | open |
| C-501 | §20.2 | A-48 | O | open |
| C-502 | §20.2 | A-49 | O | open |
| C-503 | §20.2 | A-50 | O | open |
| C-504 | §20.2 | A-51 | O | open |
| C-505 | §20.2 | A-52 | O | open |
| C-506 | §20.2 | A-53 | O | open |
| C-507 | §20.2 | A-54 | O | open |
| C-508 | §20.2 | A-55 | O | open |
| C-509 | §20.2 | A-56 | O | open |
| C-510 | §20.2 | A-57 | O | open |
| C-511 | §20.2 | A-58 | O | open |
| C-512 | §20.2 | A-59 | O | open |
| C-513 | §20.2 | A-60 | O | open |
| C-514 | §20.3 | Live-model evaluation: acceptance prompts + 100 paraphrases; pairing exact-match, question rate, wrong-hand-off rate 0 | O | open |
