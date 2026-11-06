# Wallet implementation tracker

The running record of wallet work. Newest entries first in the log. The plan is in [README.md](README.md).

## Status

| Part | State | Notes |
| --- | --- | --- |
| 0 Prerequisites | In progress | See "Part 0 tasks" below |
| 1 Schemas and mapping | Done | Changed by C-1 to C-5 |
| 2 Service and runner | Done on a local chain | Uses provisional OQ-04, 08, 14, 15. Report retry policy is provisional |
| 3 Account and signing | Partly done | Works with a test key on a local chain. The direction is now MetaMask popups; see Decisions. Not built or tested yet |
| 4 Payments `i` | Done on a local chain | Mock USDC. Testnet runs with real USDC are Part 11 |
| 5 Bridges `j` | Done on a local chain, with a stand-in router | Real delivery is unproven (F-7). Needs a funded wallet and one real send (W0-06, W0-07), then OQ-07 |
| 6 Executor contract | Tested locally, including the lab's gaps | No deploy script yet. Live deploy needs OQ-17 |
| 7 Autopay `k` | Done on a local chain | Uses provisional OQ-09, OQ-11. OQ-10 settled |
| 8 Cancel `l` | Done on a local chain | Reads the delegation from the chain, as the spec says |
| 9 CRE workflow | Built, and run in the CRE simulator as a dry run against a local chain | No real write. Deploy needs access (W0-05) and OQ-18 |
| 10 Run reporting | Done on a local chain | Uses provisional OQ-14. The agent's report route still needs moving to the v2 shape |
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
| OQ-01, OQ-02 | **Direction changed.** The product is CLI based, and MetaMask holds the key. At the right point in a transaction the CLI asks MetaMask, and its popup asks the user. This replaces key setup. Not built: a test is needed first for batches, delegations and large lists. Saving the signed transaction before sending has to change, since MetaMask signs and sends together | User | 2026-11-06 |
| Check before signing | **Required.** A decoder and `eth_simulateV1` run together on every transaction before it's signed. The intent, the decoded bytes and the simulated result must all match. If simulation isn't available, the step stops: no fallback | User | 2026-11-06 |
| ENS organisation payments | ETH to the members of an organisation under an ENS name. **Members need not get the same amount** | User | 2026-11-06 |
| OQ-10 | The caveat uses `start_at - 1` and `end_at + 1`. Tested: the enforcer's bounds are exclusive, so the spec's literal values refuse a run at exactly the first or last second, both of which the executor allows | Test on real contracts | 2026-11-06 |

## Provisional choices

Made so that work can continue. Each one is easy to change and has not been approved.

