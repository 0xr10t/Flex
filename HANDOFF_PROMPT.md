# Hand-off prompt: paste everything below the line into your coding agent (e.g. Claude Code)

The agent should be started in an **empty folder** on your machine. It sets everything up from scratch.

---

You are taking over as the **Orchestrator** of the "agent layer" build in GitHub repo https://github.com/0xr10t/Flex,
branch `agentic_layer`. A previous Orchestrator finished Phase 0 (skeleton + frozen contracts) and started Phase 1
(four parallel build lanes), then stopped when its usage ran out. Your job: set up this machine from scratch, check the
real state of every lane, then continue the build to the end. Do not start over and do not redo Phase 0.

## Step 1 — Set up the machine (do this first, report anything you couldn't install)

Check each tool and install what is missing (ask me before anything that needs my password / sudo):

1. **git**: `git --version`.
2. **Node.js 22 LTS** (the spec requires Node 22; `package.json` says `>=22`). Prefer nvm:
   `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`, then
   `nvm install 22 && nvm use 22`. Confirm `node --version` prints v22.x and `npm --version` works.
3. **Native build tools** for `better-sqlite3-multiple-ciphers` (SQLCipher), which usually installs a prebuilt binary
   and only compiles as a fallback. macOS: `xcode-select --install`. Linux: `build-essential` and `python3`.
   Windows: use WSL2.
4. **Ollama**, needed only for the live-model evaluation (Phase 3); unit and acceptance tests never call it.
   Install from https://ollama.com, then `ollama pull qwen2.5:7b-instruct`. Confirm with `ollama list`.
5. *(Optional)* **GitHub CLI** `gh` (`gh auth login`) if I want you to push or open PRs later.
6. **OS keychain**: the app stores its DB key with `@napi-rs/keyring` (macOS Keychain / libsecret on Linux). Tests
   use a fake keychain, so this matters only when running the real server.

## Step 2 — Get the code and all lane branches

