# Part 9: CRE workflow

**Goal:** one shared cron workflow that pays every registered run when it is due.

**Spec:** A.1, A.3 `k` steps 4–5, A.5 rules 5, 9, 10, D10, D11. **Depends on:** Part 6. **Blocked by:** OQ-16, OQ-18.

## This must be written new

The workflow at `work2/cre-intents/intake/` targets the **first executor**, and v1.1 replaces its design. It cannot be
reused as it stands:

| Old workflow | Required by v1.1 |
| --- | --- |
| Two triggers, HTTP intake + cron | Cron only (A.1) |
| Plan list from `IntentExecutor.due()` | V3 has no `due()`. Read `Registered` minus `Cancelled` with `filterLogs` (A.3 step 4) |
| Report = `(intentKey, interval, maxRuns, redeem)` | Report = `abi.encode(bytes redeem)` (V3 `_processReport`) |
| One chain | One workflow serving three chains (D11) |

## What can be reused from `lib/exec.ts`

- The `eth_simulateV1` call through `HTTPClient` with consensus aggregation.
- The `runtime.report` + `evm.writeReport` sequence.
- `gasFor`: simulated gas × 2, capped at CRE's 10 M, with a 500 k floor.

### Three things that would break if copied

| Line | Problem |
| --- | --- |
| `transfers` counts logs from `0xfff…fffe` | Those are the **ETH** transfer logs (`RESULTS.md`, Quirks). A USDC run shows 0 transfers, and the cron skips `sim.transfers === 0`. **Every USDC autopay would be skipped** |
| `onReport` simulated with metadata `"0x"` | Once `setExpectedWorkflowId` is set, `ReceiverTemplate` checks the workflow id from the metadata. Simulation must pass real metadata, packed as `workflowId, name, owner` |
| `alchemyBase` is one URL | Three chains need three endpoints (OQ-18) |

## Each cron run, per chain

From A.3 step 4 and the executor source:

1. Read `Registered` and `Cancelled` logs with `filterLogs`, from the deployment block.
2. Plans = `Registered` minus `Cancelled`.
3. For each plan, work out the current slot: `(now − startAt) / interval`.
4. Due = started, slot < `maxRuns`, `now ≤ slotTime + lateWindow`, and `slot > lastSlot` (read `plans(id)`).
5. Simulate the forwarder calling `onReport` for each due run.
6. If the simulation shows the effect, write the report `abi.encode(redeem)`.

The contract re-checks everything in step 4, so a workflow bug cannot pay wrongly. It can only miss a run.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W9-01 | New workflow with cron trigger only | Spec: A.1 |
| W9-02 | Plan list from `filterLogs` | Spec: A.3 step 4 |
| W9-03 | Due logic mirroring `_processReport` | Tested code |
| W9-04 | Simulation that recognises USDC runs (Transfer logs) and passes real metadata | Spec: A.3 step 4; problems above |
| W9-05 | `writeReport` with `abi.encode(redeem)` | Spec: A.3 step 4 |
| W9-06 | Three-chain config: selectors, executors, forwarders, deployment blocks | Spec: D11; values from **OQ-16** |
| W9-07 | Capacity handling above ~14 due runs | **OQ-18**; A.5 rule 10 |
| W9-08 | Simulate with `cre workflow simulate`, as R1 did | Tested method |
| W9-09 | Deploy once access is enabled; take the workflow id to W6-08 | **OQ-16** |

## CRE limits to respect (A.5)

| Limit | Value | Applies to |
| --- | --- | --- |
| Report size | 50 KB | 3.3 KB for 2 recipients + fee (V) |
| Gas per tx | 10 M | 271–318 k per run (V) |
| HTTP calls per execution | 15 | One simulation per due run |
| Cron minimum | 30 s | A.3 says every 30–60 s |
| Workflows per org | 3 | One workflow |

`RESULTS.md` also records 5 secret fetches and a 5-minute timeout per execution. These limits come from the service-quotas
page as of 29 Oct. Re-check them when deploying, along with log-read and chain-write quotas, which the sources do not record.

## How far this is proven

| Claim | Status |
| --- | --- |
| `filterLogs` exists in the SDK | Yes: in `@chainlink/cre-sdk` 1.23.0 generated client. **Never run** |
| Cron + simulate + `writeReport` | CRE CLI simulator, with real Sepolia writes, on the first executor (R1) |
| V3 through the real forwarder | **Not tested.** Local tests used `MockForwarder`, which doesn't check DON signatures |
| Base and Arbitrum | **Not tested** |

## Rules

- CRE holds no key that can spend (D11). Do not add one.
- Success is the `Executed` event, not the forwarder receipt, which succeeds even when `onReport` reverts (A.5 rule 5).
- A workflow failure means runs are missed, never wrongly paid (D11). Missed runs are skipped, not paid late (D9).

## Tests

| Test | Expected | Source |
| --- | --- | --- |
| Before start, inside window, same slot again, after last slot, cancelled | Correct due/not due | V, e2e |
| Cron 3 h late with a 1 h window | Slot skipped, next on time | C6 |
| USDC plan | Treated as paid-effect, not skipped | **New**: guards the copied-line bug |
| Foreign workflow's report | `InvalidWorkflowId` | C8 |
| More than the capacity limit due | No run lost silently within its late window, per OQ-18 | A.5 rule 10 |
| Plans on all three chains | Each paid on its own chain | **New** |

## Exit criteria

In the simulator, the workflow pays a V3 USDC plan on Sepolia. Once deployed, it pays plans on all three chains through the
real forwarder. If access stays blocked, the second half stays open in Part 11.
