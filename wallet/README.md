# Flex wallet

The execution layer: it receives the agent's hand-off envelope, checks it, and will sign and send what the user approves.

**Current state:** payments (`i`), bridges (`j`), recurring registration (`k`) and cancellation (`l`) use the shared v2
agent handoff and MetaMask approval flow. Payment executors are deployed on Ethereum Sepolia, Base Sepolia and Arbitrum
Sepolia; their public addresses are in `cre/deployments.testnet.json`. Native CRE build-and-simulate broadcasting has
executed payments on local chains for all three chain IDs. A live recurring payment still requires a user-approved plan.
See the [root README](../README.md#cre-autopay-workflow-local-build-and-simulate) for setup and operator commands.

## Commands

Run these in this folder. It's a separate package with its own lockfile, on Node 22 or later.

```sh
npm install
npm test             # unit tests, no chain needed
npm run test:chain   # real contracts on local chains; needs Foundry (anvil, forge)
npm run typecheck
npm run build
npm start -- <path to config>
```

ESLint and Prettier run from the repo root: `npm run lint`.

## Before it can run for real

| Needed | Where |
| --- | --- |
| Config | Copy `config.example.json`. It holds paths and URLs, never keys or tokens |
| MetaMask | `approval.mode: "metamask"` uses only the public `wallet_address`; payment permissions and registrations are approved in the browser. No wallet signing key is loaded by the service |
| CRE transmitter | The native CLI consumes `CRE_ETH_PRIVATE_KEY` from the operator's protected `.env` for explicit `cre:broadcast` / `cre:autopay` commands. It needs test ETH for gas; read-only simulation needs no transmitter key |
| Executor | `chains[].executor`, once `IntentExecutorV3` is deployed. Autopay and cancel are refused on a chain without one |
| Approval | The testnet setup generates MetaMask mode. The generic default remains `reject_all`; `auto_approve_testnets` is reserved for local contract tests |

## Layout

| Path | Holds |
| --- | --- |
| `src/main.ts` | Starts the wallet: config, public MetaMask address and database encryption key from the OS keychain |
| `src/service.ts` | Wires everything together |
| `src/server/app.ts` | `POST /v1/intents`: credentials, checks, saving, and the reply |
| `src/store/store.ts` | The encrypted database: requests, each step's state, and waiting reports |
| `src/runner/runner.ts` | Runs steps in order, and picks up after a crash |
| `src/runner/reports.ts` | Sends results to the agent, and retries |
| `src/guard/` | The decoder, and the check that must pass before anything is signed |
| `src/approval.ts` | Where a real approval screen plugs in |
| `src/chain/account.ts`, `gateway.ts` | The 7702 upgrade, and every call to a chain |
| `src/runner/handler.ts` | What each intent type plugs into the runner |
| `src/payments/payment-i.ts` | `i`: one batch, and a check that the money moved |
| `src/bridge/bridge-j.ts` | `j`: exact fee, exact approval, and a wait for arrival |
| `src/autopay/autopay-k.ts`, `delegation.ts` | `k`: signs the permission, and registers it |
| `src/autopay/cancel-l.ts` | `l`: stops the plan, and disables the permission |
| `src/autopay/watcher.ts` | Watches the chain, and reports each paid run to the agent |
| `contracts/` | `IntentExecutorV3` and test stand-ins |
| `cre/autopay/` | The shared cron workflow. `lib/due.ts` holds its decisions |
| `../packages/protocol/` | `@flex/protocol`, shared with the agent: the envelope schema (the contract between agent and wallet), the verified `intent.v2` and `bridge.v2` schemas, and `checkEnvelope`, which turns an envelope into the verified plan and runs all the checks |
| `src/chain/redeem.v2.ts` | Encodes a delegation redeem, for autopays |
| `test/unit/` | No chain needed. Includes simulated crashes, and the agent's real client against this service |
| `test/chain/` | Local anvil chains with MetaMask's real contracts. Includes `kill -9` of the real process with a payment in flight |

## How a payment stays safe

Before anything is signed, the decoder (`src/guard/decode.ts`) reads the raw bytes while `eth_simulateV1` runs them. The intent and both results must match, or the step stops. If simulation isn't available, the step stops too.

1. **Saved first.** The envelope is saved before the wallet replies, so a retry from the agent can't start it twice.
2. **Signed, then saved, then sent.** The signed transaction goes to disk before it reaches the network. After a crash the wallet repeats
   that exact transaction, which the chain can only accept once.
3. **Checked afterwards.** Success means the expected transfers happened, not just that the transaction went through.
4. **Reported reliably.** A result and its report are saved together, and the report is retried until the agent answers.

## How an envelope is checked

| Stage | What it checks | Example failure |
| --- | --- | --- |
| `schema` | Shape, formats and size limits | A missing field, or 51 recipients on a `k` |
| `consistency` | Fields in the envelope agree with each other | `base_units` doesn't match `value` |
| `plan` | Payment rules, after mapping to the verified plan | A bridge landing on the wrong chain |

Rejection messages contain no amounts or addresses, because the agent shows them to the user.
