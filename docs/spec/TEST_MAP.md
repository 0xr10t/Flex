# Test map: what was tested, how, and what was real

Date: 6 November 2026. Companion to the Flex README v1.1. Every number below comes from a result file; if something wasn't
run, it says so.

**How to read the "Real?" column**

- **Live**: ran against a public testnet (Sepolia, Base Sepolia or Arbitrum Sepolia).
- **Real code, local chain**: the real contract or library code, deployed on a local chain (anvil 1.7.1, Prague, chain id
  11155111). Not a public network, but nothing about the code is faked.
- **Stand-in**: a simplified copy that behaves like the real thing for the part being tested. Each one is named.
- **Not tested**: designed and written down, never run.

---

## 1. One-page map

| Area | Real? | Stand-ins used | Result | Where |
| --- | --- | --- | --- | --- |
| `eth_simulateV1` on Alchemy | **Live** (Sepolia) | none | 8/8 functional cases; limits and speed measured | §3.1 |
| 7702 upgrade + MetaMask delegation, native ETH | **Live** (Sepolia) | none | works; delegation enforces recipients, amounts, maxRuns | §3.2 |
| CRE workflow (HTTP intake + cron) with your first executor | **Live** writes, workflow run by the CRE CLI simulator | the CRE simulator instead of a deployed workflow | 13/13 cases as expected | §3.3 |
| CCIP routes, pools and fees; MetaMask contracts on L2s | **Live**, read-only | none | all 6 lanes open; USDC on all 6; ETH (WETH) not out of Base | §3.4 |
| Payment schema `intent.v2.ts` | Real code, no chain | none | 43/43 | §4.1 |
| Plan schema `bridge.v2.ts` | Real code, no chain | none | 5/5 + 13/13 | §4.2 |
| Your 5 scenarios through both schema layers | Real code, no chain | none | 5/5 | §4.3 |
| Flex v1.1 hand-off envelope (§12.5) → tested schemas | Real Ajv + real zod schemas | the envelope→plan translator is test code (the real one isn't written yet) | 29/29 | §4.4 |
| Payments, delegations, executor V1/V2 | Real code, local chain | USDC token, CRE forwarder | 17/24 as required; the 7 others are bugs in the old code | §5.1 |
| End-to-end with the fixes (V2) | Real code, local chain | USDC token, CRE forwarder | 9/9 | §5.2 |
| `IntentExecutorV3` register / run / cancel | Real code, local chain | USDC token, CRE forwarder; test code plays the CRE cron | 16/16 | §5.3 |
| CCIP send rules | Real 7702 account, local chain | **CCIP router** (Chainlink Local), USDC token, fixed fee | 18/20 as required; the 2 others show what to avoid | §5.4 |
| CCIP on forks of the live chains | Real routers, pools and OffRamps on forks | Chainlink Local only to carry the message between forks | **not run yet**: first run failed to compile (fixed) | §6 |
| Agent layer (Flex S0–S12, LLM, DBs, API) | — | — | **not tested by us**; Flex lane status in §7 | §7 |
| ENSv2 resolution and group listing | — | — | **not tested** | §8 |
| Simulating a hand-off file before confirmation | — | — | **not built** | §8 |

---

## 2. Every component: real or stand-in

| Component | Status | Used in | Notes |
| --- | --- | --- | --- |
| Alchemy RPC + `eth_simulateV1` | Live | R1 | Sepolia only |
| MetaMask DelegationManager, EIP7702StatelessDeleGator, caveat enforcers (exactExecutionBatch, limitedCalls, timestamp) | **Live** on Sepolia (R1); **real code, local chain** in B, C, e2e, V, J | all onchain suites | deployed locally by `@metamask/smart-accounts-kit` 2.0.0 `deploySmartAccountsEnvironment`; same contracts confirmed deployed on all 3 testnets (L) |
| EIP-7702 upgrade of the user's EOA | Live (R1); real on local chain | all onchain suites | a real signed authorization, checked by reading the account's code |
| EIP-712 delegation signatures | Real | all onchain suites | signed by the kit's `signDelegation` |
| Encoding: executions → `encodeBatchExecution`, delegation → `abi.encode(Delegation[])`, `redeemDelegations` calldata, report `abi.encode(redeem)` | Real | B, C, e2e, V | decoded by the real MetaMask contracts and our executor |
| `IntentExecutor` (your original) | Live (R1); real on local chain (C1–C3) | R1, C | |
| `IntentExecutorV2`, `IntentExecutorV3` | Real code, local chain | C4–C8, e2e, V | **not deployed on any testnet** |
| Chainlink `ReceiverTemplate` (`onReport`, metadata decoding, workflow-id check) | Real code (copied from Chainlink) | C, e2e, V | |
| CRE KeystoneForwarder | **Stand-in** `MockForwarder` | C, e2e, V | calls `onReport(metadata, report)` with the same packed metadata layout (`workflowId, name, owner`); does **not** check DON signatures |
| CRE workflow (cron, `filterLogs`, simulate, `writeReport`) | CRE CLI simulator (R1, your first executor); **test code** plays the cron in C, e2e, V | R1, C, e2e, V | a deployed workflow was never run (no deploy access); reading `Registered` events with `filterLogs` inside CRE never run |
| USDC | **Stand-in** `MockUSDC` code placed at the Circle Sepolia address | B, e2e, V, J | standard ERC-20 transfer/approve; none of Circle's extras (blacklist, pause, permit) |
| Native ETH | Real | B, R1 | |
| CCIP router (send side) | **Stand-in** Chainlink Local `CCIPLocalRouter` (0.3.1) | J | follows OnRamp/OffRamp 2.0 send rules; fee fixed by the test at 0.0011 ETH; no real token pools, no second chain |
| CCIP `Router.sol` overpay behaviour | Real source code read | J3 | it keeps the whole `msg.value` |
| CCIP routers, OnRamps, token pools, fees | **Live**, read-only | L | `isChainSupported`, `getOnRamp`, `getPoolBySourceToken`, `getFee` on all 6 lanes |
| Ajv (Flex's validator) and zod schemas | Real | schema, plan, scenarios, Flex hand-off | |
| Envelope → verified plan translator | **Test code** following the README mapping table | Flex hand-off | the execution layer's real translator doesn't exist yet |
| Local LLM (Ollama, qwen2.5) | **Not run** | — | the model isn't pulled; Flex tests mock the LLM |
| ENSv2 Universal Resolver, ENS indexer | **Not run** | — | |

---

## 3. Live tests

### 3.1 `eth_simulateV1` on Alchemy (R1, run by Mihir, `RESULTS.md`)

| Case | Result |
| --- | --- |
| ETH transfer with enough balance | ✅ status 0x1, 21 000 gas |
| ETH transfer above balance | ✅ JSON-RPC error `-38014` (not a call status) |
| ETH sent to a contract that rejects ETH | ✅ status 0x0 |
| LINK transfer with no balance / balance faked with `stateDiff` | ✅ 0x0 / ✅ 0x1 with Transfer event |
| Alice and Bob in one simulated block | ✅ both 0x1 (explicit nonces needed) |
| `blockOverrides.time` = now + 1 day | ✅ accepted |
| `validation: true` | ✅ only with `maxFeePerGas` (else `-38012`) |
| Size and speed | ✅ 32 blocks and 100 calls per block; p50 221 ms, p95 726 ms, ~104 req/s, no 429 |

### 3.2 7702 + MetaMask delegation (R1)

✅ owner upgraded on Sepolia (tx `0xbd04…b73c`) · ✅ one batch delegation enforces recipients, amounts and maxRuns · ✅ swapped
recipient, changed amount, forged signature, wrong redeemer: all blocked · ✅ batch design: 158 k gas per later run.

### 3.3 CRE with your first executor (R1; workflow in the CRE CLI simulator, writes on Sepolia)

✅ one-time intent executed · ✅ recurring runs 1 (HTTP), 2 and 3 (cron) executed · ✅ cron inside the interval: nothing due ·
✅ after maxRuns: nothing due, 3/3 · ✅ malformed intent, 21 KB payload, intent changed after signing, forged signature,
`immediate` intent: all rejected · ✅ 4th run forced: `Exhausted` · ✅ `onReport` not from the forwarder: `InvalidSender`.
First run 7.25 M gas (stores the whole delegation). This tested the HTTP intake, which v1.1 replaces with `register()`.

### 3.4 Live testnets, read-only (L, run by Mihir, `ccipfork/results/live.txt`)

| Check | Sepolia | Base Sepolia | Arbitrum Sepolia |
| --- | --- | --- | --- |
| RPC chain id | 11155111 ✅ | 84532 ✅ | 421614 ✅ |
| CCIP router deployed | ✅ | ✅ | ✅ |
| MetaMask DeleGator `0x63c0…E32B` | ✅ | ✅ | ✅ |
| MetaMask DelegationManager `0xdb9B…7dB3` | ✅ | ✅ | ✅ |

| Lane | Open | USDC pool | WETH (= ETH) pool | Fee for USDC (ETH) |
| --- | --- | --- | --- | --- |
| Sepolia → Base | ✅ | ✅ | ✅ | 0.000227 |
| Sepolia → Arbitrum | ✅ | ✅ | ✅ | 0.000249 |
| Base → Sepolia | ✅ | ✅ | ❌ | 0.000824 |
| Base → Arbitrum | ✅ | ✅ | ❌ | 0.000138 |
| Arbitrum → Sepolia | ✅ | ✅ | ✅ | 0.000823 |
| Arbitrum → Base | ✅ | ✅ | ✅ | 0.000116 |

All OnRamps report `OnRamp 2.0.0`. Where a pool is missing, `getFee` also reverts.

---

## 4. Schema tests (real validators, no chain)

### 4.1 Payment schema `intent.v2.ts`: 43/43

Your 20 original cases all still behave as you expected. 23 new cases came from the onchain failures; your `intent.ts` gets 20
of them wrong, `intent.v2.ts` gets all 23 right:

| New case | Expected |
| --- | --- |
| Base Sepolia / Arbitrum Sepolia USDC payment | accepted (old schema rejected both) |
| Zero-address recipient (B9) | rejected |
| Address with a wrong EIP-55 checksum | rejected |
| ERC-20 that is not the registered USDC; USDC with 18 decimals; recipient = token contract (B1) | rejected |
| Automated with `startAt: null`; `startAt` in the past (B7a, C1) | rejected |
| One-time automated payment tomorrow (B7b) | accepted |
| Recurring with `endAt` but no `maxRuns`; without `lateWindow`; `lateWindow` > interval; `endAt` cuts off runs (C2, C6) | rejected |
| Longer than 52 weeks | rejected |
| Automated without a fee; immediate with a fee; caps that don't cover the fee (B8) | rejected |
| One-time group of 100 / 101 (B12) | accepted / rejected |
| Autopay to 50 / 51 recipients (CRE 50 KB report) | accepted / rejected |

### 4.2 Plan schema `bridge.v2.ts`: 5/5 + 13/13

✅ `[j, i, i]` worked example · ✅ `[j, k]` prefund + weekly autopay · ✅ `[l]` · ✅ bad delegation hash rejected · ✅ bridge after a
cancel rejected. Plus 13 plan cases (P): receiver ≠ self, same chain, wrong token, ETH bridge, fee cap > 0.01, bridge after its
payment, wrong landing chain, payment not waiting, ETH payment after a bridge, two accounts, 4 bridges: all rejected; README
example and bridge + autopay prefund: accepted.

### 4.3 Your scenarios through both layers: 5/5

| Scenario | Agent envelope | Verified plan |
| --- | --- | --- |
| 0.01 ETH from Base to Arbitrum | rejected | rejected |
| 10 USDC from Base to Arbitrum, pay there | accepted | accepted |
| Unified USDC: Base 6 + Arbitrum 4 → 10 USDC on Sepolia | accepted | accepted |
| Unified ETH: Base + Arbitrum → Sepolia | rejected | rejected |
| Bridge lands on Arbitrum, payment on Sepolia | **accepted** | rejected |

### 4.4 Flex v1.1 hand-off envelope: 29/29 (`flex.handoff.test.ts`)

The §12.5 JSON Schema, taken straight from the README, compiled with Ajv strict (as Flex does). Accepted envelopes were then
translated with the README's mapping table and checked with the tested `PlanSchema`.

| Group | Cases | Result |
| --- | --- | --- |
| Accepted by the envelope **and** the tested schemas | E3 `[j 10, i 40, i 20]`; E4 group as one `i`; E6 weekly autopay with fee; E7 cancel with `plan_id`; A-64 two legs MON/THU; one-time ETH payment | 6/6 |
| Rejected by the envelope | ETH bridge; old `k` with prefund + `cre_job`; `k` without fee; old `l` with `delegate_address`; `l` without `plan_id`; old one-recipient `i` shape; 101 recipients; `j` without fee cap; interval < 60 s; a name field; version 1 | 11/11 |
| Envelope-valid, rejected by the tested schemas | `end_at` cuts off runs; late window > interval; start in the past; `max_total` too low; fee collector = payee; zero address; duplicate group member; bridge to the wrong chain; fee cap > 0.01 ETH; wrong USDC address | 10/10 |
| README's own numbers | E6 start/end timestamps; E6 `max_total` 80.4 and A-10 need 1,567.8 | 2/2 |

---

## 5. Onchain tests on a local chain (real MetaMask contracts; stand-in USDC and forwarder)

### 5.1 Payments, delegations, executors (B, C): 17 as required, 7 show bugs in the old code

| # | Case | Result |
| --- | --- | --- |
| B1 | ERC-20 intent through your `redeem.ts` | ❌ bug: Alice gets 0 USDC and 10.5 M wei of ETH |
| B2 | ERC-20 as `transfer` calldata | ✅ 213 k gas |
| B3 | One tx from the 7702 account, ETH + USDC | ✅ 122 k gas |
| B4 | Second recipient rejects ETH | ✅ whole batch reverts |
| B5 | `disableDelegation`, then redeem | ✅ `CannotUseADisabledDelegation` |
| B6 | After `endAt` | ✅ `expired-delegation` |
| B7a | `startAt` tomorrow, compiled like your `envelope.ts` | ❌ bug: paid a day early |
| B7b | `startAt` as a `timestamp` caveat | ✅ blocked before, paid after |
| B8 | Executor tries to redirect the fee | ✅ blocked |
| B9 | Zero-address recipient | ❌ bug in the old schema: 0.3 ETH burned |
| B10 | One recipient through the kit encoder + batch delegation | ❌ reverts (kit uses single mode) |
| B10b | One recipient through your `redeem.ts` | ✅ |
| B11 | One recipient, `exactExecution` + single mode | ✅ |
| B12 | 20 / 50 / 100 USDC recipients in one batch | ✅ 0.89 M / 2.02 M / 3.91 M gas |
| C1 | Your executor, `startAt` tomorrow | ❌ bug: paid on registration, 1.64 M gas |
| C2 | Your executor, same delegation under a new id 60 s later | ❌ bug: paid again |
| C3 | Your executor, report from another workflow | ❌ bug: accepted |
| C4 | V2, same delegation again | ✅ `SlotAlreadyPaid` |
| C5 | V2, before start | ✅ `NotStarted` |
| C6 | V2, cron 3 h late with a 1 h window | ✅ slot skipped, next on time |
| C7 | V2, after the last slot | ✅ `Exhausted` |
| C8 | V2 with `setExpectedWorkflowId` | ✅ other workflow `InvalidWorkflowId`, ours paid |

### 5.2 End-to-end with the fixes (V2): 9/9

USDC, Alice 10 + Bob 5 + fee 0.05, daily × 3, 1 h late window: ✅ blocked before start · ✅ slot 0 paid (392 k gas) · ✅
balances right · ✅ retry blocked · ✅ slot 1 with cron 2 h late: skipped · ✅ slot 2 paid on time (251 k) · ✅ after last slot
blocked · ✅ totals Alice 20, fee 0.10 · ✅ immediate path one tx, 52 k gas.

### 5.3 `IntentExecutorV3` (V): 16/16

✅ someone else registers the user's delegation: `NotYourDelegation` · ✅ delegation naming another contract: `WrongDelegate` · ✅
report for an unregistered plan: nothing paid · ✅ user registers: 154 k gas · ✅ duplicate: `AlreadyRegistered` · ✅ `Registered`
event carries delegator, schedule and the full 3.2 KB signed calldata · ✅ before start: not paid · ✅ slot 0 paid (318 k), Alice
10, Bob 5, fee 0.05 · ✅ same slot again: not paid · ✅ slot 1 paid (271 k) · ✅ someone else cancels: `NotYourDelegation` · ✅
user cancels in one batch: `Cancelled` + `DisabledDelegation` (110 k) · ✅ slot 2 after cancel: not paid · ✅ Alice total 20 · ✅
executor redeeming the disabled delegation directly: `CannotUseADisabledDelegation` · ✅ report size 3.3 KB.

### 5.4 CCIP send rules (J, stand-in router): 18/20 as required

| # | Case | Result |
| --- | --- | --- |
| J1 | One 7702 batch `[approve(exact), ccipSend{value: quote}]` | ✅ 90 k gas, allowance back to 0, fee = quote |
| J2 | Receiver is the user's 7702 address | ✅ plain token transfer |
| J3 | Fee overpaid 3× | ⚠️ router keeps it all; also true in Chainlink's real `Router.sol` source |
| J4 | Fee underpaid | ✅ reverts |
| J5 | Receiver = attacker | ⚠️ the chain would send it; only the schema stops it |
| J6 | Two tokens in one message | ✅ reverts |
| J7 | Separate unlimited approve, bridge fails | ⚠️ unlimited allowance left behind |
| P ×13 | plan cases | ✅ (counted in §4.2) |

---

## 6. CCIP on forks of the live chains: not run yet

`ccipfork/test/CcipLive.t.sol`, 9 tests. Real routers, OnRamps, token pools and OffRamps on forks of all three live chains.
Chainlink Local's `CCIPLocalSimulatorFork` only carries the message from the source fork to the destination fork. The sender is
a real 7702-delegated account.

| Test | Checks |
| --- | --- |
| 1 | chain ids of the forks |
| 2 | lane matrix with the pool check |
| 3 | ETH Base → Arbitrum: must revert (no WETH pool) |
| 4 | USDC Base → Arbitrum: exact debit, allowance 0, ETH spent = fee, arrives 1:1 |
| 5 | Unified USDC: Base + Arbitrum → Sepolia, then one payment of the total |
| 6 | Unified ETH: reports which legs can't move |
| 7 | Overpaid fee on the live router |
| 8 | Receiver is a 7702 account with a 200 000 gas limit |
| 9 | ETH Arbitrum → Base: arrives as Base's WETH? |

Status: the first run stopped at a compile error ("stack too deep" in test 5). The fix compiles with the same compiler, and the old
file reproduces the error. Run `cd ~/zkApi/ccipfork && bash run.sh`. Test 4 decides whether `bridge_buffer_pct` stays 0.

---

## 7. Agent layer (Flex): not tested by us

Lane results as `Flex/STATUS.md` reports them (unreviewed, not rerun by us):

| Lane | What exists | Tests |
| --- | --- | --- |
| A Platform | config, SQLCipher, DB1–DB8 repos, logger, API routes | no lane tests yet |
| B Understanding | amount parser, secret detectors, fetch, lexical, prompts, S0–S2 | no lane tests yet; S3–S5 not written |
| C Recipients | names, addresses, ENS client, groups, S6, S7 | 53 pass, partly written |
| D Planning & output | WIP S8 tests only | doesn't typecheck; S8–S12 not written |

The local model has never been run (Ollama model not pulled); all Flex tests mock the LLM. The v1.1 README changes land in
lane D (not written yet) plus `types.ts`, `schema.sql`, the two schema JSON files and `config.example.json`.

---

## 8. Not tested yet

| What | Why | How |
| --- | --- | --- |
| USDC arrives 1:1 over live lanes; overpay and 7702 receiver on the live router | fork run pending | `ccipfork/run.sh` |
| A real (non-fork) CCIP transfer and its arrival time | needs a funded testnet wallet | one Sepolia → Base Sepolia USDC send |
| Deployed CRE workflow: real KeystoneForwarder with DON signatures, cron reading `Registered` via `filterLogs` | no CRE deploy access | `cre account access` |
| `IntentExecutorV3` on a testnet with real USDC | not deployed | deploy on Sepolia, rerun §5.3 against it |
| Simulating a hand-off file (`eth_simulateV1` per step, with state overrides for 7702 code and bridged balances) before the summary | not built; not in Flex scope | add a `/v1/simulate` step |
| ENSv2: Universal Resolver lookups, subname listing from the indexer (the §9.6 query uses the classic subgraph shape) | not started | Sepolia ENSv2 deployment + the indexer the team picks |
| The envelope → verified plan translator in the execution layer | not written | port the mapping from `flex.handoff.test.ts` |
| Agent layer end to end, with the real model | lanes unfinished | Flex Phase 2–3 |

---

## 9. Rerun

```bash
# local suites (lab.zip)
cd lab && npm i && (cd contracts && npm i) && node compile.mjs
node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil --hardfork prague --chain-id 11155111 &
for t in schema onchain e2e.v2 register.v3 ccip plan scenarios flex.handoff; do npx bun src/$t.test.ts; done

# live read + forks (needs internet and Foundry)
cd ccipfork && bash run.sh
```
