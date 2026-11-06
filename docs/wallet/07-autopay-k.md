# Part 7: Autopay creation (`k`)

**Goal:** turn one `k` intent into a signed delegation and an onchain registration. Nothing moves at creation.

**Spec:** §14.2 rule 5, A.3 `k` steps 1–3, A.5 rules 1–3, D4, D5, D10, D12. **Depends on:** Parts 2, 3, 6.
**Blocked by:** OQ-09, OQ-10, OQ-11.

## Flow

1. **Executions.** `[transfer(recipient, amount), transfer(fee.to, fee.amount)]`: the payment, then the fee, in one batch.
2. **Delegation.** Delegator = user. Delegate = the chain's `IntentExecutorV3`. Authority = root.
   Caveats: `exactExecutionBatch(executions)`, `limitedCalls(max_runs)`, `timestamp(start_at, end_at)`.
   `salt` = hash of the intent. The user signs with EIP-712. Nothing moves.
3. **Registration.** The user's account sends `register(start_at, interval_seconds, late_window_seconds, max_runs, redeem)`.
4. **Report.** `plan_id` = `keccak256(redeem)`, plus the executor address.

A weekly autopay on several days arrives as several `k` intents, one per leg (§10.6). Each one goes through this flow
separately, with its own delegation, plan and `autopay_id`.

## What exists

`register.v3.test.ts` does all of this with a raw key: `compile()` for steps 1–2, `redeemCalldata` for the redeem bytes,
`registerData` for step 3.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W7-01 | Build executions with `executionsOf` from `redeem.v2.ts` | Spec: A.3 step 1; A.5 rule 1 |
| W7-02 | Build caveats with the kit's `createCaveatBuilder` | Spec: rule 5 |
| W7-03 | Timestamp caveat bounds | **OQ-10.** Tested code used `start - 1` |
| W7-04 | Choose `intentId`, compute `salt` = `BigInt(intentHash(intent))` | **OQ-09** |
| W7-05 | Sign through Part 3 | **OQ-01** |
| W7-06 | Build redeem with `redeemCalldata`: always batch mode | Spec: A.5 rule 3; B10 |
| W7-07 | **Persist the signed delegation before sending `register`** | Derived: OQ-09 duplicate-plan risk |
| W7-08 | Handle a late `start_at` | **OQ-11** |
| W7-09 | Send `register` from the user's account | Spec: rule 5 |
| W7-10 | Treat `AlreadyRegistered` after a resend as success only if `plan_id` matches the stored one | Derived from rule 7 |
| W7-11 | Effect check: `Registered` log from this executor with the expected `plan_id` and schedule | Spec: rule 8 |
| W7-12 | Report `intent_result` with `autopay_id`, `plan_id`, `executor_address` | Spec: §14.2 rule 5, §14.3 |
| W7-13 | Store `plan_id` ↔ `request_id`, `autopay_id`, chain, token, amount, fee for Part 10 | Spec need: §14.3 `autopay_payment` |

## Mapping for the `register` call

| `register` argument | Envelope field |
| --- | --- |
| `startAt` | `schedule.start_at` |
| `interval` | `schedule.interval_seconds` |
| `lateWindow` | `schedule.late_window_seconds` |
| `maxRuns` | `schedule.max_runs` |

`end_at` goes only into the timestamp caveat. `max_per_run` and `max_total` are checked in Part 1 and shown to the user;
the signed exact batch enforces them onchain.

## Rules from tests

| Rule | Test |
| --- | --- |
| `startAt` must be a `timestamp` caveat, or the first run pays immediately | B7a, B7b |
| The executor cannot redirect the fee | B8 |
| Recipient swap, amount change, forged signature, wrong redeemer: all blocked | R1 |
| Past `endAt` fails with `expired-delegation` | B6 |
| After `max_runs` | C7, R1 |

## Funding

The money stays in the wallet until each run (D4). The agent checks the wallet holds `max_total` at creation (§10.3). If
the user spends it later, a run is skipped. The summary already warns about that (§13.1). The wallet takes no action at
creation, and locks nothing.

## `[j, k]` plans

§10.3 and D-04 allow a bridge first. The `k` runs after the bridge arrives, which is where OQ-11 matters most: the bridge
wait can use up the time before `start_at`.

## Privacy

A `k`'s recipient, amount, fee, run times and run count become public when `Registered` is emitted (§16.2). Names and
timezones must not appear anywhere in this flow; the §12.5 envelope has no field for them.

## Tests

| Test | Expected | Source |
| --- | --- | --- |
| E6 envelope, local chain | Registered; `plan_id` = `keccak256(redeem)`; report correct | V |
| A-64 two legs | Two plans, two `autopay_id`s, one signing flow per OQ-02 | §10.6 |
| Same delegation submitted again | No second plan | V, rule 7 |
| Crash after signing, before `register` | Restart sends the **same** redeem | **New: OQ-09** |
| Crash after `register`, before storing the result | Restart detects the plan, no second plan | **New** |
| `start_at` passed during signing | Per OQ-11 | **New** |
| Delegation signed on chain A, used on chain B | Rejected by the chain | **New**: EIP-712 domain includes the chain |
| ETH leg | Registered; runs in Part 6's new test | **New** |

## Exit criteria

E6 and A-64 are registered on a live testnet from the real signer, and the agent receives `plan_id` and the executor address.
