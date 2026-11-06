# What has been tested

Date: 6 November 2026. This file lists every test behind the README, where it ran, and what came out. Nothing here is a
plan: if a test was not run, it is under "Not tested yet" at the end.

## Where the tests ran

| Tag | Where | What is real | What is not |
| --- | --- | --- | --- |
| **R1** | Live Ethereum Sepolia, run by Mihir (`RESULTS.md`, 5 Nov) | Alchemy RPC, MetaMask contracts, 7702 upgrade, CRE simulation writing real Sepolia txs | CRE was not deployed (no deploy access) |
| **B, C, V, e2e** | Local Prague chain (anvil 1.7.1, chain id 11155111), rerun on a fresh chain on 6 Nov | MetaMask Delegation Framework deployed by `@metamask/smart-accounts-kit` 2.0.0, owner EOA upgraded with a real 7702 authorization, real EIP-712 signatures | USDC is a mock token placed at the Circle Sepolia address; the CRE forwarder is a mock that calls `onReport` the way the KeystoneForwarder does |
| **Schema, P, scenarios** | Node/bun, no chain | the real `intent.v2.ts` and `bridge.v2.ts` validators | — |
| **J** | Local chain with Chainlink Local's `CCIPLocalRouter` (0.3.1) | sender is the real 7702 account; router mirrors OnRamp/OffRamp 2.0 send rules | not the live router |
| **L** | Live Sepolia, Base Sepolia, Arbitrum Sepolia, read-only, run by Mihir on 6 Nov (`ccipfork/results/live.txt`) | live routers, OnRamps, token pools, fees, MetaMask contracts | no transactions sent |

Rerun commands are at the end.

---

## 1. Simulation with Alchemy `eth_simulateV1` (R1, live Sepolia)

| Case | Result |
| --- | --- |
| ETH transfer with enough balance | ✅ status 0x1, 21 000 gas |
| ETH transfer above balance | ✅ JSON-RPC error `-38014` (not a call status) |
| ETH sent to a contract that rejects ETH | ✅ status 0x0, reverted |
| LINK transfer with no balance / with balance faked by `stateDiff` | ✅ 0x0 / ✅ 0x1, Transfer event |
| Alice and Bob in one simulated block | ✅ both 0x1 (needs explicit nonces) |
| `blockOverrides.time` = now + 1 day | ✅ accepted |
| `validation: true` | ✅ works only with `maxFeePerGas` set (else `-38012`) |
| Size | ✅ 32 blocks per request and 100 calls per block both work |
| Speed | ✅ p50 221 ms, p95 726 ms, ~104 requests/s without a 429 |

## 2. Intent schema (`intent.v2.ts`) — 43/43

Your 20 original cases (all still behave as you expected):
user example accepted · recurring automated accepted · JSON with `//` comments rejected · sum > maxPerRun rejected ·
19 decimals on an 18-decimal asset rejected · duplicate recipient rejected · native with a token rejected · erc20 without a
token rejected · recurring without interval rejected · recurring without maxRuns/endAt rejected · recurring with null maxTotal
rejected · maxTotal < sum × maxRuns rejected · immediate + recurring rejected · automated without executor rejected · once
with interval rejected · non-atomic multi-recipient rejected · unknown field (`memo`) rejected · amount as a number rejected ·
bad address rejected · mainnet chain id rejected.

23 new cases (from the onchain failures). Your `intent.ts` gets 20 of them wrong; `intent.v2.ts` gets all 23 right:

