# Part 3: Account and signing

**Goal:** the user's address works as a MetaMask 7702 smart account on each chain, and signing happens through whatever
OQ-01 and OQ-02 decide.

**Spec:** A.1, D4, §2.3, §14.2. **Depends on:** Part 0. **Blocked by:** OQ-01, OQ-02, OQ-19.

> **OQ-01 is decided: Option A.** The wallet holds the key, encrypted on the user's device, and signs after the user
> approves in the wallet. Key creation or import and the exact storage are still open.

## Facts from the spec and tests

| Item | Value | Source |
| --- | --- | --- |
| User account | EOA upgraded with EIP-7702; same address on every chain; one authorization per chain | A.1 |
| EIP7702StatelessDeleGator | `0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B` on all three chains | A.1 (L) |
| DelegationManager | `0xdb9B1e94B5b69Df7e401DDbedE43491141047dB3` on all three chains | A.1 (L) |
| Upgrade done live | Sepolia, tx `0xbd04…b73c` | R1 |
| Upgrade check | Account code equals `0xef0100` + implementation address | `src/chain.ts` |
| What Base and Arbitrum have | Contracts confirmed deployed (read-only). **No upgrade has been run on them** | L |

## The upgrade as tested

```ts
const authorization = await w.signAuthorization({ contractAddress: impl, executor: "self" });
await w.sendTransaction({ authorizationList: [authorization], to: owner.address, data: "0x" });
```

Source: `src/chain.ts`, `work2/metamask/flow.ts:48`. Both use a raw local key.

## What the signer must do

| Capability | Used by | Tested with |
| --- | --- | --- |
| Sign an EIP-7702 authorization per chain | This part | `signAuthorization` (viem) |
| Send a transaction to self with `execute(BatchDefault, …)` | Parts 4, 5, 8 | viem wallet client |
| Sign an EIP-712 delegation | Part 7 | `signDelegation` (kit `@metamask/smart-accounts-kit` 2.0.0) |
| Send a direct transaction to `register` | Part 7 | viem wallet client |

Every candidate for OQ-01 must be checked against all four rows, and specifically for EIP-7702 authorization support. The
sources do not show this for anything other than a raw local key.

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W3-01 | Implement the signer chosen in OQ-01 | **OQ-01** |
| W3-02 | Implement the approval flow chosen in OQ-02, including rejection reported as a step failure | **OQ-02** |
| W3-03 | `ensureUpgraded(chain)`: read code; upgrade if plain EOA; verify `0xef0100` + DeleGator | Spec: A.1. Timing: **OQ-19** |
| W3-04 | Refuse if the account is delegated to any other code | **OQ-19** |
| W3-05 | Per-chain nonce handling: one in-flight tx per chain and account | Derived: the runner sends several steps from one account |
| W3-06 | Pin DeleGator and DelegationManager addresses as constants; confirm by reading code at startup | Spec: A.1; `live.viem.ts` does the read |

## Rules

- The agent and its LLM never touch keys (D1).
- The key must not appear in logs, config, reports or errors. This includes this part's own test fixtures.
- `wallet_address` in the envelope must equal the signer's address. Otherwise reject before signing. **Derived:** `PlanSchema`
  checks one `from` across steps but not that it is the signer.

## Tests

| Test | Expected | Status today |
| --- | --- | --- |
| Upgrade on local Prague chain | Code = `0xef0100` + implementation | Done in `chain.ts` |
| Upgrade on Base Sepolia and Arbitrum Sepolia | Same | **New; never run** |
| Second upgrade request on an upgraded account | No transaction | New |
| Account delegated elsewhere | Refused | New |
| Envelope `wallet_address` ≠ signer | Rejected, nothing signed | New |
| User rejects signing | Step reported `failed` | New, per OQ-02 |

## Exit criteria

The address is upgraded on all three testnets through the real signer, and the four capabilities work on each.
