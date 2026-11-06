# CRE build and local simulation

Flex runs the actual compiled CRE workflow through the native CLI. Hosted DON access is not required; CLI authentication is still required. The local runner is read-only: it has no broadcast, deployment or signing option.

## Run from the repository root

```powershell
# Build and record source/WASM hashes.
npm.cmd run cre:build

# Build, then run native CRE provider qualification on all three testnets.
npm.cmd run cre:simulate

# Reuse the verified artifact; changed code or WASM requires rebuilding.
npm.cmd run cre:simulate -- --no-build

# Evaluate actual registered plans, once the executor configuration is complete.
npm.cmd run cre:run

# Repeat read-only evaluation every 30 seconds; Ctrl+C stops it.
npm.cmd run cre:watch

# Exercise two qualification cycles without leaving a background process.
node scripts/cre-local.mjs qualify --watch --iterations 2 --no-build
```

The direct receiver-free native command is:

```powershell
Set-Location wallet/cre
../../.local/bin/cre.exe workflow simulate autopay --target local-simulation --env ../../.env --non-interactive --trigger-index 0
```

The workflow path is relative to the CRE project directory. Do not repeat `wallet/cre` in that path after selecting it as the project.

## Agent and MetaMask integration

The agent's v2 recurring intent now reaches the MetaMask wallet runner. With an executor configured on that chain and an already upgraded account, the wallet shows the exact bounded recurring permission. The user signs it with `eth_signTypedData_v4`; the service verifies the signer and exact typed data. The pending request survives restart. Registration then requires a separate wallet transaction. Cancellation uses the existing atomic cancel-and-revoke batch. The server never gains a browser-wallet signing key.

Registering a plan does not pay recipients. Local CRE discovers finalized registrations through the executor events and simulates due runs. `GET /v1/cre/status` on the agent exposes sanitized local-runner status. `GET /v1/autopays/:id` joins a plan to its simulation observation using chain, executor and plan ID. Both routes require the agent UI bearer token. Observations expire after two minutes, contain no signed delegation, and never update payment history or activate a plan. Real execution reports retain their separate authentication and onchain event path.

From the repository root:

```powershell
npm.cmd run testnet:build
npm.cmd run testnet:setup
# Starts all three foreground processes; refuses ports already in use.
npm.cmd run testnet:start
# Before executors/plans exist, explicitly select provider qualification instead:
npm.cmd run testnet:start -- --qualify
```

Keep the protected `.env` values local. Setup preserves an existing agent network setting and copies it to the wallet. `FLEX_SOCKS_PROXY=direct` explicitly selects direct transport; a SOCKS URL selects Tor. Fresh setup otherwise retains the template's Tor default. Native CRE currently refuses Tor rather than bypassing it. The launcher checks matching wallet addresses, service URLs and token-file paths. It starts only MetaMask mode, stops its own children together, and never replaces a running service.

For registered-plan evaluation, supply actual executor deployments in `.local/deployments.json` and the matching receiver identity/forwarder settings in `.local/cre.config.json`. No deployment or recurring-payment execution is implied by starting the stack. Existing service processes must be restarted by their operator to load new compiled code.

## Workflow modes

`local-simulation` needs no executor, workflow identity or wallet signature. It obtains a recent block through real HTTP capabilities and exercises the normal `eth_simulateV1` comparison across configured providers. The block is checked before and after simulation. One chain runs per invocation to stay within CRE's HTTP budget; the wrapper runs all three. The empty zero-value probe qualifies infrastructure, not a payment, and returns `paymentExecuted: false`.

`dry-run` evaluates real registered plans. It discovers finalized registrations, selects due slots and simulates exact `onReport` calldata. A passing simulation returns `would_execute`. It never calls `runtime.report` or `writeReport`, including if someone manually appends `--broadcast` to its CLI invocation.

The existing explicitly configured `broadcast` workflow branch remains separate and requires successful write/receiver status plus a nonzero transaction hash. The local runner rejects this mode and all broadcast flags. It never turns dry-run output into an executed-payment record.