| Case | Expected | Why it matters |
| --- | --- | --- |
| Base Sepolia USDC payment | accepted | your schema rejected Base |
| Arbitrum Sepolia USDC payment | accepted | your schema rejected Arbitrum |
| Zero-address recipient | rejected | B9: an expired ENS name resolves to it; the chain burns the money |
| Address with a wrong EIP-55 checksum | rejected | typo protection |
| ERC-20 that is not the registered USDC | rejected | B1 |
| USDC declared with 18 decimals | rejected | 10¹² × overpayment |
| Recipient is the token contract | rejected | tokens lost |
| Automated with `startAt: null` | rejected | B7a / C1: paid at once |
| `startAt` in the past | rejected | |
| One-time automated payment tomorrow | accepted | |
| Recurring with `endAt` but no `maxRuns` | rejected | slots are counted (C6) |
| Recurring without `lateWindow` | rejected | C6 |
| `lateWindow` longer than the interval | rejected | two slots could overlap |
| `endAt` cuts off slots `maxRuns` promises | rejected | |
| Longer than 52 weeks | rejected | README limit |
| Automated without a fee | rejected | B8, your "charge per run" decision |
| Immediate with a fee | rejected | |
| `maxPerRun` covers recipients but not the fee | rejected | run would fail |
| `maxTotal` covers payments but not fees | rejected | later runs would fail |
| One-time group of 100 / 101 | accepted / rejected | B12 gas |
| Autopay to 50 / 51 recipients | accepted / rejected | CRE 50 KB report limit |

## 3. Onchain: payments, delegations, executor (B, C) — 17 behave as required, 7 show bugs in the old code

