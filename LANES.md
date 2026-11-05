# LANES — integration conventions (Orchestrator-owned, contracts-v2)

Every lane reads this together with `ORCHESTRATOR_PROMPT.md` (§1, §4, §5, §7, §8 and its own brief in §6) and the
spec `README.md`. The Orchestrator wires everything in Phase 2 using exactly the export names below.

## Branches and setup

- Integration branch: `agentic_layer` (= "`main`" in ORCHESTRATOR_PROMPT.md). Lane branches: `lane/a-platform`,
  `lane/b-understanding`, `lane/c-recipients`, `lane/d-planning`, created from tag `contracts-v2`.
- After checkout run `npm ci`. Definition of done: `npm run typecheck`, `npm run lint`, `npm test` all pass.
- Commits: conventional (`feat(s3): …`, `test(plan): …`), lane branch only, never force-push, never touch `agentic_layer`.
  End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Frozen files (Orchestrator only)

`src/contracts/**`, `src/schemas/**`, `src/db/schema.sql`, `src/pipeline/registry.ts`, `test/fakes/**`,
`test/acceptance/**`, `test/live/**`, root config files (`package.json`, `tsconfig*.json`, `eslint.config.js`,
`.prettier*`, `vitest*.ts`), `SPEC_*.md`, `STATUS.md`, `LANES.md`, `README.md`, `ORCHESTRATOR_PROMPT.md`,
`src/llm/prompt-builder/index.ts`.

Need a change there? Write a CCR (ORCHESTRATOR_PROMPT §7 format) to `ccr/<LANE>-<n>.md` in your branch, keep working
against a local stub inside your own directories, and list the CCR in your report. Need a new npm package? That is a
CCR too (package.json is frozen).

## Spec questions

Do not edit `SPEC_QUESTIONS.md`. Append new questions to `spec-questions/<LANE>.md` in your branch (section, question,
what the code does now) and make that code path return `UNSUPPORTED_REQUEST` (spec §0). Existing interim answers in
`SPEC_QUESTIONS.md` (SQ-01 … SQ-20) are binding until the human answers.

## Shared code you must use (do not re-implement)

| Need | Use |
| --- | --- |
| Types, codes, request object | `src/contracts/types.ts` |
| Step contract + runner semantics | `src/contracts/step.ts` (read the header comment: `continue` from an AnswerHandler re-enters the same step; steps must be re-entrant via `req.step_state`) |
| Repositories | `src/contracts/repos.ts`; in tests `test/fakes/repos.ts` |
| LLM | `src/contracts/llm.ts`; in tests `FixtureLlmClient` (`test/fakes/llm.ts`) |
| RPC / ENS / indexer / execution / fetcher / logger | `src/contracts/io.ts`; in tests `test/fakes/io.ts` |
| Test context with §19 contacts | `makeTestContext()` in `test/fakes/context.ts` |
| User-facing text, chips, question builder, re-ask, chip matching | `src/contracts/catalog.ts` (no inline user text anywhere) |
| §6.2 word lists, §17.3 texts | `src/contracts/static-tables.ts` |
| Decimal ↔ base units, bigint mul/div rounding, short address | `src/contracts/money.ts` |
| JSON Schemas, shared Ajv, S8 schema template | `src/schemas/index.ts` |
| IDs / placeholders | `newId` / `newPlaceholder` in `src/util/ids.ts` (Lane A); placeholders are minted by `repos.dbN.mint` |
| Amount text parser | `parseAmountText` in `src/amounts/parse.ts` (Lane B; others mock it with `vi.mock` until merged) |
| Balance answer | `buildBalanceAnswer` in `src/messages/balance.ts` (Lane D; Lane B mocks it until merged) |

## Exports the Orchestrator will wire (exact names)

| Lane | File | Export |
| --- | --- | --- |
| A | `src/db/repos/index.ts` | `createRepos(db: Database): Repos` |
| A | `src/db/open.ts` | `openDatabase(path: string, keyHex: string): Database` (pragmas §7 + migrate) |
| A | `src/util/logger.ts` | `createLogger(opts): AllowlistLogger` |
| A | `src/server/app.ts` | `createApp(deps: AppDeps): FastifyInstance` — `AppDeps` defined by Lane A, must accept injected `Repos`, `LlmClient`, `RpcClients`, `EnsClient`, `SubnameSource`, `ExecutionClient`, `ContentFetcher`, `AllowlistLogger`, `Config`, the step registry and the tokens |
| A | `src/session/manager.ts` | `SessionManager` (runner over `registry`) |
| A | `src/index.ts` | `main()` — wires A's own pieces; other lanes' factories are wired by the Orchestrator in Phase 2 |
| B | `src/llm/ollama.ts` | `createOllamaClient(config: Config, log: AllowlistLogger): LlmClient` |
| B | `src/pipeline/s0-balances.ts` | `s0: StepEntry`, `createRpcClients(config: Config): RpcClients` |
| B | `src/quarantine/fetch.ts` | `createContentFetcher(config: Config): ContentFetcher` |
| B | `src/pipeline/s1-guard.ts` … `s5-spans.ts` | `s1` … `s5: StepEntry` |
| B | `src/amounts/parse.ts` | `parseAmountText` (replace the stub) |
| B | `src/llm/prompt-builder/{amounts,requestType,spans,quarantine}.ts` | `buildAmountsPrompt`, `buildRequestTypePrompt`, `buildSpansPrompt`, `buildQuarantinePrompt` |
| C | `src/pipeline/s6-resolve.ts`, `s7-mask.ts` | `s6`, `s7: StepEntry` |
| C | `src/recipients/ens-client.ts` | `createEnsClient(config: Config): EnsClient` |
| C | `src/recipients/subnames.ts` | `createSubnameSource(config: Config): SubnameSource` |
| D | `src/pipeline/s8-pair.ts` … `s12-handoff.ts` | `s8` … `s12: StepEntry` |
| D | `src/handoff/execution-client.ts` | `createExecutionClient(config: Config, outboundToken: string): ExecutionClient` |
| D | `src/llm/prompt-builder/payments.ts` | `buildPaymentsPrompt` |
| D | `src/messages/balance.ts` | `buildBalanceAnswer` (replace the stub) |

## Cross-lane data hand-offs inside `AgentRequest`

- S5 (B) fills `req.spans` (payees only; follow-up payees with `followup_placeholder`; document payees with
  `source: 'untrusted'`). S6 (C) fills `req.resolved` aligned with `req.spans`. S7 (C) fills `req.recipients` and
  `req.masked_text_s8`.
- S3 (B) fills `req.amounts` (+ DB1) and `req.masked_text_s3`; S4 fills `request_type`, `actions`, `also_balance`.
- S8 (D) reads `req.amounts`, `req.recipients`, `req.untrusted` (DOCUMENT ITEMS), `req.scan.chains`, `req.actions`,
  `repos.db8.recentHistory` (SESSION), and fills `req.payments`. S9–S12 (D) fill `req.plan`, `req.summary`,
  `req.envelope`.
- Notes go into `req.notes` using `NOTES.*` from the catalog. Messages to show before the main reply go into
  `req.prepend_messages`.

## Tests

`test/unit/<A|B|C|D>/…`. Every test title starts with the spec row it covers, e.g. `it('§8.3 rule 5: eth after "on" is a chain', …)`
or `it('A-38: "each" shares one amount', …)`. No network in unit tests.
