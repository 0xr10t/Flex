# Hand-off prompt for the next agent

## Latest model and chat request — SQ-M-01 / SQ-CHAT-01

The human subsequently selected `qwen3:8b` and explicitly approved general chat/explanations with thinking on,
keeping wallet extraction off. [QWEN3_CHAT_REPORT.md](QWEN3_CHAT_REPORT.md) records implementation, independent
review, new migration findings and the current verification status. That report and its latest status take
precedence over the older Qwen2.5 totals and demo URLs below. Preserve all existing wording approvals and drafts.

## Later conversational follow-up — SQ-CV-01

The human subsequently reported replies being interpreted as names or trapped in old questions, then explicitly
requested deciding whether a follow-up actually answers the pending question. This overrides the unconditional
answer routing in §17.3. Additional work and its current verification status are in
[CONVERSATION_FIX_REPORT.md](CONVERSATION_FIX_REPORT.md); its latest status takes precedence over the historical
completion totals below. `SPEC_QUESTIONS.md` records the new behavior. Preserve the existing UI wording approvals.

The follow-up is implemented and verified on `a05cb9d`: **2,129 unit/acceptance tests, 205 audits, seven real-model
conversation scenarios**, typecheck, lint and build pass. The complete **154-prompt** rerun has **zero wrong
handoffs**, **129 exact outcomes** and **25 existing stops**, matching all prior final signatures. An independent
reviewer tested each production workstream. The frontend at **http://127.0.0.1:8791** serves the corrected runtime
and passes the actual reported conversation over TCP; the previous port 8790 draft was retained.

## Execution update — 2026-11-06

The requested continuation is implemented: the core fixes branch was independently tested and merged; every finding
and gap in `codex_review_report.md` has a fix and permanent regression coverage. The integrated suite passes 1,874 tests
and the separate audit passes 169. Typecheck, lint, build, and the production TCP startup/report/session smoke test pass.
`DEVELOPING.md` is written. The human approved keeping all three UI texts listed in §5.4 (SQ-CX-01).

The complete 154-prompt local-model run on `33518a2` passes SQ-L-01: **0 wrong handoffs** (previously 2), **25 unexpected
stops** (previously 54), **129 exact expected outcomes**, with no crashes or rejected summaries. All **53 final-toolchain
repeats** of changed results plus A-15 reproduce their primary outcomes on `547a36e`; both formerly wrong cases remain
exact, and independent review accepts the retention gate. A fresh checkout of that revision passes all deterministic
checks. Scoped development-tool security updates are independently verified and integrated: npm audit reports zero
vulnerabilities, including development tools; production dependencies are unchanged.

[LIVE_EVALUATION_REPORT.md](LIVE_EVALUATION_REPORT.md) records raw evidence and metric definitions. Six baseline successes
now stop safely, and **NFR-03's 20-second latency target remains unmet**. The work closes the original review findings
and satisfies the prompt-retention gate; it does not establish blanket compliance with every nonfunctional requirement.

Keep this file and the historical instructions below as provenance. Do not repeat completed implementation work or
delete branches, worktrees, or process documents. No push or deletion was requested or performed.

## Historical handoff — written before remediation

The material below describes the earlier state and explains the work requested. The execution update above and
`STATUS.md` take precedence for current status.

---

You are taking over the **agent-layer build**. It is a local-only TypeScript service that turns a plain-language wallet
request ("send 40 usdc to Aradhya on base") into a confirmed, fully resolved payment plan for an execution layer. The
build is far along: every step is written, merged and tested. A deep review and a live test with the real local model
found defects, and some of the fixes are still in progress. **Your job: finish and verify those fixes, tune the LLM
prompts, re-run the checks, and bring the project to final acceptance.**

Written 2026-11-06 12:20 IST by the previous Orchestrator session (Claude Code, Opus 5.5). No agents are running.

## 0. Ground rules (binding)

- **The repo is local.** Use `/Users/phantomxsd/Flex`. Do not clone: most branches exist only on this machine.
- **Never push to GitHub** without asking the human first.
- The human's answers override the spec. Read §3 before changing behaviour.
- **Never invent behaviour.** If something is not covered by the spec or the answers, ask the human, batching questions
  in plain, non-technical language with a recommended option. The human prefers 1–2 questions at a time.
- Money only as decimal strings or `bigint`. Randomness only from `node:crypto`. Logging only through the allowlist
  logger (`src/util/logger.ts`), never values. No network in unit tests. No secrets in commits.
