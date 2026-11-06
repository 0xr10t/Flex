# Part 10: Autopay run reporting

**Goal:** tell the agent about every autopay run, so the daily limit and the registry stay correct.

**Spec:** §14.3, §14.2 rule 8, §11.4, D-19, A.5 rule 5. **Depends on:** Parts 2, 6, and the store from Part 7. **Blocked by:** OQ-14.

> **The spec states the report and not its source.** CRE pays the runs in the cloud and cannot reach an agent on
> `127.0.0.1`, so something on the user's device has to notice each run. This part follows from that. The details are in
> OQ-14.

## Reports to send

```json
{
  "kind": "autopay_payment",
  "request_id": "req_…",
  "status": "executed",
  "tx_hash": "0x…",
  "executed_at": "2026-11-06T10:00:05Z",
  "autopay": {
    "autopay_id": "ap_…", "plan_id": "0x…", "executor_address": "0x…", "slot": 3,
    "status": "active", "amount": "10", "fee": "0.05", "chain_id": 84532, "token": "USDC"
  }
}
```

| Kind | When | Agent action (§14.3) |
| --- | --- | --- |
| `autopay_payment` | After each `Executed` event | Inserts DB6 `autopay_payment` and `autopay_fee` rows, `status='executed'`, counted |
| `autopay_status` | Plan finished or failed | Updates DB7 status (`ended`, `failed`) |

## Where each field comes from

| Field | Source |
| --- | --- |
| `autopay.plan_id` | `Executed.intentId` |
| `autopay.slot` | `Executed.slot` |
| `tx_hash` | The log's transaction |
| `executed_at` | The block's timestamp |
| `request_id`, `autopay_id`, `amount`, `fee`, `chain_id`, `token`, `executor_address` | The wallet's store, from Part 7. The event does not carry them |

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W10-01 | Watch `Executed` on each chain's executor, for this user's plans only | Spec need; **OQ-14** |
| W10-02 | Store the last processed block per chain | Derived: runs while the wallet is off must not be lost (D-19) |
| W10-03 | Catch up from that block at startup | **OQ-14(a)** |
| W10-04 | Join event + store; send `autopay_payment` | Spec: §14.3 |
| W10-05 | Send each report once only | **Risk below** |
| W10-06 | Retry when the agent is unreachable | **OQ-14(d)** |
| W10-07 | Send `autopay_status: ended` | Spec: §14.3; trigger is **OQ-14(c)** |
| W10-08 | Decide what happens on skipped slots | **OQ-14(b)** |

## Risk: duplicate reports inflate the daily limit

`autopay_payment` **inserts** rows on the agent (§14.3), and the spec defines no duplicate check, so a repeated report counts
the run twice.

- **In the wallet:** mark a report sent only after the agent's `204`. A lost `204` therefore causes a resend.
- **In the agent (for the agent's v1.1 owner to consider):** ignore a report whose `autopay_id` + `tx_hash` is already in
  DB6. Both columns exist in §7.1, so no schema change is needed, but the §14.3 behaviour would change. This is OQ-14(f).

## Risk: amounts are from the plan, not the chain

`Executed` carries no amounts. The executed batch is fixed by the signed delegation (`exactExecutionBatch`), so the stored
amounts match what was paid, and A.5 rule 5 is met by the event itself. The join depends entirely on Part 7's store, so a
lost store loses the amounts. They can still be recovered by decoding `redeem` from `Registered`.

## What the watcher must not do

- Treat a forwarder transaction as success. Only `Executed` counts: the forwarder tx succeeds even when `onReport` reverts
  (A.5 rule 5).
- Send names or prompt text (§14.3).
- Log amounts, addresses or tx hashes (OQ-04).

## Tests

| Test | Expected | Source |
| --- | --- | --- |
| `Executed` seen | One report, fields joined correctly; agent has two DB6 rows | A-55 |
| Wallet off during two runs | Two reports on restart, in order | D-19 |
| Agent down | Retried until `204` | OQ-14 |
| Forwarder tx succeeded, no `Executed` | No report | A.5 rule 5 |
| Another user's plan on the shared executor | Ignored | D11: executor is shared |
| Last slot passed | `autopay_status: ended`; agent's DB7 → `ended` | §14.3 |
| Lost `204` | Behaviour per the decision above; not silently double-counted once deduped | **New** |

## Exit criteria

With a local forwarder, every paid run reaches the agent exactly as §14.3 specifies, including after a wallet restart, and
the agent's daily-limit count matches the chain.
