# Testnet setup: CRE, RPCs and CCIP

Checked 6 November 2026. This is a setup checklist, not a declaration of live readiness.

## CRE account status

- Browser login completed and `cre whoami` succeeded.
- The private registry is available to the current organization.
- The tenant chain list includes Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia. Their production forwarder addresses match the tracked workflow template.
- `cre whoami` reports **Deploy Access: Not enabled**. An access request was submitted with the user's authorization; Chainlink approval is pending. Login, registry availability and deployment approval are separate states.
- The local credential file has owner-only permissions. Do not commit it or copy its contents into chat.

API-key troubleshooting: CLI 1.39.0 has no key-creation command. The CRE workflow SDK exposes workflow capabilities, not organization key administration. Official documentation describes key creation in **Org settings > API Keys > Create API Key** and requires an eligible Platform role. API-key authentication also requires deployment approval. No supported SDK/CLI key-creation alternative was found; no CRE API key was created. The disabled website button is not confirmed to be a UI bug. Existing browser login remains sufficient for the private-registry path once approval is granted.

Sources: [Authentication](https://docs.chain.link/cre/guides/cli/managing-auth), [API-key roles and creation](https://docs.chain.link/chainlink-platform/api-keys), [SDK scope](https://docs.chain.link/cre/reference/sdk/overview-ts).

Local build and simulation can continue while access is pending. Private registry management needs no mainnet gas or linked wallet key. The application still needs executor deployments, workflow identity, configured secrets and quota-safe event discovery before running on a DON.

Sources: [Deploy access](https://docs.chain.link/cre/guides/operations/deploy-access), [Private versus onchain registry](https://docs.chain.link/cre/guides/operations/deploying-workflows).

## Verified provider setup

The protected local configuration now uses **Alchemy + QuickNode + PublicNode, quorum 2**, on each chain. Alchemy URLs were constructed from the user's local key; three QuickNode endpoints were created using its documented Admin API. PublicNode requires no account or key. All nine endpoints passed the capability probe, and all three providers produced identical canonical results at the same pinned block on each chain. Read RPCs currently use Alchemy. No private credential or authenticated URL belongs in this document.

| Network | Chain ID | Provider 1 | Provider 2 | Provider 3 |
| --- | --- | --- | --- | --- |
| Ethereum Sepolia | 11155111 | Alchemy | QuickNode | `https://ethereum-sepolia-rpc.publicnode.com` |
| Base Sepolia | 84532 | Alchemy | QuickNode | `https://base-sepolia-rpc.publicnode.com` |
| Arbitrum Sepolia | 421614 | Alchemy | QuickNode | `https://arbitrum-sepolia-rpc.publicnode.com` |

Official endpoint/network sources: [Alchemy](https://www.alchemy.com/docs/reference/node-supported-chains), [QuickNode](https://www.quicknode.com/docs/platform/supported-chains-node-types), [PublicNode](https://publicnode.com/).

The probe checks chain ID, a recent pinned parent before/after simulation, JSON-RPC batching, `eth_simulateV1`, native transfer tracing, successful calls, code/storage/balance overrides and an observed timestamp override. Canonical gas, status and logs are compared across providers. This is capability qualification, not proof that every application transaction, EIP-7702 case, DON execution or future request will succeed. Public endpoints can throttle; runtime quorum must continue to fail closed. Different provider names also do not cryptographically prove independent infrastructure.

Other providers tested: the corrected Chainstack Platform credential authenticates, but node creation returns `403 quota_exceeded`; the existing node was left intact. Infura responds to chain/block reads on all three testnets, but `eth_simulateV1` returns `-32601` both in batches and single requests. Neither is included in the active simulation set.

The discovery helper uses keys without printing them, rejects redirects, only accepts the expected provider domains, preserves existing explicit settings, and never creates provider infrastructure. To discover and recheck the selected endpoints after building the packages:

```powershell
node scripts/configure-rpc-providers.mjs --third-provider=publicnode
node scripts/setup-testnet.mjs
```

Both commands ran successfully. Protected agent, wallet and CRE configs exist in `.local`; wallet config now selects browser MetaMask approval using only the public address. The discovery helper fills empty settings only; changing an existing provider selection requires an explicit configuration edit. See [the browser workflow and live evidence](METAMASK_TESTNET.md).

The documented Alchemy URL formats are:

```text
https://eth-sepolia.g.alchemy.com/v2/<API_KEY>
https://base-sepolia.g.alchemy.com/v2/<API_KEY>
https://arb-sepolia.g.alchemy.com/v2/<API_KEY>
```

QuickNode and Chainstack issue endpoint URLs through their dashboards. Copy those full URLs, including their access path, rather than guessing a hostname. Keep credentials in the protected root `.env`.

For each prefix (`SEPOLIA`, `BASE_SEPOLIA`, `ARBITRUM_SEPOLIA`):

```dotenv
SEPOLIA_RPC_URL=<one working read/broadcast endpoint>
SEPOLIA_SIMULATION_RPC_URLS=["<Alchemy endpoint>","<QuickNode endpoint>","https://ethereum-sepolia-rpc.publicnode.com"]
SEPOLIA_SIMULATION_QUORUM=2
```

The lines above are a format illustration, not usable endpoint values. The same Alchemy URL can serve both the read endpoint and one simulation slot. The other simulation slots must be independent operators.

Before using an endpoint, verify its chain ID and the full application workload: `eth_simulateV1` at a pinned recent block, multiple consecutive simulated blocks, state/code overrides including EIP-7702, time overrides, native transfer tracing, complete logs and JSON-RPC batch responses for CRE. Compare identical inputs at one block across providers. A successful `eth_chainId` or `eth_call` alone is insufficient. CRE must be able to reach the HTTPS endpoint; a local-only URL or browser-origin restriction will not work from DON nodes.

## CCIP requirements for this application

The configured bridge sends native USDC, with no arbitrary message data, to the user's own address. It pays the quoted CCIP fee in native ETH. It does not bridge native ETH. This flow does not require a CRE account, a user-operated CCIP node or a separate custom CCIP receiver contract.

### Infrastructure and assets

1. Working source and destination read RPCs and a working source simulation quorum.
2. The correct Circle-issued test USDC on the source, plus enough source ETH for approval/account setup, transaction gas and the fresh CCIP fee quote. Have destination ETH for subsequent wallet transactions; ordinary delivery is covered by the CCIP fee. LINK is not needed by this branch's native-fee configuration.
3. A wallet able to approve the actual source transaction. Browser MetaMask signing/recovery is implemented and has been exercised on Ethereum Sepolia → Base Sepolia. CRE login does not supply a wallet signer.
4. Current router, selector, USDC and token-pool configurations. Verify each direction of each intended route, including rate limits, route status, CCIP version, verifier requirements and finality policy. Network presence alone does not establish token-route readiness.
5. Quotas and availability sufficient for receipt/log polling, retries and simulation. One provider outage should not corrupt state or trigger another bridge send.

The current directory lists USDC on all three networks and outbound lanes among them. Router and selector listings agree with the tracked constants. The listed lanes are CCIP 2.0; token pool versions differ, so compatibility must be checked per route. The branch's legacy GenericExtraArgsV2 remains accepted on 2.0 lanes according to current docs, but its out-of-order flag is no longer honored. New configuration should use a tested version-aware encoding and finalized delivery by default.

Sources: [Ethereum Sepolia](https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia), [Base Sepolia](https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-base-1), [Arbitrum Sepolia](https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-arbitrum-1), [USDC directory](https://docs.chain.link/ccip/directory/testnet/token/USDC), [USDC/CCTP transfer guide](https://docs.chain.link/ccip/tutorials/evm/usdc), [extraArgs compatibility](https://docs.chain.link/ccip/evm/tutorials/application-developers/manual-execution).

### Required application fixes and evidence

- Implemented: `isChainSupported` and version checks before quoting/sending, persistence of the exact message/ramps/selectors/tokens/amount/receiver, and source-transaction recovery without a replacement send.
- Implemented: exact destination message and USDC delivery verification, provisional delivery display, canonical finalized completion and dependent-payment gating.
- Implemented: recoverable delayed/unknown/failed destination states, nonblocking bridge polling, durable browser batch IDs, and log scanning that adapts to explicit provider range limits.
- Exercise all six directed routes with small test amounts if the product enables every pair. Include provider outage, process restart, delayed arrival, duplicate observation and fee-cap rejection tests. Local simulated delivery does not replace this evidence.

CCIP is asynchronous. Finality, verifier/Circle availability, rate limits and destination execution can delay delivery. Reliable operation means preserving funds and state through those delays and offering recovery; it cannot guarantee an instantaneous or failure-free bridge.

The initial wallet snapshot on 6 November showed test ETH on all three networks and zero USDC on Arbitrum Sepolia. Balances and quotes change as tests run. Funding Arbitrum USDC or receiving a test bridge there precedes outbound USDC testing. The user authorized raising the fee ceiling to 0.003 test ETH. Requote each actual message; network gas is additional. The first 0.02 USDC Sepolia → Base transfer delivered with a quoted CCIP fee of 0.000228667847801883 test ETH; destination finality is tracked separately.

Sources: [Service responsibilities](https://docs.chain.link/ccip/concepts/service-responsibility), [Fees and billing](https://docs.chain.link/ccip/concepts/fees-and-billing).

## CRE implementation gates

The code builds to WASM, but the native CRE workflow has not yet passed simulation or run on a DON. Before the private-registry workflow is published:

1. Validate all configuration and deploy the application executor on each intended testnet. Bind the correct forwarder and private-registry organization owner. Resolve workflow identity without assuming that a configured ID survives rebuilding/changing configuration.
2. Replace the deployment-to-head log scan in `autopay/main.ts:51` with bounded discovery that preserves older active plans and respects the log-range and capability quotas.
3. Run native CRE simulation with real runtime configuration. Zero transaction-hash fallback removal, write-result validation and SDK-compatible encoding are implemented and unit-tested.
4. Validate runtime quotas after the implemented batching/concurrency changes: independent log handles, batched secrets and concurrent provider reads now avoid unnecessary serial waiting. Keep same-account writes serialized.
5. Extend the existing actual-handler tests with live simulation evidence and resolve the pinned SDK dependency audit gate.

After real runtime configuration and executor addresses exist, the non-broadcast native simulation command from the repository root is:

```powershell
.\.local\bin\cre.exe workflow simulate wallet/cre/autopay --project-root wallet/cre --env .env --target staging-settings --non-interactive --trigger-index 0
```

This command is documented, not reported as passed. Only after simulation passes and Chainlink grants organization access should Vault secrets be configured through the browser-authenticated CLI and the private-registry workflow be published and verified end to end. Browser login is sufficient; a CRE API key is optional. User-approved CCIP transactions have occurred independently of CRE; no workflow has been published.