- Small conventional commits. End each one with your own attribution line.
- `README.md` is the spec and must stay unchanged.
- **Testing rule the human set:** whoever writes production code (`src/**`) does not grade it alone. Use a separate
  tester or reviewer, ideally a different agent or model, for tests and review. The previous setup was Opus for code,
  Sonnet for tests.
- Usage limits have stopped agents several times. Commit after every fix so little is lost.

## 1. Setup

```bash
cd /Users/phantomxsd/Flex
git checkout agentic_layer && git status        # integration branch, expect clean at cae2664 or later
node --version                                  # v25.9.0 is accepted by the human (spec says 22; SQ-11)
npm ci && npm run typecheck && npm run lint && npm test
npx vitest run --config test/audit/vitest.audit.config.ts   # security audit suite (not in the default run)
curl -s http://127.0.0.1:11434/api/tags         # local Ollama with qwen2.5:7b-instruct
```

- **Ollama.** It runs locally (0.40.14) and the model is pulled. If it is down, start it detached:
  `nohup ollama serve > /tmp/ollama.log 2>&1 & disown`. Never point the agent at a non-local model; config only
  accepts `http://127.0.0.1`.
- **Expected on `agentic_layer` @ `cae2664` or later:** typecheck, lint and build pass (leaving out the untracked `test/codex-review/`, see §6); **1,678** unit+acceptance tests pass;
  **168** audit tests pass.
- **Known flaky test.** `test/unit/A/settings.test.ts` "C-346 SQ-A-02e: a missing key → 400" can time out at 5 s under
  load. It passes alone. Its timeout is widened on `phase6/fixes-core`.

## 2. Read, in this order

1. `STATUS.md`: the lane board, merge log, standing decisions, agent history and acceptance results.
2. `SPEC_QUESTIONS.md`: every spec question with its answer. Read the sections **"Answered by the human
   (2026-11-06)"**, **"Review swarm (2026-11-06)"** (SQ-R-01…06) and **"Prompt changes approved"** (SQ-L-01).
3. `SPEC_ANSWERS_FOLLOWUP.md`: the human's follow-up answers F-1…F-13 and the code-change tables.
4. `README.md`: the spec. §0 precedence is §12 → §11 → §8 → everything else; the human's answers come first.
5. `ORCHESTRATOR_PROMPT.md` §3 (test, audit and review roles), §8 (report format) and §10 (final acceptance checklist).
6. `src/contracts/` (types, step semantics, catalog texts, repos, io), `src/pipeline/registry.ts` and `test/fakes/`.
7. `COMPLIANCE_REPORT.md` and `SPEC_CHECKLIST.md` (514 items) for the last compliance status.

## 3. The project in brief

