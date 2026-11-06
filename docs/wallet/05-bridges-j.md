# Part 5: Bridges (`j`)

**Goal:** move USDC to the user's own address on another chain, then let dependent steps run.

**Spec:** §14.2 rule 4, A.3 `j`, A.4, A.5 rules 6–8, D14–D16. **Depends on:** Parts 2, 3. **Blocked by:** OQ-07 for arrival.

## What to build

One 7702 batch: `[approve(router, exact amount), ccipSend{value: fee}]`.

```text
ccipSend(destSelector, {
  receiver:     abi.encode(user address),
  data:         0x,
  tokenAmounts: [{ token: USDC[source], amount }],              // exactly one token per message (J6)
  feeToken:     0x0000000000000000000000000000000000000000,     // fee in native ETH
  extraArgs:    0x181dcf10 ++ abi.encode(uint256 0, bool true)  // GenericExtraArgsV2: gasLimit 0, out-of-order allowed
})
```

## Registry (A.4)

| Chain | Chain id | CCIP selector | Router | USDC |
| --- | --- | --- | --- | --- |
| Ethereum Sepolia | 11155111 | 16015286601757825753 | `0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Base Sepolia | 84532 | 10344971235874465080 | `0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93` | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Arbitrum Sepolia | 421614 | 3478487238524512106 | `0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |

`bridge.v2.ts` already holds selectors and routers. All six lanes had a USDC pool on 6 Nov.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W5-01 | Build the message from envelope fields and the registry; `receiver` = `wallet_address` | Spec: A.3, rule 1 |
| W5-02 | Quote with `router.getFee` right before signing | Spec: rule 4 |
| W5-03 | If quote > `fee_max_eth`: refuse, report `failed`, sign nothing | Spec: rule 4 |
| W5-04 | Send `value` = the quote exactly | Spec: A.5 rule 6 |
| W5-05 | Approve exactly the amount, in the same batch | Spec: A.5 rule 7 |
| W5-06 | Confirm the send: USDC debited on source, allowance back to 0 | Spec: rule 8; J1 |
| W5-07 | Wait for arrival on the destination | **OQ-07** |
| W5-08 | Release dependents only after arrival | Spec: rule 4 |
| W5-09 | Report `intent_result` with `bridge_fee_eth` = the actual fee | Spec: §14.3 |
| W5-10 | Survive a restart during the wait, without sending a second bridge | Rule 7 |

## Rules from tests

| Rule | Test | Effect of breaking it |
| --- | --- | --- |
| Receiver must be the user | J5 | The chain would send to anyone; only the schema stops this |
| Exact fee | J3 | The router keeps any overpayment |
| Fee too low reverts | J4 | Step fails |
| One token per message | J6 | Reverts |
| Approve inside the batch | J7 | A separate unlimited approval is left behind if the bridge fails |
| Receiver with 7702 code | J2 | Plain token transfer, no `ccipReceive` |

## How far this is proven

| Claim | Status |
| --- | --- |
| Send rules | Local router stand-in (J) |
| Lanes, pools, fees | Live, read-only (L) |
| USDC arrives 1:1 | **Not tested**: fork test 4, Part 0 |
| Real transfer and arrival time | **Not tested**: W0-07 |
| 7702 receiver on the live router | **Not tested**: fork test 8 |

## Points to confirm while building

- **Time between quote and mining.** The fee is quoted before signing. If it rises before the transaction lands, J4
  says the send reverts. The spec does not say whether to re-quote and retry. Default: report `failed`, because re-signing
  needs a new user approval. Confirm with OQ-02.
- **Failure after send.** If the send succeeds and arrival times out, the money may still arrive later. Rule 2 still bars
  dependents, and D14 says money stays the user's. Report `failed` only per OQ-07's decision, since the bridge may still
  complete.
- **Lane check.** It belongs to agent S9 (§10.4), not the wallet. The wallet does not repeat it, and `getFee` reverting
  on a missing pool (L) ends in a `failed` report.

## Tests

| Test | Expected | Source |
| --- | --- | --- |
| Quote above `fee_max_eth` | Nothing signed, reported `failed` | Rule 4 |
| Batch on local router | Allowance 0, fee = quote | J1 |
| `[j, i]` | `i` starts only after arrival | Rule 4, E2 |
| Bridge fails | `i` never starts; reported per OQ-08 | Rule 2 |
| Restart during wait | No second send; wait resumes | Rule 7 |
| Real send on each of the six lanes | Arrives 1:1, report has actual fee | **Part 11** |

## Exit criteria

E2 and E3 envelopes complete on live testnets, with the arrival rule holding and the actual fee reported.