## Configuration

The protected root `.env` supplies read RPCs and simulation endpoint arrays through the existing secret references. No credentials are printed. HTTPS endpoints are supported; HTTP is permitted only on loopback for local-chain tests.

Local CRE capabilities do not inherit the wallet's Node SOCKS transport. The runner refuses a non-null wallet `network.socks_proxy` with `CRE_LOCAL_PROXY_UNSUPPORTED`, before making CLI or indexer requests. It does not silently bypass Tor. Direct provider qualification was verified with the existing direct setup; native CRE over a verified local Tor capability proxy is not implemented.

`wallet/cre/autopay/config.staging.json` now defaults to `mode: "dry-run"`. Its zero executor/identity fields intentionally fail validation: they are not working deployment values. `scripts/setup-testnet.mjs` uses this template for `.local/cre.config.json`.

Registered-plan mode needs actual executor addresses and deployment blocks, the forwarders trusted by those executors, and matching receiver metadata in `workflow.id`, `workflow.name` and `workflow.owner`. The executors and user-authorized plans must already exist. Do not copy the local integration test's identity into public-testnet configuration. Older generated configs also need the explicit `mode: "dry-run"` field.

Use `--config C:\path\to\config.json` to select another plan configuration. `CRE_CLI_PATH` can select an installed CLI; otherwise `.local/bin/cre.exe` is used. Browser login is sufficient; an API key is optional.

## Discovery and recovery

The host indexer scans from deployment in bounded pages. Explicit RPC range rejections shrink page size; outages never advance a checkpoint. Finalized checkpoint hashes are checked on resume and throughout scanning. A changed checkpoint causes replay from deployment. Historical active plans are retained.

A per-tick page budget limits work. Until discovery catches up, the runner reports `catching_up` and does not invoke CRE with incomplete history. CRE independently checks the checkpoint hash and refuses checkpoints above its finalized head. Discovery still trusts the configured read RPC for completeness; simulation agreement is not a state proof.

Ignored `.local/cre-runner/` holds `index.json`, `build.json`, `status.json`, and invocation configuration. Writes use protected temporary files and atomic rename. The index can contain signed delegation calldata and must stay private.

An exclusive loopback listener on port 8791 prevents overlapping runners. It accepts no commands. The OS releases it on exit or crash, so restart does not depend on unsafe stale-file cleanup. The wallet UI on 8788 is unaffected. Ctrl+C stops the CLI child and releases the lock.

CLI invocations have a timeout and output-size limit. The wrapper does not persist raw CLI/RPC output; failures use fixed codes. Watch mode records failures and retries on subsequent ticks. There is no automatic transaction retry.

## Verification

```powershell
npm.cmd --prefix wallet test -- cre/autopay/test test/unit/cre-local.test.ts
$env:FLEX_NATIVE_CRE = '1'
npm.cmd --prefix wallet run test:chain -- test/chain/cre-native.test.ts
Remove-Item Env:FLEX_NATIVE_CRE
```

The native integration test uses actual Anvil executor and MetaMask delegation contracts and public local-only test accounts. Its three RPC paths exercise comparison, not infrastructure independence. Public-testnet qualification uses the configured external providers.

CRE local execution remains a single process. Explicit RPC comparisons run for real; DON consensus is simulated. Qualification, registered-plan simulation, local-chain payment execution and public-testnet payment execution are distinct verification results.

Dependency audit: SDK 1.23.0 pins Zod 3.25.76. The npm audit reports GHSA-mrhx-c7xc-m3w5 (oversized constrained collections, fixed in Zod 4.6.6). The latest SDK still pins this version, and it uses Zod 3 function APIs removed in Zod 4. An unsupported override was not applied. Flex's new runtime config validation does not use Zod and bounds collection sizes; the upstream SDK advisory remains a release finding.

References: [native simulation and prebuilt WASM](https://docs.chain.link/cre/guides/operations/simulating-workflows), [simulation and production forwarders](https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts).
