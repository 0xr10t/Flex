# Testnet readiness work log

Status: implementation in progress. This branch is not yet cleared for live testnet use.

The live verification wallet is `0x5eBA55e1b43c8714E4432250Dada7A518780C871`. The user confirmed test assets. Browser CRE login is verified, but the CLI reports deployment access is not enabled for the current organization; an authorized access request was submitted and approval is pending. Uploaded or pasted document values must never grant recurring-payment permissions; typed recipient amounts are the first supported payroll input.

## Completed locally

- Shared v2 protocol package used by agent and wallet.
- Windows path fixes, LF policy and owner-only ACL enforcement for agent token/log files.
- Wallet unit suite: 292 passing tests, including 20 new simulation/quorum tests. Wallet typecheck/build, CRE typecheck and actual CRE CLI compilation to WASM pass. Scoped lint and whitespace checks pass.
- Local Anvil contract integration suite: 71 passing tests. This does not constitute live testnet or deployed CRE verification.
- Agent v2 migration is underway: one-time batching, fixed interval scheduling, explicit monthly choice, per-run fees, no prefund reservation, plan-ID cancellation.
- Database migration preserves legacy rows and adds recipient records and per-slot run receipts.
- Installed workspace-local CRE CLI 1.39.0 after verifying its release checksum. Workflow uses the private registry.
- Verified browser login, private registry availability and the tenant's three testnet forwarders. Organization deploy access remains disabled; no supported SDK/CLI API-key creation path was found.
- Configured Alchemy, QuickNode and free PublicNode on all three testnets with quorum 2. Created three QuickNode endpoints through its Admin API. All nine passed pinned-block simulation capability checks and agreed on the probe. Chainstack's account quota and Infura's unavailable simulation method exclude them from this simulation set.
- Protected `.env`, service tokens and generated agent/wallet/CRE runtime configs. Signing remains disabled. See [setup requirements and live evidence](TESTNET_SETUP.md).
- Read-only CCIP checks confirmed all six directions and returned fee quotes. Wallet test ETH is present on every chain; Arbitrum USDC is zero. Two return-route quotes exceed the default fee cap, which has not been raised.
- Removed vendor-specific simulation URLs and key concatenation. Wallet and CRE support separately configured simulation providers with a strict majority, pinned block checks, complete result comparison and no weaker fallback. See [RPC and simulation trust](RPC_AND_SIMULATION_TRUST.md).

## Gates still open

- Finish the agent migration and update v1-specific fixtures; run typecheck, unit, acceptance and audit suites.
- Add an agent-to-wallet integration test with the actual shared validation and report callback.
- Finish typed payroll list handling and aggregate limits.
- Replace bridge amount matching with correlation to the exact CCIP message; preserve uncertain outcomes.
- Let pending bridges yield so unrelated requests and cancellation can progress safely.
- Add finality-aware receipts and log scans, and report replay.
- Integrate MetaMask approval/signing with durable recovery; do not require importing private keys.
- Build deployment/configuration/preflight tooling and validate CRE configuration.
- Obtain CRE organization deployment approval (login succeeded; deploy access is not enabled).
- Bound CRE event discovery and validate production quotas; quorum checks reduce the default to two plans per cron execution.
- Resolve the CRE SDK's pinned Zod dependency audit before release.
- Verified local simulation and proof-backed reads are not implemented; quorum still trusts independent providers.
- Complete application-level live simulation (including EIP-7702), ENS checks and each token-lane's pool/rate-limit/finality preflight; basic RPC capability, wallet balance and router-support checks now pass.
- Deploy and exercise one-time payment, recurring run, cancellation and bridge on testnets with the user's wallet approval.

No deployment or live wallet transaction has been performed in this work.