| Id | Choice | Why |
| --- | --- | --- |
| OQ-03 | Code lives in `wallet/`, a separate package with its own lockfile, on Node 22 and TypeScript. Library versions match the lab lockfile | The plan's recommendation. Keeps the agent's dependencies untouched |
| OQ-09 | `intentId` is derived from `request_id` + `step` (`intentIdFor`), instead of random | A random id could allow a second live plan after a crash |
| OQ-12 | Plan limit raised to 16 steps, in the JSON schema and `PlanSchema` | C-3 in `ARCHITECTURE_CHANGES.md`. 8 refused valid requests |
| C-1 to C-5, R-1, R-2 | The changes in `ARCHITECTURE_CHANGES.md` | Requested by the user on 6 Nov. The exact changes still need the user's and the agent owner's confirmation |
| OQ-13 | `IntentSchema` keeps its 52-week cap, unchanged | It is the tested schema |
| OQ-04 | Encrypted SQLite, opened with the same settings as the agent's. Logs hold codes and ids only, from a closed field list | The plan's recommendation |
| OQ-08 | Independent steps still run. A step whose dependency failed is reported as `failed` without running | The plan's recommendation |
| OQ-14 | Reports wait in the store. Retried with a delay doubling up to 5 minutes, with no limit on tries. A 400 or 404 is logged and dropped | Part 2's rule, plus a retry policy so a report can't be lost while the agent is down |
| OQ-15 | The wallet has its own config file holding paths and URLs, never keys or tokens | Keeps secrets out of files |
| OQ-19 | The 7702 upgrade happens on first use on each chain, after approval. An account pointing at other code is refused | The plan's recommendation |
| OQ-02 | Approval is an interface. The default rejects everything; `auto_approve_testnets` must be chosen in config | A real screen is undecided, and nothing should sign without asking by default |
| — | The DB key and signing key are read from the OS keychain. The DB key is created on first start. A missing signing key stops the start | OQ-01 says the key is on the device; how it gets there isn't decided |
| — | Requests run one at a time across all chains | Keeps one transaction in flight per account. Its cost: waiting for a bridge or an approval holds up every other request. Needs revisiting before real use |
| — | `k` and `l` are refused at intake on a chain with no executor configured | A plan can't pay part of the way and stop at a step the wallet can't do |
| OQ-07 | Arrival = a USDC Transfer to the wallet on the destination, for the exact amount, after the send. Timeout 30 minutes, then the step reports `failed`, though the money may still arrive | Logs, so the wallet's other spending can't hide an arrival. Both values are guesses until a real send (W0-07) |
| OQ-09 | The signed delegation is saved before `register` is sent, and reused after a crash. A plan already on chain is reported, not sent again | The plan's recommendation; tested on a local chain |
| OQ-11 | If `start_at` has passed before registering, the step fails. The check runs before signing, and again before sending | The plan's recommendation. Still open: a register mined just after `start_at` loses that first run |
| OQ-14 | A watcher scans `Executed` for this wallet's plans from a saved block position. Each run has one report key. `ended` is sent once `end_at` has passed and the scan has caught up. Skipped runs aren't reported | §14.3 has no kind for a skipped run |
| OQ-18 | The workflow simulates up to 14 runs per execution, soonest-closing first; the rest wait for the next cron. It reads plans with one log query per chain, and no read per plan | A.5 rule 10. Log-read quotas and large block ranges are unmeasured |
| — | A signed step is never reported as failed because a chain can't be reached, only when its outcome is known | It may still be mined. Reporting it as failed could mislead the agent's limits |
| — | ETH effect check relies on the receipt, plus the account's code being confirmed before signing | Part 4 says the sources don't define an exact check. ETH transfers emit no log, and a balance read can be skewed by other funds |
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
| F-9 | **50 recipients fits** (C-1). On real MetaMask contracts with a mock USDC: `register` 513 k gas, first run 2.15 M, later runs 1.29 M, report 27.9 KB. CRE limits are 10 M and 50 KB | `test/chain/executor.test.ts` | Recurring payroll stands. Real USDC's gas will differ |
| F-10 | **The forwarder in the old staging config is the mock.** From `cre workflow supported-chains`: real forwarder on Sepolia and Base Sepolia `0xF8344CFd5c43616a4366C34E3EEE75af79a74482`, on Arbitrum Sepolia `0x76c9cf548b4179F8901cda1f8623568b58215E62`. `0x15fC…9F88` is Sepolia's mock | CLI output, 6 Nov | OQ-16: all three chains are supported, and these go in the workflow config. Deploying the executor with the mock would make it refuse real reports |
| F-11 | `filterLogs` works in the compiled workflow, in the CRE simulator against a local chain. It skipped a run when the simulation failed. A run was skipped when the chain's latest block was older than the plan's start, so a run at the very start of its window can wait for the next cron | Simulator run, 6 Nov | Part 9. This was a dry run: nothing was written |
| F-12 | The 7702 upgrade used to happen before a step's own checks, so a refused bridge still signed an upgrade. Fixed: read-only account check, then the step's checks, then the upgrade | `test/chain/bridge.test.ts` found it | Part 3 |
| F-13 | **`eth_simulateV1` works on all three testnets**, through public RPCs: a simulated 7702 account, moving the clock forward, and traced ETH moves. Traced ETH logs come from different addresses: `0xfff…fffe` on Sepolia's node, `0xeee…eeee` on the others | Live read-only probe, 6 Nov | The decoder accepts both. Only these RPCs were tried; a provider without the method now stops payments |
| F-14 | **ENSv2 resolution works live on Sepolia.** The Universal Resolver at `0xeEeE…EeEe` resolves names, including per-chain coin types for Base and Arbitrum Sepolia | Live read-only probe, 6 Nov | `config.example.json` updated |
| F-15 | **The ENS indexer is blocked.** ENSNode's Omnigraph is the indexer for ENSv2. Its hosted hosts, including `api.v2-sepolia.ensnode.io`, serve a TLS certificate for `*.up.railway.app`, which doesn't match. TLS checks stay on, because this list decides who gets paid. The adapter's query passes validation against ENSNode's published schema, and its tests use a faked transport | Live probe, 6 Nov | Listing an organisation is unproven live. Retry the host, ask ENSNode, or self-host |
| F-16 | **The `iitr.eth` subnames have no address records.** `iitr.eth` resolves on Sepolia, but all 5 subnames return empty on all 3 chains, the same as a made-up name. Their owner isn't their address. Everything after ENS passes on all 3 chains using owners as stand-ins, including `eth_simulateV1` | `npm run ens:check`, 6 Nov | Set an address record on each subname, then rerun. Real subname resolution is unproven until then |
| F-6 | The test translator did not check that `base_units` agrees with `value`, that `decimals` fits the token, the bridge's `dest_token_address`, or `token_address` on ETH intents | `flex.handoff.test.ts` | Real translator checks all four |

