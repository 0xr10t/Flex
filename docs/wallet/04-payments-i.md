# Part 4: One-time payments (`i`)

**Goal:** pay one person or a whole group in one all-or-nothing transaction.

**Spec:** §14.2 rule 3, A.3 `i`, D6, A.5 rules 1 and 3. **Depends on:** Parts 2, 3.

## What to build

One transaction from the user's account to itself: `execute(BatchDefault, [calls])`.

| Token | Call |
| --- | --- |
| ETH | `{ to: recipient, value: base_units, data: 0x }` |
| USDC | `{ to: token_address, value: 0, data: transfer(recipient, base_units) }` |

There is one call per entry in `recipients[]`, at most 100.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W4-01 | Build calls from `recipients[]` using `base_units`; ETH with empty `data` | Spec: §14.2 rules 1, 3 |
| W4-02 | Always encode as `BatchDefault`, including for one recipient | Spec: A.5 rule 3 |
| W4-03 | Send through Part 3's signer and account | Spec: A.3 |
| W4-04 | Effect check for each recipient | Spec: rule 8 |
| W4-05 | Report `intent_result` | Spec: §14.3 |

## Effect check

Rule 8 demands the effect. B1 is why: an ERC-20 intent built wrongly produced a successful transaction in which the
recipient got 0 USDC. The check must therefore look at more than the receipt status.

| Token | Check | Note |
| --- | --- | --- |
| USDC | One `Transfer` log per recipient from `token_address`, with the right `to` and `value` | Works from the receipt alone, needs no extra reads |
| ETH | Receipt success on the batch | A failed call reverts the whole batch (B4). Plain transfers emit no log, and a balance read could be skewed by other incoming funds. **The sources don't define an exact ETH check.** Record what is implemented |

## Encoder warning

- **B10:** one recipient through MetaMask's kit encoder + batch delegation reverts, because the kit switches to single mode.
- **`redeem.v2.ts`** uses its own encoder and is the one that passed (B10b).
- That finding is about delegations (`k`). The self-execute path used the kit's `encodeBatchExecution` in B3
  (`onchain.test.ts:108`) and the e2e immediate path (`e2e.v2.test.ts:79`), both with **two** calls. A single-recipient `i`
  on this path is not among the tests read, so W4-02 needs its own test below.

## Rules from tests

| Rule | Test |
| --- | --- |
| USDC is `transfer`, never native value | B1 |
| All recipients or none | B4 |
| 100 USDC recipients = 3.91 M gas; 50 = 2.02 M; 20 = 0.89 M | B12 |
| ETH + USDC in one transaction = 122 k gas | B3 |

## Tests

| Test | Expected | Status |
| --- | --- | --- |
| One USDC recipient, batch mode | Paid | **New: guards W4-02** |
| One ETH recipient | Paid, empty `data` | New |
| Group of 2, of 100 | One tx, all paid | B12 covers the 100 gas figure locally |
| Group of 101 | Rejected at intake | Part 1 |
| Second recipient rejects ETH | Whole batch reverts; reported `failed`; first recipient unpaid | B4 |
| Duplicate submit | One payment | Part 2 |
| On real USDC, on each chain | Paid | **New: Part 11** (tests used a mock) |

## Exit criteria

E1 and E4 envelopes pay correctly on a local chain and on each testnet, and the report matches the effect.