| # | Case | Result |
| --- | --- | --- |
| B1 | ERC-20 intent through your `redeem.ts` | ❌ **bug**: tx succeeds, Alice gets 0 USDC and 10.5 M wei of ETH |
| B2 | ERC-20 with `transfer` calldata (`redeem.v2.ts`) | ✅ 10.5 + 4.5 USDC, 213 k gas |
| B3 | Immediate path: one tx from the 7702 account, ETH + USDC | ✅ 122 k gas |
| B4 | Second recipient rejects ETH | ✅ whole batch reverts |
| B5 | `disableDelegation`, then redeem | ✅ `CannotUseADisabledDelegation` |
| B6 | After `endAt` | ✅ `expired-delegation` |
| B7a | `startAt` tomorrow, compiled like your `envelope.ts` | ❌ **bug**: paid immediately, a day early |
| B7b | `startAt` mapped to `TimestampEnforcer.afterThreshold` | ✅ blocked before, paid after |
| B8 | Fee inside the signed batch; executor tries to redirect it | ✅ blocked |
| B9 | Zero-address recipient | ❌ **bug** in the old schema: accepted, 0.3 ETH burned |
| B10 | One recipient through MetaMask's kit encoder + batch delegation | ❌ reverts (kit uses single mode for one call) |
| B10b | One recipient through your `redeem.ts` | ✅ (but `envelope.ts`'s kit-vs-viem check throws) |
| B11 | One recipient, `exactExecution` + single mode | ✅ |
| B12 | 20 / 50 / 100 USDC recipients in one batch | ✅ 0.89 M / 2.02 M / 3.91 M gas |
| C1 | Your executor, `startAt` tomorrow | ❌ **bug**: paid on registration, 1.64 M gas |
| C2 | Your executor, same delegation under a new `intentId` 60 s later | ❌ **bug**: paid again |
| C3 | Your executor, report from another CRE workflow | ❌ **bug**: accepted |
| C4 | V2, same delegation sent again | ✅ `SlotAlreadyPaid` |
| C5 | V2, before `startAt` | ✅ `NotStarted` |
| C6 | V2, cron 3 h late with a 1 h window | ✅ slot skipped, next slot on time |
| C7 | V2, after the last slot | ✅ `Exhausted` |
| C8 | V2 with `setExpectedWorkflowId` | ✅ other workflow `InvalidWorkflowId`, ours paid |

Your `RESULTS.md` measured 7.25 M gas for the first run on Sepolia; the local copy of the same executor measured 1.64 M.
Both store the whole delegation. V2 and V3 store only its hash.

## 4. End-to-end with the fixes (e2e) — 9/9

`intent.v2` → delegation with startAt/endAt/maxRuns/fee as caveats → `redeem.v2` → `IntentExecutorV2` through the forwarder.
USDC, Alice 10 + Bob 5 + fee 0.05, daily × 3, starts in 1 h, 1 h late window.

✅ blocked before start · ✅ slot 0 paid (392 k gas) · ✅ balances Alice 10, Bob 5, fee 0.05 · ✅ retry 10 min later blocked ·
✅ slot 1 with cron 2 h late: skipped, not paid late · ✅ slot 2 paid on time (251 k gas) · ✅ after the last slot blocked ·
✅ totals Alice 20, fee 0.10 · ✅ immediate path: one tx, Alice +10 USDC, 52 k gas.

## 5. Onchain registration and cancel (`IntentExecutorV3`, V) — 16/16

Same autopay as section 4. Here the user registers it with their own transaction and CRE only runs it.

| Case | Result |
| --- | --- |
| Someone else registers the user's signed delegation | ✅ rejected `NotYourDelegation` |
| Delegation that names a different contract | ✅ rejected `WrongDelegate` |
| CRE report for a plan nobody registered | ✅ nothing paid (CRE cannot create plans) |
| User registers from the wallet | ✅ 154 k gas |
| Same autopay registered twice | ✅ rejected `AlreadyRegistered` |
| Plan list from the chain | ✅ `Registered` event carries delegator, schedule and the full 3.2 KB signed calldata |
| Before start | ✅ not paid |
| Slot 0 | ✅ paid, 318 k gas; Alice 10, Bob 5, fee 0.05 |
| Same slot again | ✅ not paid |
| Slot 1 | ✅ paid, 271 k gas |
| Someone else cancels it | ✅ rejected `NotYourDelegation` |
| User cancels: one batch `[executor.cancel, disableDelegation]` | ✅ `Cancelled` + `DisabledDelegation`, 110 k gas |
| Slot 2 after cancel | ✅ not paid |
| Alice total | ✅ 20 (two runs, none after cancel) |
| The executor redeeming the disabled delegation directly | ✅ `CannotUseADisabledDelegation` |
| Report size | ✅ 3.3 KB (only the signed calldata) |

## 6. CRE (R1, simulation with real Sepolia writes)

✅ one-time intent executed · ✅ recurring run 1 (HTTP), run 2 and run 3 (cron) executed · ✅ cron inside the interval: nothing
due · ✅ after maxRuns: nothing due, 3/3 · ✅ malformed intent, 21 KB payload, intent changed after signing, forged signature,
`immediate` intent: all rejected · ✅ 4th run forced: `Exhausted` · ✅ `onReport` not from the forwarder: `InvalidSender`.

This tested the HTTP intake, which the README now replaces with `register()` (section 5).

## 7. CCIP send rules, local router (J) — 18/20 as required, 2 show what to avoid

| # | Case | Result |
| --- | --- | --- |
| J1 | One 7702 batch `[approve(router, exact amount), ccipSend{value: quote}]` | ✅ 90 k gas, allowance back to 0, fee = quote |
| J2 | Receiver is the user's 7702 address (has code) | ✅ plain token transfer, no `ccipReceive` call |
| J3 | Fee overpaid 3× | ⚠️ router keeps all of it. Also confirmed in Chainlink's real `Router.sol` source: it keeps the whole `msg.value` |
| J4 | Fee underpaid | ✅ reverts |
| J5 | Receiver = attacker | ⚠️ the chain would send it; the schema is the only guard (schema rejects it) |
| J6 | Two tokens in one message | ✅ reverts: one token per message |
| J7 | Old pattern: separate unlimited approve, bridge fails | ⚠️ unlimited allowance left behind |
| P × 13 | Plan schema: README example, receiver ≠ self, same chain, wrong token, ETH bridge, fee cap > 0.01, bridge after payment, wrong landing chain, payment not waiting, ETH payment after bridge, two accounts, 4 bridges, bridge + autopay prefund | ✅ all as required |

## 8. Plan schema (`bridge.v2.ts`) — 5/5

✅ README worked example `[j, i, i]` (Arbitrum → Base 10 USDC, no padding) accepted · ✅ `[j, k]` prefund + weekly autopay to two
people accepted · ✅ `[l]` accepted · ✅ cancel with a bad delegation hash rejected · ✅ bridge listed after a cancel rejected.

## 9. Your scenarios through both schema layers — 5/5

| Scenario | README envelope | Verified plan |
| --- | --- | --- |
| Send 0.01 ETH from Base to Arbitrum | rejected | rejected (`asset.type` must be erc20) |
| Send 10 USDC from Base to Arbitrum, pay there | accepted | accepted |
| Unified USDC: Base 6 + Arbitrum 4 → one 10 USDC payment on Sepolia | accepted | accepted |
| Unified ETH: Base + Arbitrum → Sepolia | rejected | rejected |
| Bridge lands on Arbitrum but the payment it funds is on Sepolia | **accepted** | rejected |

The last row is why the verified plan is checked as well as the envelope.

## 10. Live testnets, read-only (L)

| Check | Sepolia | Base Sepolia | Arbitrum Sepolia |
| --- | --- | --- | --- |
| RPC chain id | 11155111 ✅ | 84532 ✅ | 421614 ✅ |
| CCIP router deployed | ✅ | ✅ | ✅ |
| MetaMask DeleGator `0x63c0…E32B` | ✅ | ✅ | ✅ |
| MetaMask DelegationManager `0xdb9B…7dB3` | ✅ | ✅ | ✅ |

| Lane | Lane open | USDC pool | WETH (= ETH) pool | Fee for USDC (ETH) |
| --- | --- | --- | --- | --- |
| Sepolia → Base | ✅ | ✅ | ✅ | 0.000227 |
| Sepolia → Arbitrum | ✅ | ✅ | ✅ | 0.000249 |
| Base → Sepolia | ✅ | ✅ | ❌ | 0.000824 |
| Base → Arbitrum | ✅ | ✅ | ❌ | 0.000138 |
| Arbitrum → Sepolia | ✅ | ✅ | ✅ | 0.000823 |
| Arbitrum → Base | ✅ | ✅ | ✅ | 0.000116 |

Every OnRamp reports `OnRamp 2.0.0`. Where a pool is missing, `getFee` also reverts.

## Not tested yet

| What | Why not | How |
| --- | --- | --- |
| CCIP on forks of the live chains: USDC arrives 1:1, allowance back to 0, overpay on the live router, 7702 receiver with gas limit, ETH Arbitrum → Base arrives as WETH | first run failed to compile (stack too deep); fixed and reproduced, rerun pending | `cd ~/zkApi/ccipfork && bash run.sh` |
| A real (non-fork) CCIP transfer and its arrival time | needs a funded testnet wallet | one Sepolia → Base Sepolia USDC send |
| CRE deployed: cron reading `Registered` with `filterLogs`, `writeReport` through the real KeystoneForwarder | no deploy access | `cre account access` |
| `IntentExecutorV3` on a live testnet | not deployed | deploy on Sepolia, rerun section 5 against it |
| Real USDC (not a mock at the same address) in the autopay path | local chain | covered once V3 runs on Sepolia |
| ENSv2 resolution and subname listing | not started | Sepolia UniversalResolverV2 |
| Agent layer (LLM steps, placeholders, databases, dual LLM) | not built yet | — |

## Rerun

```bash
# local suites (lab/)
cd lab && npm i && (cd contracts && npm i) && node compile.mjs
node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil --hardfork prague --chain-id 11155111 &
for t in schema onchain e2e.v2 register.v3 ccip plan scenarios; do npx bun src/$t.test.ts; done

# live read + forks (ccipfork/, needs internet and Foundry)
cd ccipfork && bash run.sh
```
