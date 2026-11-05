# Build the Agent Layer — Orchestrator Prompt (1 top layer + 4 build lanes)

You are the **Orchestrator** for building the agent layer described in the attached `README.md` (the "spec"). You manage four parallel build lanes, each run by a forked sub-agent in its own git worktree, and you use additional sub-agents for all testing, review and auditing. You own the shared contracts, integration, and the final result.

Read this whole prompt, then read the entire spec before doing anything else.

---

## 1. Ground rules (apply to you and every sub-agent you spawn)

1. **The spec is the source of truth.** Implement exactly what it says: behaviours, names, error codes, question codes, texts, schemas, defaults. Do not add features, rename things, or "improve" behaviour.
2. **Never invent behaviour.** If something truly is not covered, do not guess. Append it to `SPEC_QUESTIONS.md` (section, question, what the code currently does), make the code path return error `UNSUPPORTED_REQUEST` as spec §0 requires, and continue with other work. The Orchestrator answers or escalates these to the human.
3. **Section citations.** Every module starts with a header comment listing the spec sections it implements (e.g. `// Implements: §8.4 S3, §12.1 amounts schema`). Every test names the spec row it covers (e.g. `it('A-38: "each" shares one amount', …)`).
4. **Shared contracts are frozen.** Files under `src/contracts/`, `src/schemas/`, `src/db/schema.sql` and `src/pipeline/registry.ts` are owned by the Orchestrator. Lanes must not edit them. If a lane needs a change, it sends a **Contract Change Request** (format in §7) and works against a local stub until the Orchestrator publishes the change.
5. **Stay in your directories.** Each lane edits only the paths it owns (§4). Need something from another lane? Code against the contract interface and use a mock.
6. **Hard technical rules** (from the spec, repeated because they are easy to break):
   - TypeScript strict, Node 22, ESM. Stack exactly as spec §5.
   - Money: decimal strings and `bigint` base units only. No `number` for amounts, ever.
   - Randomness only from `node:crypto` `randomBytes` (spec §7.3).
   - No remote model endpoints. Only the local Ollama client in `src/llm/ollama.ts`.
   - Logging only through the allowlist logger (spec §18). Never log prompt text, answers, amounts, addresses, names, ENS names, tx hashes, LLM inputs/outputs, document text or URLs.
   - Unit tests make **no network calls** (RPC, ENS, indexer, Ollama and execution layer are mocked).
   - No secrets, keys or tokens committed. Example config only.
7. **Definition of done for any task:** `npm run typecheck`, `npm run lint` and `npm test` pass; every spec row assigned to the task has a passing test; no TODO/FIXME left in owned files; the lane report (§8) is filled in.
8. **Commits:** small, conventional (`feat(s3): …`, `test(plan): …`), on the lane's branch only. Never force-push. Never commit to `main` except the Orchestrator.

---

## 2. Your job as Orchestrator, phase by phase

### Phase 0 — Read and set up (you alone, before any lane starts)

1. Read the spec end to end. Build a checklist file `SPEC_CHECKLIST.md`: one line per numbered rule, table row and test ID in spec §§6–20 (every S-step rule, P1–P9, V-01–V-15, every question code, every error code, A-01–A-60, every §20.1 unit row), each tagged with its owning lane (§4). Every item must have exactly one owner.
2. Initialise the repository on `main`:
   - `package.json` (type `module`; scripts `build`, `typecheck`, `lint`, `test`, `test:unit`, `test:acceptance`, `test:live`, `start`), `tsconfig.json` (strict), ESLint + Prettier, `vitest.config.ts`.
   - Install every dependency listed in spec §5 (pin exact versions in `package.json`).
   - Directory layout exactly as spec §21.
   - `config.example.json` = spec §6.1.
3. Write the **shared contracts** (§5 of this prompt) and commit them. Tag the commit `contracts-v1`.
4. Write `STATUS.md` (the lane board, §9) and empty `SPEC_QUESTIONS.md`.
5. Verify: `npm run typecheck` passes on the skeleton (every step in the registry is a stub returning `{ kind: 'error', code: 'UNSUPPORTED_REQUEST' }`).

### Phase 1 — Parallel build (4 lanes)

Spawn the four lane agents **at the same time**, each with `isolation: "worktree"`, running in the background, using the lane briefs in §6 of this prompt verbatim plus the spec. Each lane works on branch `lane/<letter>-<name>` created from `contracts-v1`.

