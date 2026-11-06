# Part 11: Integration and live verification

**Goal:** agent and wallet working together, and every "not tested yet" item in A.6 closed with a result.

**Spec:** A.6, §20.2, D1, `TESTED_2.md` §8. **Depends on:** all other parts, and the agent's v1.1 work (OQ-05).

## Stage 1: agent ↔ wallet on a local chain

Local Prague chain with the real MetaMask contracts, as in the lab. `MockUSDC` and `MockForwarder` are acceptable here, and
should be recorded as stand-ins.

| Test | Scenario | Expected |
| --- | --- | --- |
| A-01 | E1 | One `i` paid |
| A-04 | E4 | One tx, all members paid |
| A-08 | E6 | `k` registered; DB7 active with `plan_id` |
| A-11 | E7 | `l` from DB7 cancels the plan |
| A-54 | Report for `k` | DB7 has `plan_id`, `executor_address` |
| A-55 | `autopay_payment` | DB6 rows, counted in today's limit |
| A-64 | Two legs | Two plans, one summary line; cancel gives two `l` |
| A-51 | Wallet 503, then confirm again | Same key, one execution |
| A-52 | Wallet 400 | `EXECUTION_REJECTED` |

A-02 and A-03 need a working cross-chain path, so they run in Stage 2.

## Stage 2: live testnets

Each row is an A.6 item or a stand-in from `TESTED_2.md` §2 that must be replaced. Update `TESTED*.md` when each one finishes.

| Item | How | Replaces | Part |
| --- | --- | --- | --- |
| USDC arrives 1:1, allowance 0, overpay, 7702 receiver | Fork suite | Local router (J) | 0 |
| Real CCIP transfer + arrival time | Real send | Local router | 0, 5 |
| All six lanes through the real wallet | A-02, A-03 on testnets | — | 5 |
| 7702 upgrade on Base and Arbitrum | Real signer | Sepolia only | 3 |
| `IntentExecutorV3` on a live testnet | Rerun the V suite against it | Local deployment | 6 |
| Real USDC in the autopay path | V suite on Sepolia | `MockUSDC` (no blacklist, pause or permit) | 6 |
| `filterLogs` inside CRE | Deployed workflow | Test code playing the cron | 9 |
| Real KeystoneForwarder with DON signatures | Deployed workflow | `MockForwarder` | 9 |
| Autopay on Base and Arbitrum | Deployed workflow | Sepolia only | 9 |
| ETH autopay through V3 | Live plan | USDC-only V suite | 6, 7 |

## Stage 3: full user journeys on testnets

Real local model if available. `TESTED_2.md` notes the model has never been run, and C-514 (§20.3 evaluation) is an agent
item that this plan does not cover.

| Journey | Check on chain |
| --- | --- |
| E1 single payment | USDC received |
| E2 bridge and pay | Bridged amount, then payment; actual fee reported |
| E3 mixed | Independent step, dependent step, right order |
| E4 ENS group | All members paid in one tx |
| E6 weekly autopay | Pays on schedule, fee to collector, count in the daily limit |
| A missed run | Skipped, not paid late, next run on time |
| E7 cancel | No later run pays |

ENSv2 resolution is listed in A.6 as not tested. It runs in the agent (§9, §14.5), so it is **not wallet work**, but journey
E4 cannot pass without it. The §9.6 indexer query also uses the classic subgraph shape and has to be checked against the
chosen indexer (D7). Flag it to the agent's owner.

## Privacy checks

From §16.2 and D1:

| Check | Method |
| --- | --- |
| No names, prompt text or summary in anything the wallet receives | Inspect received envelopes |
| No memo or extra calldata | Decode every sent transaction against the expected calls |
| ETH transfers have empty `data` | Same decode |
| Reports hold no names | Inspect reports |
| Keys and values absent from wallet logs | Grep logs after a full run, like A-60 |

## Failure drills

| Drill | Expected |
| --- | --- |
| Wallet restart during a bridge wait | Resumes; no second bridge |
| Agent restart during execution | Reports retried |
| RPC outage during a step | Step does not double-send |
| Balance spent before an autopay run | Run skipped; next run pays if funded |
| CRE outage | Runs stop; nothing wrong is paid (D11) |

## Exit criteria

- Every A.6 row has a recorded result or a named owner and reason.
- `TESTED*.md` and the README's status notes reflect the results.
- If `bridge_buffer_pct` changed, the config and §6.3 are updated.
- Every OQ is closed or explicitly deferred.