- **Pipeline:** steps S0–S12, in this order:
  - S0: balances.
  - S1: guard (secret scan; untrusted content goes to a quarantined LLM).
  - S2: lexical scan.
  - S3: amounts (LLM #1).
  - S4: request type (LLM #2).
  - S5: payee spans (LLM #3).
  - S6: resolve recipients.
  - S7: mask recipients.
  - S8: pair payments (LLM #4, placeholders only).
  - S9: plan chains, bridges and autopay.
  - S10: validate limits and funds.
  - S11: summary.
  - S12: hand off after the user's "yes".
- **Storage and serving:** one SQLCipher DB (DB1–DB8); a Fastify API on 127.0.0.1; Ollama for the LLM.
- **Code map:** `src/pipeline/sN-*.ts` and the folders `src/{guard,quarantine,lexical,amounts,recipients,plan,handoff,messages,session,server,db,config,util}`.
- **Tests:** `test/unit/{A,B,C,D,contracts}`, `test/acceptance` (A-01…A-60 over HTTP with LLM fixtures), `test/audit`
  (security), and `test/live` (the real model).

**Key human decisions already built in** (full list in `SPEC_QUESTIONS.md`):
- A one-time "go ahead this once?" question (`Q_LIMIT_OVERRIDE`) for any broken limit. It is asked only when every
  amount was typed by the user, never for attached-content amounts.
- `Q_PAIR_AMOUNT` ("Who should get X?") when pairing is unclear: several recipients, or the amount and recipient in
  different sentences.
- `Q_NAME_ROLE` ("Should I pay {name}?") when the same name is labelled both payee and mentioned.
- Every repeat of a tagged name is masked before LLM #4. Only exact whole-word repeats count (SQ-R-01).
- `urls[]` and redirect targets are secret-scanned. Extra SSRF ranges are blocked.
- New reply texts:
  - unsupported: "…bridge funds between chains when a payment needs it…";
  - cancel after a hand-off;
  - the three-failure wallet texts;
  - "not enough funds" with a per-chain list.
- Contracts are at `contracts-v4` (local tag), with question codes `Q_LIMIT_OVERRIDE`, `Q_PAIR_AMOUNT` and
  `Q_NAME_ROLE`, and the flag `limit_override`.

## 4. Where things stand (2026-11-06 12:20)

| Branch | State |
| --- | --- |
| `agentic_layer` @ `cae2664` | Integration branch. All lanes, the human answers, the understanding fixes and the live-test files are merged. Green. |
| `phase6/fixes-core` @ `a0e6848` | **Not merged. Its agent was stopped with the fixes committed but the tests unfinished.** Typecheck and lint pass, but **23 of 1,653 tests fail (7 files)**. They are mostly old tests that still expect the previous behaviour: `INSUFFICIENT_FUNDS` `{need}` now includes the bridge padding (C-214, C-381, C-202, C-211, the SQ-08/F-10 cases), and the new P10 schedule check changes the P5/P6/P7 tests (C-136, C-137, C-138). Decide each failure: test update or real bug. The worktree is `.claude/worktrees/agent-a5c5d6aa3f7e3b28c` and is clean. |
| `phase7/prompts` @ `cae2664` | **Its agent was stopped before any commit.** Prompt tuning has not started (§5.2). |
| `phase2…phase6/*`, `lane/*` | Old, already merged. Their worktrees under `.claude/worktrees/` can be deleted after the human agrees. |

Results so far:
- **Six-reviewer deep review:** 19 code defects, none critical.
  - The most serious: a session close or open racing an in-flight hand-off, which could cause a double payment. It is
    fixed on `phase6/fixes-core`.
  - The understanding/recipients defects are fixed and merged.
- **Live model (qwen2.5:7b, 154 prompts):**
  - Wrong hand-offs: **2**. Both are the same defect: "for 4 weeks" was read as "every 4 weeks". A code check (P10) is
    on `phase6/fixes-core`.
  - S8 pairing exact: 98.8%. Exact plans: 77/119.
  - 54 needless stops; nothing wrong was sent in any of them.
  - Latency: median 13.6 s, p95 30.8 s (spec target 20 s).
  - Results are in `test/live/results/*.json` with `llm_trace`.
- **Compliance:** the earlier run had 503/514 checklist items implemented and tested, before the answer changes.
  Re-run it at the end.

## 5. What to do, in order

### 5.1 Finish and merge `phase6/fixes-core`

Inspect the branch: `git log 7af6321..phase6/fixes-core`. Its commits claim these fixes:
- **Session race (R1-F1 / R5-2).** Open and close wait for the call in flight, and S12 snapshots the names it needs.
- **R5-1.** A failure to write after the wallet's 2xx still answers HANDED_OFF and logs `S12_RECORD_FAILED`.
- **R1-F3.** `/cancel` for an earlier handed-off request replies `REPLY.CANCEL_AFTER_HANDOFF`.
- **SQ-R-04.** An `autopay_payment` report with a duplicate `tx_hash` is accepted but ignored.
- **R6-3.** Unicode format characters are stripped from the wallet's refusal message.
- **SQ-R-03.** `per_period_cap` = min(window × amount, `total_cap`).
- **R4-F4.** `INSUFFICIENT_FUNDS` `{need}` includes the bridge padding.
- **R3-2.** An untrusted ENS payee is limited to its record's chains.
- **SQ-R-05.** If an autopay's start is in the past at confirm, the agent asks `Q_AUTOPAY_START` and re-plans.
- **R4-F2.** The override lifts only the limits it named and re-asks for new ones.
- **R4-F1 + R1-F2.** `Q_PAIR_AMOUNT` asks for every amount, each question with its own attempt counter.
- **SQ-R-02.** A distributive word applies only to its own clause.
- **P10 (live-model fix).** A schedule-field check in `src/plan/pairing-checks.ts`: `interval` > 1 only if the clause
  says "every other / every N / fortnightly"; days of week only if named; day of month only if named. A failure triggers
  the CORRECTION retry, then `PAIRING_FAILED`.

**Still to do on this branch** (checked at 12:20):
1. **Fix the 23 failing tests.** For each one, decide whether the test is outdated or the code has a bug. Outdated tests
   are updated by a tester, not by the code author. Run `npm test` and read every failure.
2. **SQ-R-06:** the catalog has the new text "Cancelled here, but your wallet may already have received it. Check your
   wallet." Verify that cancelling in `HANDOFF_FAILED` after a timeout actually uses it, and test it.
3. **LIVE-P061 / LIVE-P073 regression tests are missing.** Use the two real LLM #4 outputs:
   - `{weekly, interval:4, days:["MON"]}` for "pay mihir 5 usdc every monday for 4 weeks";
   - `{monthly, interval:4, day_of_month:31}` for "pay aradhya 10 usdc every month on the 31st for 4 months".

   Wrong twice → `PAIRING_FAILED`; wrong then right → the correct plan. Positive cases: "every other friday" → 2,
   "every 2 weeks" → 2, "fortnightly" → weekly/2.
4. **Regression tests for every fix above.** Each should fail before its fix, titled with the finding id (`R1-F1`,
   `SQ-R-05`, `R4-F1`, …). Reviewer repro tests were in a session scratchpad that may be gone; rewrite them from the
   descriptions.
5. **Widen the flaky settings-test timeout.**

Then:
- Run typecheck, lint, `npm test` and the audit suite on the branch.
- Get an independent review of its diff (`git diff 7af6321...phase6/fixes-core`) against the cited answers.
- Merge it into `agentic_layer` with `--no-ff` and re-run everything.
- Expect conflicts only in tests or `SPEC_QUESTIONS.md`; `phase6/fixes-understanding` touched different `src` files.

### 5.2 Tune the prompts against the real model (human-approved, SQ-L-01)

- **The approval.** The human allowed changing the §8.10 prompt texts in `src/llm/prompts/*.txt`, plus narrow code
  normalisation of LLM output. A change is kept **only if wrong hand-offs stay 0 and needless stops fall**, measured on
  the full live set.
- **Recording.** Record every change, with old text, new text, reason and live evidence, in a new `PROMPT_CHANGES.md`.
- **What not to change.** Keep the `{…}` slots and the §12 JSON schemas unchanged.
- **Prompt tests.** Update the prompt-verbatim tests to the approved text.

Problems found (each one reproduced with direct Ollama calls):

1. **LLM #1 (S3) copies the whole message as `phrase`.** This caused about 15 stops, mostly `Q_NO_PAYEE`. The cause is
   the line "phrase: the exact characters from the message, copied without any change".
   - Tested replacement that works: "phrase: only the few words that state the amount (for example "50 usdc",
     "fifty bucks", "half my eth"), copied exactly as written. Never the whole message."
   - Side effect to fix: in "Mihir lent me 100 usdc… Send him 30 back" it then set `fiat:"USD"` on "usdc" phrases. State
     that fiat applies only to $, dollars, bucks, usd and other currencies, never to usdc.
   - Also consider a code guard in S3: a phrase much longer than the amount words (it contains a recipient, or more than
     about 6 words) is invalid output; retry once and never mask a whole sentence.
2. **LLM #1 invents a `number:null` context row whose phrase is the whole message when there is no amount.** This caused
   about 10 stops: "stop paying mihir" → `UNSUPPORTED_REQUEST`, and balance questions failed.
   - Tested fix: add the rule "If the message states no amount at all, return {"amounts":[]}" and the example
     "Message: stop paying riya → {"amounts":[]}".
3. **LLM #2 (S4) returns `actions:["i","i"]` for two payments.** This caused 9 `MODEL_FAILED`. Ollama's constrained
   decoding cannot enforce `uniqueItems`, so Ajv rejects the output and the retry repeats it.
   - Fix: deduplicate `actions` in code before validation. Keep it narrow and tested.
   - Also add "list each kind at most once" to the prompt.
   - Confirmed: "send amount_x to mihir and amount_y to aradhya" → `["i","i"]`.
4. **LLM #4 (S8) reads a duration as an interval** ("for 4 weeks" → `interval:4`). The code check P10 is in §5.1. Also
   add to `payments.txt`: interval is how often; "for N weeks/months/payments" is how long and never the interval.
5. **Smaller misreads:**
   - "3 times a week until I cancel" left `frequency` null (A-10).
   - "for 4 weeks" was not read as the end (P-072).
   - `Q_RECURRING` was asked for "twice a week" and "every day" (P-065, P-074).
   - "split 30…" gave `UNSUPPORTED_REQUEST` instead of `SPLIT_UNSUPPORTED` (A-39, P-096).
   - "all iitr.eth members" was not tagged as a group (P-084, P-085).
   - "transfer 20 usdc to myself" gave `Q_WHO_IS`; it should be `Q_NO_PAYEE` (P-046), because "me", "my", "I" and
     "myself" are never payees.

**Method:**
- Change one thing at a time and probe it with a direct `/api/chat` call (system and user messages, `format` = the
  schema, temperature 0, seed 42, `num_ctx` 8192).
- Then run `LIVE_SET=all npm run test:live` (about 35 min) and `node test/live/summarize.mjs`.
- Temperature 0 with seed 42 is not fully deterministic across runs, so re-run any prompt whose result flips.
- **The simulated user** in `test/live/live.test.ts` now also checks the repeat interval. A summary that does not match
  the expected plan counts as rejected, and the spec §20.3 bar is "no wrong hand-off".

### 5.3 Re-run the checks

1. Full suites: typecheck, lint, `npm test`, the audit suite and `npm run build`.
2. **Live-model evaluation:** the full set, with the wrong-hand-off count required to be **0**. Report pairing
   exact-match, question rate, the stops and latency.
3. **Compliance re-check:** walk `SPEC_CHECKLIST.md` again and update `COMPLIANCE_REPORT.md`. Record every
   human-approved difference from the spec:
   - the `UNSUPPORTED_REQUEST` text (F-7);
   - the new questions and texts;
   - the prompt changes (SQ-L-01).
4. Optionally, a focused re-review of `phase6/fixes-core` and the prompt changes.

### 5.4 Finish

1. Write a short `DEVELOPING.md`:
   - setup (Node, `npm ci`, the native SQLCipher module, keychain, token files, `config.example.json`, Ollama with
     `ollama pull qwen2.5:7b-instruct`);
   - how to run each suite (unit, acceptance, audit, live);
   - how to start the server (`npm run build && npm start`, config via `AGENT_CONFIG`).
2. Go through `ORCHESTRATOR_PROMPT.md` §10 (final acceptance) and update `STATUS.md`.
3. **Ask the human:**
   - before pushing any branch or tag to GitHub;
   - before deleting old worktrees and branches;
   - to confirm three interim texts the earlier agents wrote:
     - the `Q_PAIR_AMOUNT` re-ask hint "That would leave {name} with nothing.";
     - the `Q_LIMIT_OVERRIDE` chips "Yes, this once" / "Yes, set it up" / "No";
     - the daily fragment "today's limit of {daily_max} (only {remaining} is left)".
4. When everything is done, remove the files that are only for the build process: `ORCHESTRATOR_PROMPT.md`,
   `SPEC_ANSWERS_FOLLOWUP.md` (fold its answers into `SPEC_QUESTIONS.md` first) and this file. Ask the human first.

## 6. Gotchas

- **`test/codex-review/` is untracked and was not written by the build agents.** It appeared between 11:48 and 12:12 on
  2026-11-06 and holds 7 test files (`sessions`, `understanding`, `recipients`, `planning`, `reports`, `live-model`,
  `answer-secrets`). While it exists, `npm run typecheck` fails (`live-model.test.ts:106`, a chain-id type) and
  `npm run lint` fails (`planning.test.ts`, `answer-secrets.test.ts`). The vitest `include` (`test/unit`,
  `test/acceptance`) does not pick it up. Everything committed on `agentic_layer` is clean when this folder is left out.
  **Ask the human what it is before using, fixing, committing or deleting it.** If it is a second review's tests, they
  may be worth running against the fixes.
- **Worktrees.** Every `.claude/worktrees/agent-*` folder is an old agent's git worktree, and some are "locked". Do not
  edit them; work in the main checkout or a new branch. Deleting them needs the human's OK.
- **The audit suite** is not in the root vitest `include`. Run it with
  `npx vitest run --config test/audit/vitest.audit.config.ts`.
- **Fixture placeholders.** The acceptance fixtures use `$amount:N`, `$recipient:N` and `$session:N`, filled from the
  prompts the pipeline built (`test/acceptance/harness.ts`). After editing fixtures, rebuild them with
  `node test/acceptance/build-fixtures.mjs`.
- **Prompt files** live in `src/llm/prompts/*.txt` as `SYSTEM\n…\nUSER\n…`. `npm run build` copies them to `dist/`.
- **Spec example addresses** are not EIP-55; the code checksums them (SQ-O-04). Tests use `getAddress(...)`.
- **Load.** Several agents at once overload this Mac: tests time out and Ollama slows down. Run the live set when
  nothing else is running.
- **Interim behaviour** for anything the spec does not cover returns `UNSUPPORTED_REQUEST` and logs
  `event: "unsupported_state"` with a `rule_id`. New gaps go into `SPEC_QUESTIONS.md` and then to the human.

## 7. Report back to the human

Keep it short and plain. Say what was fixed, the live-model numbers (wrong hand-offs first), the test totals, what is
left, and any questions, batched with a recommendation each.