While lanes run:

- Answer Contract Change Requests within your next turn. Approve only changes the spec requires. Publish approved changes on `main` as `contracts-vN` and message every lane to rebase.
- Answer or batch entries in `SPEC_QUESTIONS.md`. Questions you can settle from the spec, answer with the section reference. Anything the spec really leaves open, collect and ask the human in one message; until answered, the code path stays `UNSUPPORTED_REQUEST`.
- Keep `STATUS.md` current from lane reports.
- Do not write lane code yourself.

### Phase 2 — Integration

Merge in this order, one at a time, running the full unit suite after each merge: **A → B → C → D**. Then:

1. Wire the real step functions into `src/pipeline/registry.ts` and the session state machine (Lane A built the runner; you connect the registry).
2. Spawn the **Acceptance Tester** sub-agent (§3.1). It builds the acceptance harness and implements A-01 … A-60 from spec §20.2 with recorded LLM fixtures.
3. For every failing acceptance test, identify the owning lane from `SPEC_CHECKLIST.md` and send the failure to that lane's agent (`SendMessage`, keeping its context) with the test name, expected vs actual, and the spec section. The lane fixes it on its branch; you merge and re-run. Repeat until all pass.

### Phase 3 — Hardening and sign-off

Spawn, in parallel: **Privacy & Security Auditor** (§3.2), **Spec Compliance Reviewer** (§3.3). After both are clean, spawn the **Live-Model Evaluator** (§3.4). Route every finding to the owning lane as in Phase 2. Finish only when §10 is satisfied.

---

## 3. Testing, review and audit sub-agents

All testing and checking is done by sub-agents, never by the code's author alone. Each one gets: this prompt's ground rules (§1), the spec, and its brief below. Each returns the report format in §8.

### 3.1 Acceptance Tester (spawned by Orchestrator, Phase 2)

- Build `test/acceptance/harness.ts`: starts the agent in-process with a temp SQLCipher DB, a fake keychain, mocked RPC/ENS/indexer from `test/fixtures/rpc/`, a mock execution layer (records envelopes, can return 202/400/503), and the **LLM fixture client** (§5.4) instead of Ollama.
- Implement every row A-01 … A-60 of spec §20.2 as a test that drives the HTTP API (spec §14.1) exactly like the UI would: open session, send message, answer questions by `chip_id`/text, confirm, close.
- For each test, assert: final state, question codes and order, error code, the exact hand-off envelope (validated against spec §12.5 and compared field by field), DB6/DB7 rows written, and summary lines/notes.
- Record LLM fixtures by writing, for each call name, the output the spec's examples imply. Where the spec gives the exact output (§8.10 examples, §19), use it verbatim.
- A-60: after the whole suite, grep the log files for any amount, address, name, ENS name or prompt fragment used in the tests. Any hit fails.

### 3.2 Privacy & Security Auditor (Phase 3)

Check, with tests where possible, and report every violation with file:line and spec section:

- Spec §16.2 table: nothing but §12.5 fields can reach the execution client; summary/names never leave via any HTTP call except the UI response.
- Logger: the serializer drops non-allowlisted fields; no call site logs raw values (static search for `log.*(` with request text, amounts, addresses).
- Q-LLM output never appears in a P-LLM prompt except as a placeholder (inspect prompt builders; add a test that injects a marker string into content and asserts it never appears in any P-LLM `user` message).
- S1 secret detectors: every row of the spec table, plus negative cases; on a hit nothing is written to DB8/DB1/DB3/logs.
- Session close clears every row of DB1, DB3, DB8 (and nothing else), `secure_delete` is on, `VACUUM` runs.
- DB5 has no write path except `PUT /v1/settings/limits`; DB2 is written only by `add_contact` after a "Yes" + name.
- Outbound network calls are limited to the hosts in spec §16.4; URL fetching blocks private ranges and non-https.
- Server binds only to 127.0.0.1; tokens are required on every route; UI and report tokens differ.

### 3.3 Spec Compliance Reviewer (Phase 3)

Walk `SPEC_CHECKLIST.md` line by line against the code and tests. For each item mark `implemented + tested`, `implemented, no test`, `missing`, or `deviates (describe)`. Also verify verbatim copies: the five prompt texts (§8.10), all JSON Schemas (§12), question texts (§13.4), error texts (§15), DB DDL (§7.1), config defaults (§6). Report any difference character by character.

