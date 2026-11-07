# F8: recurring payments through MetaMask permissions

Status: built on branch `f8-erc7715-recurring-permissions`; live MetaMask test pending. Delete this file when the work
merges.

## Problem

Recurring payments (`k`) ask the browser wallet to sign a raw `Delegation` with `eth_signTypedData_v4`. Current
MetaMask refuses: `-32603 "External signature requests cannot sign delegations for internal accounts."` No plan can
be registered, so cancel (`l`) is unreachable too. Websites must use ERC-7715 instead.

## Facts the design rests on

- The live MetaMask answers `wallet_getSupportedExecutionPermissions` with `erc20-token-periodic` and
  `native-token-periodic` on Ethereum, Base and Arbitrum Sepolia, each with the rules `expiry`, `redeemer`, `payee`.
  The request opens a "Token subscription request" confirmation.
- MetaMask rejects more than one `payee` in an ERC20 permission: "Multiple payee addresses are not currently
  supported for ERC20 permissions."
- `ERC20PeriodTransferEnforcer` and `NativeTokenPeriodTransferEnforcer` allow only single-call, default-mode
  executions. `IntentExecutorV3` redeems a run as one batch with one context, so it cannot redeem such a grant.
- MetaMask builds the caveats itself (`@metamask/7715-permission-types` 2.0.0, already installed through the kit):
  - `erc20-token-periodic`: ERC20PeriodTransfer, ValueLte(0), Nonce; optional Timestamp (expiry), Redeemer,
    AllowedCalldata (payee).
  - `native-token-periodic`: NativeTokenPeriodTransfer, ExactCalldata(empty), Nonce; optional Timestamp, Redeemer,
    AllowedTargets (payee).
  The same package exports `makePermissionDecoderConfigs`, the decoder MetaMask itself uses.
- The executor only ever replays the exact `redeem` bytes the delegator's own account registered, and only the
  delegate (the executor) can redeem. Recipients and amounts are therefore pinned on-chain at registration.

## Decision

One permission per plan, no `payee` rule (chosen 2026-11-07). The grant caps the token per period, expires after the
last run, and is delegated to the executor, the only account that can redeem it. The executor pins the exact recipients
and amounts. No `redeemer` rule: the delegate already decides who redeems, and an extra rule is one more thing MetaMask
could refuse.

## Design

### Contract: `IntentExecutorV4`

V3 with one rule relaxed in `register`: `redeem` may hold N ≥ 1 entries. Every context must be byte-identical and
decode to one delegation whose delegator is `msg.sender` and whose delegate is the executor. Modes and executions are
left to the DelegationManager and the enforcers. N = 1 keeps the server-key mode, which signs its own exact-batch
delegation, working unchanged. Plan id (`keccak256(redeem)`), schedule, slots, `cancel` and the CRE report path stay
as they are.

V4 is redeployed per testnet through the onboarding page's "Deploy payment executor". No browser plan can exist on V3
because F8 blocked registration, so configs simply point at V4. `wallet/cre/deployments.testnet.json` no longer lists the
V3 executors, so a fresh setup has none until onboarding deploys V4. An existing setup still points at V3: remove
`executor` from each chain in `.local/wallet.config.json`, and the chain's entries in `.local/deployments.json` and
`.local/cre-onboarding.json` if present, then onboard again. Onboarding rewrites `.local/cre.config.json`.

### Recurring plan (`k`), browser mode

1. The runner checks the plan as today, then saves a permission request for the step instead of typed data:
   - `erc20-token-periodic` with the chain's USDC, or `native-token-periodic` for ETH
   - `periodAmount` = one run's total (recipients + fee), `periodDuration` = `interval_seconds`,
     `startTime` = `start_at`, `isAdjustmentAllowed: false`, a short justification naming the plan
   - rules: `expiry` = `start_at + (max_runs - 1) × interval_seconds + late_window_seconds + 1` (the enforcer's bound
     is exclusive)
   - `from` = wallet, `to` = executor
2. The approval page shows "Review permission in MetaMask" and calls `wallet_requestExecutionPermissions`.
3. The page posts MetaMask's response to `/browser/delegation`. The server verifies it (below) and stores the
   `context`.
4. The runner builds `redeem` as one single-mode transfer per payee, all with that context, simulates the first run
   at its start time as today, and sends `register(…, redeem)` through `wallet_sendCalls`.

`redeemIdentity` (wallet and CRE) accepts the N-entry shape: identical contexts, one delegation.

### Verifying a grant

Nothing is registered unless every check passes; the response is untrusted input.

- `chainId` and `delegationManager` match the step's chain; `dependencies` is empty (a counterfactual account is
  out of scope).
- `context` decodes to exactly one delegation: delegator = wallet, delegate = executor, authority = root.
- Its caveats are exactly the ones the request implies, built with the kit for that chain's enforcers (period
  transfer, ValueLte(0) or ExactCalldata(empty), Timestamp(0, expiry)), plus one Nonce caveat of any value. Any other,
  missing or repeated caveat (a payee, a redeemer, a changed amount, period, start, token or expiry) is refused. Tests
  build grants with MetaMask's own `createErc20TokenPeriodicCaveats` / `createNativeTokenPeriodicCaveats`, so a
  disagreement between the two encoders fails there.
- The first-run simulation is the signature check: the DelegationManager validates the account's signature when it
  redeems.

### Cancel (`l`)

Unchanged: `executor.cancel(planId)` and `DelegationManager.disableDelegation(delegation)` from the wallet, which also
ends the MetaMask grant on-chain. Revoking it in MetaMask also stops every later run.

### Failures

| Case | Result |
|---|---|
| User rejects the permission (4001) | Step fails `USER_REJECTED`; nothing granted or registered |
| MetaMask refuses before prompting (4100, 4200, 5700, 5710, -32602) | Same, with "MetaMask refused this request before showing it" |
| Response differs from the request (adjusted amounts, other caveats, wrong delegate) | `409 PERMISSION_MISMATCH`; the request stays pending, the page asks the user to revoke that grant in MetaMask and review again |
| `dependencies` not empty | `409 PERMISSION_UNSUPPORTED_ACCOUNT`; the request stays pending |
| First-run simulation fails | Existing `SIMULATION_*` codes |
| `start_at` passes before registration | Existing rule: the step fails, no run is silently lost |

## Testing

- Unit: grant verification against contexts built with MetaMask's own `createErc20TokenPeriodicCaveats` and
  `createNativeTokenPeriodicCaveats`: accepts the exact request; rejects each wrong field, extra or missing caveat,
  wrong delegator or delegate, payee rule, dependencies.
- Unit: `redeemIdentity` accepts N identical contexts and rejects mixed ones.
- Chain (anvil, MetaMask's real framework): V4 registers and runs an ERC20 and an ETH grant built from MetaMask's
  caveats; a second run in the same period reverts; a run after expiry reverts; another account cannot register the
  grant; server-key N = 1 plans still run; cancel stops runs and disables the delegation.
- Live (Base Sepolia, MetaMask): deploy V4, create a plan through the agent, approve the permission, register, run
  one slot through local CRE, cancel.

## Out of scope

Payee-locked grants (one permission per payee), stream or allowance permission types, counterfactual accounts, and
migrating V3 plans.
