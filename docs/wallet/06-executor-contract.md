# Part 6: Executor contract

**Goal:** `IntentExecutorV3` in the project, tested, and deployed once per chain.

**Spec:** A.1, A.3 `k` step 5, A.5 rule 4, D10, D11. **Depends on:** Part 0. **Blocked by:** OQ-16, OQ-17 for live deploys.

## What exists

| Item | State |
| --- | --- |
| `IntentExecutorV3.sol` | Written; 16/16 locally. Same file in `final/code/` and `lab.zip` |
| `ReceiverTemplate.sol`, `IReceiver.sol`, `IERC165.sol` | In `lab.zip` |
| Build | `compile.mjs`: solc-js, optimizer 200 runs, `evmVersion: cancun`; OpenZeppelin `^5.6.1` |
| Deploy script | **None for a public chain.** `chain.ts` deploys locally only |
| Live deployment | **None.** R1's `0xf207…5fF1` is the first executor, not V3 |

Only V3 is in scope. `IntentExecutor`, `V2`, `IntentVault` and `BatchDelegate` are the older designs that V3 replaces, and
should not be carried over. `TestHelpers.sol` (`MockUSDC`, `RejectEth`, `MockForwarder`) is for tests only.

## Contract surface (from the source)

| Function | Rule |
| --- | --- |
| `constructor(forwarder, delegationManager)` | Deployer becomes the owner |
| `register(startAt, interval, lateWindow, maxRuns, redeem)` | Delegator must be the sender; delegate must be this contract; no duplicates; stores hash and schedule; emits `Registered` |
| `cancel(id)` | Delegator only |
| `_processReport(report)` | `report = abi.encode(bytes redeem)` |
| `setExpectedWorkflowId`, `setForwarderAddress` and others | Owner only (`ReceiverTemplate`) |

| Error | When | Test |
| --- | --- | --- |
| `NotYourDelegation` | Registering or cancelling someone else's | V |
| `WrongDelegate` | Delegation names another contract | V |
| `AlreadyRegistered` | Same `redeem` twice | V |
| `NotRegistered` | Report for an unknown plan | V |
| `PlanCancelled` | Report after cancel | V |
| `NotStarted`, `OutsideWindow`, `SlotAlreadyPaid`, `Exhausted` | Timing | C4–C7 on V2; V on V3 |
| `InvalidWorkflowId` | Report from another workflow | C8 |

Events: `Registered(intentId, delegator, startAt, interval, lateWindow, maxRuns, redeem)`, `Executed(intentId, slot, paid)`,
`Cancelled(intentId, delegator)`. The event's `intentId` is the `plan_id`.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W6-01 | Bring contracts into the project with the same compiler settings | Tested code |
| W6-02 | Port `register.v3.test.ts` (16 cases) | Tested code |
| W6-03 | Add the missing tests below | Gaps below |
| W6-04 | Write a deploy script: `(forwarder, DelegationManager)` per chain | Spec: A.1 |
| W6-05 | Choose the owner key | **OQ-17** |
| W6-06 | Deploy on Sepolia with the forwarder from OQ-16 | Spec: A.6 |
| W6-07 | Deploy on Base Sepolia and Arbitrum Sepolia | Spec: A.1 "one per chain" |
| W6-08 | `setExpectedWorkflowId` once the workflow id is known (Part 9) | Spec: A.1, A.5 rule 4 |
| W6-09 | Record each executor address and deployment block in the wallet config | **OQ-15** |
| W6-10 | Verify source on each chain's explorer | Lets users check the code that holds their delegation; not in the spec, skip if unwanted |

## Order for W6-08

1. Deploy the executor (W6-06).
2. Deploy the workflow with that executor address in its config (Part 9).
3. Set the workflow id on the executor.
4. Only then register real plans. This closes C3, where a foreign workflow's report was accepted.

Until step 3, any workflow going through the forwarder passes the id check. The other rules still hold (D5, D11): a
report can only run a registered plan, in its window, with its exact batch.

## Test gaps to close

| Case | Why |
| --- | --- |
| ETH autopay through V3 | §6.1 has `autopay.fee.ETH` and §12.5 allows it. V ran USDC only; native ran on the first executor only (R1) |
| One recipient + fee through V3 | §12.5 `k` has exactly one recipient; V used two recipients + fee |
| Run at exactly `startAt` and at exactly `slot + lateWindow` | OQ-10 |
| `lateWindow` = `interval` | Allowed by the contract and schema |
| Delegator's balance too low at run time | D4 says the run is skipped. The revert must leave the slot unpaid. Confirm a later slot still pays |

The first executor's 7.25 M gas first run does not apply here: V3 stores only the hash (`register` 154 k, run 271–318 k, V).

## Exit criteria

- All tests pass locally, including the new cases.
- V3 is live on all three testnets, with the owner and addresses recorded.
- `setExpectedWorkflowId` is set wherever a real workflow exists. If CRE access is still blocked, this stays open in Part 11.
