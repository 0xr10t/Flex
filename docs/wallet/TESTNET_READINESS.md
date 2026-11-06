# Testnet readiness work log

Status: implementation in progress. A user-approved CCIP transfer has delivered on testnet; all-layer readiness is not complete. See [MetaMask execution and live evidence](METAMASK_TESTNET.md).

The live verification wallet is `0x5eBA55e1b43c8714E4432250Dada7A518780C871`. The user confirmed test assets. Browser CRE login works; the user reports that Chainlink denied hosted deployment access. CRE now has an implemented build-and-simulate operating path that does not require DON access. Uploaded or pasted document values must never grant recurring-payment permissions; typed recipient amounts are the first supported payroll input.

## Completed locally

- Shared v2 protocol package used by agent and wallet.
- Windows path fixes, LF policy and owner-only ACL enforcement for agent token/log files.
- Full wallet suite passed 333 unit tests and 75 local chain tests before the latest browser refinements. Follow-up checks passed 10 browser unit tests, 4 log-scanner unit tests, 2 browser chain tests and 10 CCIP chain tests. CRE WASM compilation and native provider qualification passed on all three testnets. A native CRE/local-Anvil test verified a registered payment as `would_execute`, unchanged balances during dry-run, and a paid-slot skip after actual local execution. See [CRE local mode](CRE_LOCAL_SIMULATION.md).
- Agent v2 migration is underway: one-time batching, fixed interval scheduling, explicit monthly choice, per-run fees, no prefund reservation, plan-ID cancellation.
- Database migration preserves legacy rows and adds recipient records and per-slot run receipts.
- Installed workspace-local CRE CLI 1.39.0 after verifying its release checksum. Workflow uses the private registry.
- Verified browser login, private registry availability and the tenant's three testnet forwarders. Organization deploy access remains disabled; no supported SDK/CLI API-key creation path was found.
- Configured Alchemy, QuickNode and free PublicNode on all three testnets with quorum 2. Created three QuickNode endpoints through its Admin API. All nine passed pinned-block simulation capability checks and agreed on the probe. Chainstack's account quota and Infura's unavailable simulation method exclude them from this simulation set.
- Protected `.env`, service tokens and generated agent/wallet/CRE runtime configs. Browser MetaMask approval is implemented; the service uses only the public address in this mode and never loads a wallet signing key. See [setup requirements and live evidence](TESTNET_SETUP.md).
- All six CCIP directions passed route/quote checks. Application simulation passed four routes originating on Sepolia and Base; Arbitrum outbound checks need USDC funding. The user approved a 0.003 test ETH fee ceiling. A 0.02 USDC Sepolia → Base transfer delivered; its destination finality remains pending. A subsequent 0.002 USDC transfer on the same lane was automatically captured through MetaMask's generated batch ID.
- Exact CCIP 2.0 message correlation, durable browser recovery, finality checks, delayed/failed destination recovery and nonblocking bridge polling are implemented. The UI distinguishes observed delivery from finalized completion, and log scans adapt to provider range limits.
- Removed vendor-specific simulation URLs and key concatenation. Wallet and CRE support separately configured simulation providers with a strict majority, pinned block checks, complete result comparison and no weaker fallback. See [RPC and simulation trust](RPC_AND_SIMULATION_TRUST.md).
- Added explicit no-write CRE modes, validated configuration, bounded finalized plan indexing with restart/reorg recovery, a build-once runner, artifact verification, exclusive execution, persistent status and a repeatable local scheduler. The runner has no broadcast option.

## Gates still open

- Finish the agent migration and update v1-specific fixtures; run typecheck, unit, acceptance and audit suites.
- Add an agent-to-wallet integration test with the actual shared validation and report callback.
- Finish typed payroll list handling and aggregate limits.
- Complete report replay and the remaining agent/wallet callback integration.
- Extend browser approval to recurring permissions and cancellation. These requests are refused in browser mode today.
- Complete executor deployment/configuration and CRE runtime configuration. Local setup and CCIP preflight tools are implemented.
- Hosted DON deployment remains unavailable; it is not required for the implemented local build/simulate path.
- Validate production DON quotas if hosted execution becomes available. The local path uses bounded indexing and caps payment simulations at two per invocation.
- Resolve the CRE SDK's pinned Zod dependency audit before release.
- Verified local simulation and proof-backed reads are not implemented; quorum still trusts independent providers.
- Complete live delivery coverage for the other five CCIP directions, plus finalized completion, provider failures and operational quotas. Three 0.02 USDC route cards have been prepared for the user's review; do not count drafts as sent.
- Exercise the remaining one-time/recurring/cancellation flows end to end with user-controlled wallet approval. Agent test migration still has compile/test failures.

No CRE workflow has been published and no public-testnet recurring payment is claimed as executed. Native local tests use public Anvil accounts only. The user signed the live CCIP transactions in MetaMask; the agent did not sign or broadcast them.