```bash
git clone --branch agentic_layer https://github.com/0xr10t/Flex.git
cd Flex
git fetch origin 'refs/heads/lane/*:refs/remotes/origin/lane/*' --tags
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

Expected on `agentic_layer`: typecheck, lint, 14 tests and the build all pass. If not, stop and tell me why.
Ignore the remote default branch `master`: it is an old commit with only a plan file.

## Step 3 — Read, fully and in this order

1. `HANDOFF.md`: current state, what is left, decisions already taken, gotchas.
2. `ORCHESTRATOR_PROMPT.md`: your role and the process (phases, lanes, testers/reviewers, CCRs, report format).
   Wherever it says "`main`", read `agentic_layer`.
3. `README.md`: **the spec, and the source of truth for every behaviour, text, schema and number**.
4. `LANES.md`: lane conventions, frozen files, where CCRs and spec questions go, the shared helpers every lane must
   reuse, and the exact export names you will wire in Phase 2.
5. `STATUS.md`, `SPEC_QUESTIONS.md` (SQ-01…SQ-20; the interim answers are binding), and the Totals of
   `SPEC_CHECKLIST.md` (514 items, each with one owner).
6. Every file in `src/contracts/`, plus `src/schemas/index.ts`, `src/pipeline/registry.ts` and `test/fakes/`.

## Step 4 — The project in one paragraph

A local-only TypeScript (Node 22, ESM, strict) service. It takes a plain-language wallet request ("send 40 usdc to
Aradhya on base") and runs it through a fixed pipeline of steps S0–S12:

- S0: refresh balances;
- S1: guard (secret detector, untrusted content read by a quarantined LLM);
- S2: lexical scan;
- S3: amounts (LLM #1);
- S4: request type (LLM #2);
- S5: payee spans (LLM #3);
- S6: resolve recipients (address book, ENS, groups);
- S7: mask recipients;
- S8: pair payments (LLM #4, constrained to placeholders);
- S9: plan chains, bridges and autopay schedules;
- S10: validate limits and funds;
- S11: summary;
- S12: hand-off to the execution layer after the user says "yes".

Money is decimal strings / bigint only. Data lives in one SQLCipher DB (tables DB1–DB8). The HTTP API is Fastify on
127.0.0.1. The LLM is local Ollama only.

## Step 5 — The four lanes (each is a branch; none is reviewed or merged yet)

Every lane branch was cut from tag `contracts-v2`. Lanes may edit only their own paths (ORCHESTRATOR_PROMPT §4). Shared
contracts are frozen and owned by you.

**Lane A — Platform** · branch `lane/a-platform` (commit `3f9ca24`)
- *Owns:* `src/index.ts`, `src/config/`, `src/db/` (not `schema.sql`), `src/server/`, `src/session/`, `src/util/`,
  `test/unit/A/`.
- *Spec:* §5, §6, §7, §14.1, §14.3, §16.4, §17.1, §17.3, §18.
- *On the branch:*
  - config load/defaults/token files;
  - SQLCipher open with keychain key and migrations;
  - all eight repositories;
  - allowlist logger with rotating file;
  - Fastify app (sessions, messages, answers, confirm, cancel, settings, reports, health);
  - session manager and request runner.
- *Left:* all Lane A unit tests (none written yet); check the runner against the header of `src/contracts/step.ts`
  and the §17.3 table; reviewer pass.

**Lane B — Understanding (S0–S5)** · branch `lane/b-understanding` (commit `55c4642`)
- *Owns:* `src/pipeline/s0…s5`, `src/llm/ollama.ts`, `src/llm/prompt-builder/{amounts,requestType,spans,quarantine}.ts`,
  `src/llm/prompts/*.txt` (except `payments.txt`), `src/guard/`, `src/quarantine/`, `src/lexical/`, `src/amounts/`,
  `test/unit/B/`.
- *Spec:* §8.1–§8.6, §8.10 (LLM #1–#3, Q-LLM), §14.4, §14.5 (RPC), §16.1, §16.3, §17.2.
- *On the branch:*
  - amount parser (`parseAmountText`);
  - secret detectors;
  - URL handling and SSRF-safe fetcher;
  - lexical scan with chrono;
  - prompt `.txt` files and builders;
  - Ollama client;
  - Q-LLM extraction;
  - steps S0, S1, S2.
- *Left:* steps **S3, S4, S5** with their question answer handlers; all Lane B unit tests (none yet), including the
  §16.1 test that no untrusted text ever reaches a P-LLM prompt; reviewer pass.

**Lane C — Recipients (S6–S7)** · branch `lane/c-recipients` (commit `a6be84d`)
- *Owns:* `src/pipeline/s6-resolve.ts`, `src/pipeline/s7-mask.ts`, `src/recipients/`, `test/unit/C/`.
- *Spec:* §8.7, §8.8, §9, §14.5 (ENS + indexer), §17.2 step 4.
- *On the branch:*
  - names with Levenshtein chips;
  - address flow;
  - ENS resolution and ENS client;
  - ENS re-check;
  - group sends with subname source;
  - S6 and S7.
  53 tests pass.
- *Left:* finish `test/unit/C/names.test.ts` and the remaining C checklist rows; reviewer pass.

**Lane D — Planning & output (S8–S12)** · branch `lane/d-planning` (commit `cc981ba`)
- *Owns:* `src/pipeline/s8…s12`, `src/llm/prompt-builder/payments.ts`, `src/llm/prompts/payments.txt`, `src/plan/`,
  `src/handoff/`, `src/messages/`, `test/unit/D/`.
- *Spec:* §8.9–§8.14, §9.5, §10, §11, §12.3–§12.5, §13.1–§13.3, §14.2.
- *On the branch:* only unfinished tests for S8 and the LLM #4 prompt. **It does not typecheck yet**, because those
  tests import modules that don't exist.
- *Left:* everything:
  - S8 pairing with checks P1–P9 and retry;
  - S9 chains, bridges, autopay schedule and cancel;
  - S10 rules V-01…V-15;
  - S11 summary and `buildBalanceAnswer`;
  - S12 hand-off with the execution client;
  - all tests and the reviewer pass.

## Step 6 — Verify, report, then continue

1. For each lane: `git diff contracts-v2...origin/lane/<x> --stat`, then check it out in a scratch worktree and run
   `npm ci`, typecheck, lint and test. Record the real state in `STATUS.md`. Don't trust lane code you haven't
   checked against the spec.
2. Show me:
   - a short status table;
   - the setup results from Step 1;
   - the open spec questions (SQ-01, 03, 04, 05, 06, 07, 08, 09, 11, 15, 18) in one batched message.
3. Continue Phase 1. Spawn one background lane agent per unfinished lane, each with `isolation: "worktree"`. Give each:
   - its brief from `ORCHESTRATOR_PROMPT.md` §6, word for word;
   - that lane's "Left" list from Step 5 above;
   - the instruction to read `LANES.md`, `README.md` and `src/contracts/`;
   - this first command: `git checkout -b lane/<x> origin/lane/<x> && npm ci`. **Agent worktrees otherwise start
     from `master`, which has none of the files.**

   Each lane must use a Lane Tester and a Lane Reviewer sub-agent, commit only to its own branch, and finish with the
   ORCHESTRATOR_PROMPT §8 report.
4. While lanes run, follow ORCHESTRATOR_PROMPT §2 Phase 1: answer CCRs, publish approved contract changes as
   `contracts-v3`, `contracts-v4`, …, keep `STATUS.md` current, and don't write lane code yourself. Then:
   - **Phase 2:** merge into `agentic_layer` in order A → B → C → D, running the full suite after each merge. Then
     add `src/llm/prompt-builder/index.ts`, wire the real steps into `src/pipeline/registry.ts` and the production
     factories into `src/index.ts`, and build the acceptance harness with A-01…A-60.
   - **Phase 3:** run the privacy/security auditor and the spec-compliance reviewer in parallel, then the live-model
     evaluator (needs Ollama + `qwen2.5:7b-instruct`).
   - **Final:** the ORCHESTRATOR_PROMPT §10 acceptance, including a short `DEVELOPING.md`.

## Ground rules (ORCHESTRATOR_PROMPT §1), always

- The spec decides.
- Never invent behaviour. If something is unclear, add it to `SPEC_QUESTIONS.md` and make that path return
  `UNSUPPORTED_REQUEST`.
- Contracts are frozen; changes go through CCRs.
- Money only as decimal strings / bigint.
- Randomness only from `node:crypto`.
- Logging only through the allowlist logger (never log values).
- No network in unit tests.
- No secrets in commits.
- Small conventional commits ending with your own attribution line.
- **Ask me before pushing to GitHub**, and batch every spec question for me in one message.
