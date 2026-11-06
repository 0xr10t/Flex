# Part 8: Cancel (`l`)

**Goal:** stop an autopay in one batch. Nothing is refunded, because the money never left the wallet.

**Spec:** §14.2 rule 6, A.3 `l`, §12.5 mapping row `l`, D13. **Depends on:** Parts 2, 3, 7.

## What to build

One batch from the user's account: `[IntentExecutor.cancel(plan_id), DelegationManager.disableDelegation(delegation)]`.

The envelope carries `plan_id` but not the delegation. Per §12.5, the wallet reads the signed delegation back from the
executor's `Registered` event for that `plan_id`, and hashes it for `CancelSchema.delegationHash`.

## Reading the delegation

1. Query `Registered` logs on the executor, filtered by the indexed `intentId` = `plan_id`.
2. Take `redeem` from the event. Decode `redeemDelegations(contexts, modes, execs)`, then `contexts[0]` as `Delegation[]`.
3. Confirm: exactly one delegation, delegator = `wallet_address`, delegate = executor, `keccak256(redeem)` = `plan_id`.
4. Hash it for `delegationHash`. Pass the decoded delegation to `disableDelegation`.

The decoding shape comes from `IntentExecutorV3.register`, which performs the same decode. `register.v3.test.ts` passes the
delegation it already holds to `disableDelegation`, so **reading it back from the event has never been tested**. Part 7 stores
the signed delegation (W7-07), but the spec says to read from the event, so this plan follows the spec. The event read
also works if the local store is lost.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W8-01 | Read and decode the delegation from `Registered` | Spec: §12.5 |
| W8-02 | Check the decoded delegation, as in step 3 above | Derived: a bad `plan_id` must fail before signing |
| W8-03 | Compute `delegationHash` with the kit's or the DelegationManager's hash | Spec: §12.5. **Replaces the test stand-in** |
| W8-04 | Build the batch with `cancel` first, `disableDelegation` second | Spec: rule 6 |
| W8-05 | Send through Part 3 | Spec: A.3 |
| W8-06 | Effect check: `Cancelled` and `DisabledDelegation` both in the receipt | Spec: rule 8; V |
| W8-07 | Report `intent_result`; the agent moves DB7 to `cancelled` | Spec: §14.3 |

A cancel with several legs arrives as one `l` per leg (§10.7), each with its own `plan_id`.

## Tested behaviour

From the V suite: 110 k gas.

| Case | Result |
| --- | --- |
| Someone else cancels | `NotYourDelegation` |
| User cancels in one batch | `Cancelled` + `DisabledDelegation` |
| Report after cancel | Not paid |
| Executor redeems the disabled delegation directly | `CannotUseADisabledDelegation` |
| Earlier runs | Stay paid: Alice's total is 20 after two runs |

## Edge cases to test

| Case | Expected |
| --- | --- |
| Unknown `plan_id` | No `Registered` log; reported `failed`, nothing signed |
| Plan already cancelled | The spec doesn't cover this. `cancel` in the contract does not revert on a repeat. Record behaviour; `disableDelegation` on an already-disabled delegation must be tested |
| Plan already finished | The agent sends `l` only for `active` rows (V-09). If `autopay_status` has not landed yet, the same case can reach the wallet. Must not lose money; record the result |
| Cancel racing a due run | Either ordering is safe: the run pays once or not at all. Report what happened |
| Log range limits on the RPC | Query from the executor's deployment block; split ranges if the provider requires it (OQ-15) |

## Exit criteria

An E7 envelope cancels a live plan using the delegation read from the event, and the next due run pays nothing.
