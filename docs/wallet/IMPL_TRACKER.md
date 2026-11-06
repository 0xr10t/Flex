# Wallet implementation tracker

The running record of wallet work. Newest entries first in the log. The plan is in [README.md](README.md).

## Status

| Part | State | Notes |
| --- | --- | --- |
| 0 Prerequisites | In progress | See "Part 0 tasks" below |
| 1 Schemas and mapping | Done | 137 tests pass; typecheck, ESLint and Prettier clean on `wallet/`. Changed by C-1 to C-5 |
| 2 Service and runner | Not started | Needs OQ-04, OQ-08 |
| 3 Account and signing | Not started | OQ-01 decided; needs OQ-02, OQ-19 |
| 4 Payments `i` | Not started | |
| 5 Bridges `j` | Not started | Needs OQ-07 |
| 6 Executor contract | Not started | Live deploy needs OQ-16, OQ-17 |
| 7 Autopay `k` | Not started | Needs OQ-09, OQ-10, OQ-11 |
| 8 Cancel `l` | Not started | |
| 9 CRE workflow | Not started | Needs OQ-16, OQ-18 |
| 10 Run reporting | Not started | Needs OQ-14 |
| 11 Integration and live | Not started | Needs agent v1.1 (OQ-05) |

## Part 0 tasks

| ID | Task | State |
| --- | --- | --- |
| W0-01 | Blocking decisions | OQ-01 decided; OQ-03 provisional; OQ-02, 04, 06 open |
| W0-02 | Owner for agent v1.1 | Open |
| W0-03 | Fork suite run | Run once; see findings F-1 to F-4 |
| W0-04 | Settle `bridge_buffer_pct` | **Not settled; forks cannot settle it** (F-7). Needs W0-07 |
| W0-05 | CRE deploy access | Open: needs the user |
| W0-06 | Fund a testnet wallet | Open: needs the user |
| W0-07 | Real CCIP send | Open: needs W0-06 |
| W0-08 | Verify USDC addresses against Circle's list | Open |
| W0-09 | Bring lab sources into the repo | Done for Part 1 files |

## Decisions

| Id | Decision | Made by | Date |
| --- | --- | --- | --- |
| OQ-01 | **Option A.** The wallet holds the key, encrypted on the user's device. The user approves each payment in the wallet, and the wallet then signs | User | 2026-11-06 |

## Provisional choices

Made so that work can continue. Each one is easy to change and has not been approved.

| Id | Choice | Why |
| --- | --- | --- |
| OQ-03 | Code lives in `wallet/`, a separate package with its own lockfile, on Node 22 and TypeScript. Library versions match the lab lockfile | The plan's recommendation. Keeps the agent's dependencies untouched |
| OQ-09 | `intentId` is derived from `request_id` + `step` (`intentIdFor`), instead of random | A random id could allow a second live plan after a crash |
| OQ-12 | Plan limit raised to 16 steps, in the JSON schema and `PlanSchema` | C-3 in `ARCHITECTURE_CHANGES.md`. 8 refused valid requests |
| C-1 to C-5, R-1, R-2 | The changes in `ARCHITECTURE_CHANGES.md` | Requested by the user on 6 Nov. The exact changes still need the user's and the agent owner's confirmation |
| OQ-13 | `IntentSchema` keeps its 52-week cap, unchanged | It is the tested schema |
| — | An `l` needs its delegation hash passed in. Without it, `checkEnvelope` rejects at stage `consistency` | Part 1 asked for this to be picked and recorded; Part 8 supplies the read |

## Findings