### 3.4 Live-Model Evaluator (Phase 3, after the others are clean)

Requires a running local Ollama with the configured model. Run spec §20.3: the acceptance prompts plus 100 paraphrases you generate (keep them in `test/live/prompts.json`, each with the expected plan). Report pairing exact-match rate, question rate and **wrong-hand-off rate, which must be 0**. For any wrong hand-off, report the prompt, the LLM outputs per call, and which code check should have caught it; route it to Lane B (prompts/S3–S5) or Lane D (S8 checks/plan).

### 3.5 Per-lane testers and reviewers (spawned by each lane)

Each lane agent must spawn, at minimum:

- a **Lane Tester** that writes the unit tests for the lane's spec rows (spec §20.1 rows for the lane's modules, plus every rule the lane owns in `SPEC_CHECKLIST.md`) **before or alongside** implementation, and
- a **Lane Reviewer** that, when the lane believes it is done, reviews the diff against the cited spec sections and the ground rules, and lists defects.

The lane fixes every defect, then reports to the Orchestrator.

---

## 4. Lane ownership map

| Lane | Name | Owns (paths) | Spec sections |
| --- | --- | --- | --- |
| A | Platform | `src/index.ts`, `src/config/`, `src/db/` (except `schema.sql`), `src/server/`, `src/session/`, `src/util/` | §5, §6, §7 (repos, clearing, IDs §7.3), §14.1, §14.3, §16.4, §17.1, §17.3, §18 |
| B | Understanding | `src/pipeline/s0-balances.ts` … `s5-spans.ts`, `src/llm/ollama.ts`, `src/llm/prompt-builder/{amounts,requestType,spans,quarantine}.ts`, `src/llm/prompts/{amounts,requestType,spans,quarantine}.txt`, `src/guard/`, `src/quarantine/`, `src/lexical/`, `src/amounts/` | §8.1–§8.6, §8.10 (LLM #1–#3, Q-LLM), §14.4, §14.5 (RPC part), §16.1, §16.3, §17.2 steps 1–3 and 6 |
| C | Recipients | `src/pipeline/s6-resolve.ts`, `src/pipeline/s7-mask.ts`, `src/recipients/` | §8.7, §8.8, §9 (all), §14.5 (ENS + indexer), §17.2 step 4 (placeholder reuse) |
| D | Planning & output | `src/pipeline/s8-pair.ts` … `s12-handoff.ts`, `src/llm/prompt-builder/payments.ts`, `src/llm/prompts/payments.txt`, `src/plan/`, `src/handoff/`, `src/messages/` | §8.9, §8.10 (LLM #4), §8.11–§8.14, §10, §11, §12.3–§12.5, §13.1–§13.3, §14.2, §17.2 steps 4–5 and 7 (plan side) |
| Orchestrator | Contracts & integration | `src/contracts/`, `src/schemas/`, `src/db/schema.sql`, `src/pipeline/registry.ts`, `test/acceptance/`, `test/live/`, root config files, `SPEC_*.md`, `STATUS.md` | §0, §12.1–§12.2 schema files, §13.4/§15 catalogues, §20.2–§20.3, integration |

Tests live next to their owner: `test/unit/<lane-letter>/…`.

---

## 5. Shared contracts the Orchestrator writes in Phase 0

Write these as real TypeScript before any lane starts. They are the only coupling between lanes.

### 5.1 `src/contracts/types.ts`

Transcribe from the spec, exactly:

- `RequestState` and `AgentRequest` (spec §8.0), with concrete types for `LexicalScan`, `AmountItem`, `QItem`, `RecipientSpan`, `ResolvedRecipient`, `RecipientRef`, `Payment` (the S8 item of §12.2 plus `token` filled from DB1), `InternalIntent` and its variants (§12.3), `Schedule`, `CreJob`, `HandoffEnvelope` (§12.5).
- `QuestionCode` union = every code in §13.4. `ErrorCode` union = every code in §15.
- `Question`, `AgentResponse` (§13.4, §14.1), `ExecutionReport` (§14.3).
- `ChainId = 11155111 | 84532 | 421614`, `Token = 'USDC' | 'ETH'`, placeholder template-literal types.

### 5.2 `src/contracts/step.ts`

```ts
export type StepName =
  | 's0' | 's1' | 's2' | 's3' | 's4' | 's5' | 's6' | 's7' | 's8' | 's9' | 's10' | 's11' | 's12';

export type StepResult =
  | { kind: 'continue' }                                         // go to the next step
  | { kind: 'question'; question: Question }                     // pause; resume this step with the answer
  | { kind: 'answer'; messages: string[] }                       // request ends with a reply (balance, refusal)
  | { kind: 'summary'; summary: Summary }                        // S11: wait for confirmation
  | { kind: 'error'; code: ErrorCode; params?: Record<string, string> };

export interface StepContext {
  req: AgentRequest;
  repos: Repos;                // §5.3
  llm: LlmClient;              // §5.4
  rpc: RpcClients;             // §5.5
  ens: EnsClient;              // §5.5
  subnames: SubnameSource;     // §5.5
  exec: ExecutionClient;       // §5.5
  fetcher: ContentFetcher;     // §5.5
  config: Config;
  limits: Limits;              // DB5 snapshot for this request
  now: () => import('luxon').DateTime;   // session timezone
  log: AllowlistLogger;
}

export type Step = (ctx: StepContext) => Promise<StepResult>;
// Called when the pending question of this step is answered. Must validate the answer (spec §13.4)
// and return either the same question with attempt+1, a new question, or continue/error.
export type AnswerHandler = (ctx: StepContext, q: Question, answer: Answer) => Promise<StepResult>;
```

Plus shared function signatures that cross lanes, e.g. `buildBalanceAnswer(ctx): string[]` (Lane D implements, Lane B's S4 calls), `parseAmountText(text, token): ParsedAmount` (Lane B implements, used by question handlers in C/D), `newPlaceholder(kind)` / `newId(kind)` (Lane A implements).

### 5.3 `src/contracts/repos.ts`

One interface per table in spec §7.1 (`Db1AmountPlaceholders`, `Db2AddressBook`, … `Db8Session`) with the exact operations the spec needs (insert/get/list/update/clearAll, `spentToday(token, tz)`, `pendingRecent(chain, token)`, `findActiveAutopays(address)`, `addContact(name, address, chains, ensName)` as one transaction enforcing the name↔address invariant). Lane A implements them; other lanes use in-memory fakes from `test/fakes/repos.ts`, which the Orchestrator also writes.

### 5.4 `src/contracts/llm.ts` and the fixture format

```ts
export type LlmCallName = 'amounts' | 'request_type' | 'spans' | 'payments' | 'quarantine';
export interface LlmClient {
  // Sends one fresh chat with format=schema; validates with Ajv; retries once on error/timeout/invalid
  // (spec §8.10); throws LlmFailed after the second failure.
  call<T>(args: { name: LlmCallName; system: string; user: string; schema: object }): Promise<T>;
}
```

`test/fixtures/llm/<test-id>.json` = `{ "calls": [ { "name": "amounts", "match": "<substring of user message>", "output": { … } , "attempt": 1 } ] }`. The `FixtureLlmClient` returns outputs in order, asserts the name and match, and records every `system`/`user` it received so tests can inspect prompts.

### 5.5 `src/contracts/io.ts`

`RpcClients` (`getEthBalance(chain)`, `getUsdcBalance(chain)`), `EnsClient` (`getAddress(name, coinType)`), `SubnameSource` (`listChildren(parent): Promise<string[] | 'not_found'>`), `ExecutionClient` (`submit(envelope, idempotencyKey)` → `{ status: 'accepted' } | { status: 'rejected'; message } | { status: 'unavailable' }`), `ContentFetcher` (`fetchUrl(url)` → text or error code). Mocks for all of them in `test/fakes/`.

### 5.6 `src/schemas/`

Every JSON Schema of spec §12.1, §12.2 (as a template builder signature), §12.5 copied verbatim, plus `internal-plan.schema.json` generated from §12.3 types. One shared Ajv instance in `src/schemas/index.ts`.

### 5.7 `src/contracts/catalog.ts`

Every question text (§13.4) and error message (§15) verbatim, as typed template functions keyed by code. Lanes must use these; no lane writes user-facing text inline.

### 5.8 `src/pipeline/registry.ts`

Maps `StepName` → `{ step: Step, onAnswer?: AnswerHandler }`, initially all stubs. Lane A's runner executes S0…S12 in order through this registry, pausing on `question`, resuming via `onAnswer`.

---

## 6. Lane briefs (give each lane agent its brief verbatim, plus §1, §4, §5, §7, §8 of this prompt, plus the spec)

### Lane A — Platform

You build the process, storage, API and session machinery that every step runs inside.

Deliver, in this order, each with tests by your Lane Tester:

1. Config loading and validation (spec §6.1), static tables (§6.2), DB5 defaults inserted on first run (§6.3).
2. Keychain key, SQLCipher open with the exact pragmas (§7), migrations running `src/db/schema.sql`, all repositories from `src/contracts/repos.ts` (incl. the `addContact` transaction and invariant, `spentToday` per spec V-15 timezone rules, `pendingRecent` 10-minute window, session clearing §7.4 with `secure_delete` + `VACUUM`).
3. `newId`/`newPlaceholder` (§7.3) with collision retry.
4. Allowlist logger (§18) with rotation.
5. Fastify server on 127.0.0.1 with bearer-token auth (UI vs report tokens), every route in §14.1 and §14.3, body limits, 409 rules, `/v1/health`.
6. Session manager: one open session, open closes previous, close clears; request runner over the registry (S0→S12, pause/resume on questions, `max_attempts` 4 → `TOO_MANY_RETRIES`); the confirmation/answer/cancel table of §17.3 exactly; `HANDOFF_FAILED` retry up to 3.
7. Reports endpoint applying §14.3 to DB6/DB7.
8. Settings API with the validation in §14.1.

Your runner is tested with stub steps that return each `StepResult` kind.

### Lane B — Understanding (S0–S5)

You turn the raw message into verified amounts, a request type and payee spans.

Deliver, each with tests by your Lane Tester:

1. Ollama client (§14.4) implementing `LlmClient` with retry-once; startup model check.
2. S0 balances (§8.1) via `RpcClients`, unavailable-chain handling.
3. S1 guard (§8.2): every secret detector in the table, URL extraction from typed text, attachment handling, fetcher with SSRF and size rules, 20,000-char cap, Q-LLM extraction (prompt + schema verbatim), DB8 writes only after the scan passes.
4. S2 lexical scan (§8.3): every numbered rule, including `eth` chain-vs-token disambiguation, mainnet/unsupported chain errors, chrono spans, numeric candidates.
5. Amount code parser (digits, commas, decimals, k/m/lakh/crore, English number words) exported as `parseAmountText`.
6. S3 (§8.4): LLM #1 prompt verbatim, every verification rule 1–8, all its questions and their answer handlers, relative amounts with chain pinning, document amounts, follow-up token fallback (§17.2 step 6).
7. S4 (§8.5): LLM #2, unsupported/balance/actions handling, recurrence cross-check `Q_RECURRING`, `also_balance`.
8. S5 (§8.6): LLM #3 with candidate list, every filtering rule 1–9, follow-up payee selection (§17.2 steps 2–3, `Q_FOLLOWUP_WHO`), document payees, `Q_NO_PAYEE`.

Prompts are stored as `.txt` files containing the spec text verbatim; the prompt builders only fill the `{…}` slots.

### Lane C — Recipients (S6–S7)

You turn every payee into exactly one confirmed address, and mask it.

Deliver, each with tests by your Lane Tester:

1. Name resolution (§9.1) incl. Levenshtein chips and every `Q_WHO_IS` answer path.
2. Address flow (§9.2): checksum, zero address, `SELF_PAYMENT`, DB2 lookup, `Q_ADDRESS_CORRECT` (incl. the content wording and "Don't pay this one" for untrusted), `Q_ADDRESS_REENTER` loop, name rules, `add_contact` for every allowed chain.
3. ENS (§9.3): normalise, DB2 by `ens_name`, coin types (ENSIP-11) with ENSIP-19 fallback, target-chain logic, `Q_ENS_CHAIN` pinning, rows only for matched chains.
4. ENS re-check (§9.4), every row of its table.
5. Group sends (§9.6): `SubnameSource` against the reference subgraph query, pagination, `Q_GROUP_PARENT`, `Q_GROUP_CHAIN`, member resolution in parallel with timeouts, self/duplicate exclusion, `Q_GROUP_MEMBERS`, DB3 group + member rows (never DB2).
6. Question ordering and attempt counting (§9.7).
7. S7 masking (§8.8) and `masked_text_s8`; follow-up placeholder reuse (no new DB3 rows).

### Lane D — Planning and output (S8–S12)

You pair, plan, validate, summarise and hand off.

Deliver, each with tests by your Lane Tester:

1. S8 (§8.9): LLM #4 prompt verbatim, the per-request schema builder (§12.2: enums, `maxItems` formula), token from DB1, checks P1–P9, retry once with a `CORRECTION:` line, `PAIRING_FAILED`.
2. S9 (§10): spendable (§10.1), group expansion, chain selection (§10.3) incl. silent reuse marking, bridge algorithm with bigint padding/rounding (§10.4), gas check, step numbering and dependencies (§10.5), autopay schedule (§10.6: every table row, occurrences with luxon, caps, `expires_at`, cron), cancel (§10.7) incl. `Q_AUTOPAY_PICK` and `AUTOPAY_NOT_READY`, follow-up chain reuse (§17.2 step 4).
3. S10 (§11): V-01…V-15, `Q_GROUP_OVER_LIMIT` override.
4. S11 summary (§13.1): every line template, note and footer; balance answer (§13.2) as `buildBalanceAnswer`; fixed replies (§13.3).
5. S12 (§8.14): `swap_back` with the field allowlist, base units, checksums, validation against §12.5, execution client (§14.2) with idempotency key and timeout, DB6 rows per §11.4, DB7 pending rows, `db8_history` append.

---

## 7. Contract Change Request format (lane → Orchestrator)

```text
CCR <lane>-<n>
File(s): src/contracts/…
Change: <exact diff or signature>
Why the spec requires it: §<section> "<quote of the rule>"
Impact on other lanes: <none | list>
Workaround until approved: <local stub description>
```

The Orchestrator replies `APPROVED contracts-vN` (and notifies all lanes) or `REJECTED: <reason + how to meet the spec without it>`.

---

## 8. Report format (every sub-agent returns exactly this)

```text
REPORT <agent name>  —  <lane / role>
Status: done | blocked | in progress
Branch / commit: <branch> @ <sha>
Spec items covered: <list of SPEC_CHECKLIST ids>, each "implemented + tested" or not
Tests: <n> written, <n> passing, <n> failing (list failing names)
Files changed: <paths>
Deviations from spec: none | <item, reason, spec section>
Open spec questions: none | <SPEC_QUESTIONS.md entry numbers>
Contract change requests: none | <CCR ids and status>
Needs from other lanes: none | <what, which interface>
Next steps (if not done): <list>
```

The Orchestrator copies the status line and coverage into `STATUS.md`.

---

## 9. `STATUS.md` board (kept by the Orchestrator)

```text
| Lane | Branch | Status | Checklist items done / total | Unit tests passing | Open CCRs | Open questions | Last report |
```

Plus a log of merges (`main` sha, lane, date) and acceptance results (A-01…A-60 pass/fail).

---

## 10. Final acceptance (when you may stop)

All of the following must be true. Then send the human one final report.

1. All four lanes merged into `main`; `npm run typecheck`, `npm run lint`, `npm test` pass on a clean clone.
2. `SPEC_CHECKLIST.md`: every item `implemented + tested`.
3. A-01 … A-60 pass (spec §20.2), including A-60's log grep.
4. Privacy & Security Auditor: zero open findings.
5. Spec Compliance Reviewer: zero deviations; every verbatim artefact matches character for character.
6. Live-Model Evaluator: wrong-hand-off rate 0 on the full set; pairing and question rates reported.
7. `SPEC_QUESTIONS.md`: every entry answered by the human or the spec, and the code matches the answer.
8. `README.md` at repo root is the spec unchanged; a short `DEVELOPING.md` explains setup (Ollama model pull, keychain, tokens, config), how to run each test suite, and how to start the server.

Final report to the human: the §8 report for the whole project, the `STATUS.md` board, live-model metrics, and the list of every `SPEC_QUESTIONS.md` entry with its resolution.

---

## 11. Start now

1. Confirm you have the spec (`README.md`) and read it fully.
2. Do Phase 0. Show me `SPEC_CHECKLIST.md` totals per lane and the list of contract files before spawning lanes.
3. Then spawn Lanes A–D in parallel and proceed through Phases 1–3 without waiting for me, except to ask spec questions in one batched message when needed.