## Log

### 2026-11-06

**Decoder, simulation and ENS** (uncommitted when written)

- Merged 67 commits from `origin/agentic_layer`. None of them moved ENS forward: the agent is still on envelope v1, with placeholder ENS settings, tested only against fakes.
- Added `src/guard/`: the decoder and the check. It runs before approval on `i`, `j`, `k` and `l`. Autopay checks twice: before the permission is signed, and after, simulating `register` and then the first run at its start time. Cancel simulates a later run too.
- The token that claims success and moves nothing is now caught before signing, not after.
- Added `ensnode-omnigraph` as an indexer kind in the agent (`src/recipients/subnames.ts`). This is the first change to agent code from this branch.
- Added a test of ETH to several people with different amounts. The agent can't produce this yet; see R-2.
- After the merge, 4 agent tests fail (A-05, A-43, R1-F2, C-039). The same 4 fail on a clean checkout of `origin/agentic_layer`, so they came with upstream; one failure message points at the new `conversation` LLM call. Left for the agent team.
- Deliberate breaks of the check: 7 of 8 caught. The miss was the bridge's receiver rule, because the builder never makes a bad one. So the decoder's rules are now also tested with tampered bytes.

**Parts 5 to 10 on a local chain**

- Added the executor contract and test helpers in `wallet/contracts/`, unchanged from the lab, built with Foundry and the lab's settings.
- Moved each intent's rules into its own handler behind one runner lifecycle: `src/autopay/`, `src/bridge/`, `src/payments/`.
- Added `RunWatcher` for `autopay_payment` and `autopay_status`.
- Added the CRE workflow in `wallet/cre/`, with its decisions in plain code that is tested against the real contract.
- `npm run test:chain` covers registration, runs, cancel, crash recovery, runs while the wallet is off, 50-person lists and bridges.
- 14 deliberate breaks of the new safety code: 10 caught at once. The other 4 were held by a second layer of protection, so no money was at risk, and tests were added for each.
- **Not done:** a deploy script, any testnet run, a real CCIP send, a real report write through CRE. The MetaMask path isn't built.

**Parts 2, 3 and 4 on a local chain**

- Built the service, encrypted store, step runner, report sender, 7702 upgrade, signer path and `i` payments in `wallet/src/`.
- A signed transaction is saved before it is sent. After a crash the wallet looks that exact transaction up and repeats it.
- `npm test` passes 218. `npm run test:chain` passes 16, on local anvil chains with MetaMask's real contracts placed at their real
  addresses and a mock USDC at the registered address.
- Covered: examples 1, 2 and 3, 100 people with different amounts, ETH, two chains in one request, an account delegated
  elsewhere, not enough funds, a token that moves nothing, and SIGKILL of the real process with a payment in flight (mined later,
  dropped by the network, and retried by the agent).
- The agent's real `execution-client.ts` and report check were run against the wallet. The agent still sends v1, which is refused.
- Five deliberate breaks of the safety code were each caught by the tests.
- **Not done:** nothing has run on a real testnet or with real USDC. No key creation or approval screen. The agent can't drive this
  yet. The crash tests cover a process kill, not power loss.

**Envelope changes and repo layout**

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