| Id | Finding | Evidence | Effect |
| --- | --- | --- | --- |
| F-1 | `docs/spec/TEST_MAP.md` says the fork test's stack-too-deep error is fixed. It is not: `run.sh` still fails to compile at `CcipLive.t.sol:225` | `~/zkApi/ccipfork/results/fork.txt`, rerun 6 Nov | `run.sh` needs `via_ir = true`. Running with `forge test --via-ir` compiles. `foundry.toml` not changed |
| F-2 | With `--via-ir`, 5 of 8 pass and 3 fail: tests 4, 5 and 8. Test 4's "45 USDC received" was money already at the shared test address `vm.addr(0xA11CE)`: on a fresh address it receives 0 | Original run, then corrected copy | The original test can pass or fail for reasons unrelated to the bridge |
| F-3 | Test 8's first failure was a test bug: it quotes the fee with `gasLimit` 0, then sends with `gasLimit` 200000, and underpays (J4). With a correct quote the send succeeds, and it then fails like test 4 (F-7) | `CcipLive.t.sol:255`, corrected copy | **Rule for Part 5:** quote the exact message that will be sent |
| F-7 | **Forks cannot prove USDC arrives.** These lanes use Circle CCTP. Source: `depositForBurnWithHook` burns exactly the amount. Destination: the CCIP message executes (state 2) and the pool returns exactly the amount, but nothing is minted, because the simulator replaces verification with `CCIPLocalSimulatorV2NoOpVerifier`. Inference: the mint needs a CCTP attestation that a fork does not have | `-vvvv` trace of test 4. Nothing is queued: `getPendingV2MessageIds` is empty | **W0-04 cannot be settled by forks.** The real send (W0-07) decides it. Tests 4, 5, 8 can't pass on forks as written. The exact amounts are encouraging for 1:1, not proof |
| F-8 | A.3 and J2 describe delivery as "a plain token transfer", from a local router. On the live USDC lanes it is burn and mint, so the receiver gets minted USDC. Arrival time probably depends on CCTP as well as CCIP | F-7 trace | OQ-07: the time and detection method must come from a real send. Whether a mint reaches a 7702 receiver is still unproven |
| F-4 | The suite has 8 tests. `docs/spec/TEST_MAP.md` §6 lists 9. Test 9 (ETH Arbitrum → Base arrives as WETH) does not exist | `grep function test_` | Not tested. Docs need correcting |
| F-5 | Test 7, on the real router: paid 3× the quote and the router kept all of it. Tests 2, 3 and 6 confirm the lane table and that ETH can't leave Base | Run on 6 Nov | Confirms A.5 rule 6 and `ETH_NOT_BRIDGEABLE` on forks |
| F-6 | The test translator did not check that `base_units` agrees with `value`, that `decimals` fits the token, the bridge's `dest_token_address`, or `token_address` on ETH intents | `flex.handoff.test.ts` | Real translator checks all four |

## Log

### 2026-11-06

**Envelope changes and repo layout** (uncommitted when written)

- Schema: `k` takes `recipients[]`, `l` loses `recipient`, 16-step limit, canonical amounts, timestamp ceiling. `to-plan.ts`,
  `envelope.ts` and `bridge.v2.ts` updated. 26 new test cases. C-5 also fixes a bug: a far-future timestamp threw during mapping,
  which would have become a retried 5xx.
- Wrote `ARCHITECTURE_CHANGES.md`, `IMPLEMENTATION_PLAN.md`, `AGENT_HANDOFF.md`, `docs/README.md` and `wallet/README.md`. Added OQ-20 and
  OQ-21.
- Moved root documents into `docs/spec/` and `docs/agent/`; see `docs/README.md`. Agent `src/` and `test/` were not touched.

**Commits**

- `2987af8` on local branch `wallet` (made by the user, not pushed): Part 1 and the plan, based on `cae2664`. It also contains
  `docs/spec/AGENT_SPEC_v1.1.md`, `docs/spec/DECISIONS.md`, `docs/spec/TESTED.md` and `docs/spec/TEST_MAP.md`, which were meant to stay out. Raised with the user.
- Not yet committed: Prettier formatting of `wallet/`, and the docs updates recording F-7 and F-8 and this re-check.

**Agent re-check on `cae2664`**

- 60 newer agent commits apply the follow-up answers and run the live evaluation. The agent is still on envelope v1, with no
  v1.1 markers in `src/`. OQ-05 updated.

**Part 1**

- Created the `wallet/` package with pinned versions from the lab lockfile: viem 2.57.16, zod 4.6.7, ajv 8.20.0, ajv-formats
  3.0.1. Dev tools match the agent's versions.
- Copied `intent.v2.ts`, `bridge.v2.ts`, `redeem.v2.ts` and the §12.5 schema from the lab. Only import paths and formatting changed.
- Wrote `src/schemas/envelope.ts`, `src/mapping/to-plan.ts`, `src/mapping/check.ts`.
- Ported 43 intent, 5 plan, 13 P, 5 scenario and 29 hand-off cases. Added new cases for the fields in F-6, value-free
  rejection messages, ETH totals at 18 decimals, stable intent ids, and calldata decoding for `redeem.v2.ts`.
- Result: `npm test` in `wallet/` passes 111 of 111; typecheck clean. The scenario cases cover the verified plan only,
  because the lab's version of them used an older envelope shape. The full envelope path is covered by the 29 hand-off cases.

**Part 0**

- Recorded OQ-01 = Option A.
- Backed up `~/zkApi/ccipfork/results/` to the session scratchpad, then ran `run.sh`. Live lane checks passed. Forge did not compile
  (F-1). `results/live.txt` and `results/fork.txt` were overwritten with this run's output.
- Ran with `--via-ir`, with build output in the scratchpad: 5 of 8 pass (F-2 to F-5).
- Made a corrected copy of the test in the scratchpad: fresh address, correct fee quote, extra logging. `~/zkApi` was not
  edited. After two RPC timeouts it ran: still 5 of 8, with tests 4, 5 and 8 receiving 0.
- Tested the theory that messages were queued (`executePendingV2Message`): nothing was queued. A full trace of test 4 then
  gave F-7 and F-8.

**Plan**

- Wrote the plan documents in `docs/wallet/`.
