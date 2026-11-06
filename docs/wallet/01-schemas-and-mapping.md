# Part 1: Schemas and mapping

**Goal:** the second check from D3. Each envelope is validated, translated into the verified plan, and validated again.

**Spec:** §12.5 (schema, hand-off rules, mapping table), A.2, D1, D3. **Depends on:** Part 0; OQ-03, OQ-06, OQ-12.

## What exists

| Item | State |
| --- | --- |
| `intent.v2.ts` | `IntentSchema`, `intentHash`, `USDC`, limits. 43/43 |
| `bridge.v2.ts` | `BridgeSchema`, `CancelSchema`, `PlanSchema`, `CCIP` registry. 18/18 |
| `redeem.v2.ts` | `executionsOf`, `redeemCalldata` |
| `flex.handoff.test.ts` | `toPlan()`: the translator, as test code. 29/29 |
| `final/flex/envelope.schema.json` | Parsed content matches README §12.5 (checked on 6 Nov) |

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W1-01 | Bring in `intent.v2.ts`, `bridge.v2.ts`, `redeem.v2.ts` unchanged, with their schema tests | A.2 |
| W1-02 | Validate incoming envelopes against §12.5 with Ajv 2020 strict | Spec: §12 |
| W1-03 | Write the real translator from the §12.5 mapping table | Spec: §12.5; `docs/spec/TEST_MAP.md` §8 "port the mapping" |
| W1-04 | Run `PlanSchema` on every translated envelope | Spec: §12.5, D3 |
| W1-05 | Port the 29 `flex.handoff.test.ts` cases against the real translator | Tested code |
| W1-06 | Add the wallet's value-free rejection messages | Spec: §14.2 → `EXECUTION_REJECTED`, §15 "never contain amounts…" |

## Mapping (from §12.5)

| Envelope | Verified field |
| --- | --- |
| `i` | `IntentSchema`: `schedule.type "once"`, `execution.mode "immediate"`, `executor null`, `fee null`, `atomic true`, `recipients[] {to, amount}`, `limits.maxPerRun` = Σ amounts, `maxTotal null` |
| `k` | `IntentSchema`: `schedule.type "recurring"`, `startAt` = ISO of `start_at`, `interval`, `maxRuns`, `lateWindow`, `endAt`; `execution.mode "automated"`, `executor "chainlink-cre"`, `fee {to, amount}`; `recipients[] {to, amount}`, 1 to 50 (C-1); `limits {maxPerRun, maxTotal}` |
| `j` | `BridgeSchema`: `receiver` = `wallet_address`, `asset` = USDC of source, `fee {payIn "native", max: fee_max_eth}`, `execution.mode "immediate"` |
| `l` | `CancelSchema`: `autopayId`, `chainId`, `delegationHash` |
| `token`/`token_address` | `asset {type "native", token null, decimals 18}` or `{type "erc20", token, decimals 6}` |
| `step`, `depends_on`, `funds_steps` | `PlanSchema` `steps[n]`, `dependsOn`, `funds` |

## Do not port these from the test translator

| Line in `flex.handoff.test.ts` | Problem | Do instead |
| --- | --- | --- |
| `add()` uses `Number(...).toFixed(6)` | Floats on money, and truncates ETH to 6 decimals, so an ETH group can fail `maxPerRun` | Sum `base_units` with `bigint` |
| `delegationHash: x.plan_id` | Marked stand-in; `plan_id` is `keccak256(redeem)`, not a delegation hash | Read the delegation from `Registered` and hash it (Part 8). The check needs a chain read, so see below |
| `crypto.randomUUID()` for `intentId` | Changes the salt on every run | Blocked by OQ-09 |

**`l` needs a chain read before validation.** `delegationHash` comes from a `Registered` log. The translator therefore
takes a resolver input for `l`, or `l` gets a shape-only check at intake and a full check once it is read. The spec does
not say which. Pick during implementation and record it. Either way, a bad `plan_id` must fail before anything is signed.

## Rules the schemas must keep enforcing

All from A.2, each from a test:

- `chainId` in the three testnets.
- Addresses: 20-byte hex, EIP-55 if mixed case, not zero (B9).
- `native` ⇒ `token: null`, `decimals: 18`. `erc20` ⇒ the registered USDC of that chain, `decimals: 6` (B1).
- Amounts: positive decimal strings, within token decimals.
- Recipients: no duplicates, ≠ `from`, ≠ token contract; ≤ 100 one-time, ≤ 50 automated.
- More than one recipient ⇒ all-or-nothing (B4).
- `automated` ⇒ executor, fee and a concrete `startAt` not in the past (B7a, C1, B8).
- `recurring` ⇒ `interval` ≥ 60 s, `maxRuns`, `lateWindow` in [60 s, interval], total ≤ 52 weeks (C2, C6).
- `endAt` ≥ `startAt + interval·(maxRuns−1) + lateWindow` (C6).
- `maxPerRun` ≥ Σ recipients + fee; `maxTotal` ≥ that × `maxRuns` (B8).
- Fee recipient ≠ any payee (B8).
- Bridge: USDC of source only, `receiver` = `from`, source ≠ destination, `fee.max` ≤ 0.01 ETH (J5, P).
- Plan: bridges first, ≤ 3, one `from`, each bridge lands on the chain of every payment it funds (P).

**Changed:** the plan limit is now 16 steps, in both schemas (C-3 in [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md)).

**Open:** the 52-week mismatch (OQ-13).

## Tests

| Test | Expected |
| --- | --- |
| E3, E4, E6, E7, A-64, one ETH payment | Pass both checks |
| 11 old-model or malformed envelopes (`flex.handoff.test.ts` `bad`) | Rejected by §12.5 |
| 10 cross-field cases (`crossBad`) | Pass §12.5, rejected by `PlanSchema` |
| Bridge landing on the wrong chain | Rejected only by the second check |
| ETH group with 18-decimal amounts | Passes (new; guards against the `add()` bug) |
| Mixed amounts | `maxPerRun` exact in base units (new) |

## Exit criteria

All 29 ported cases pass with the real translator, and no float touches an amount.
