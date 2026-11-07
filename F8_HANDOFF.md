# Handoff: F8, recurring payments through MetaMask permissions

Written 2026-11-07 for the next agent. Read `F8_RECURRING_PERMISSIONS.md` (the spec, updated with what was built)
first. Delete both files when the branch merges.

## 1. Where things stand

Branch `f8-erc7715-recurring-permissions` (local only, **not pushed**), based on `d442909` (master).

| Commit | What |
|---|---|
| `f0d320a` | Spec |
| `25727cb` | Redeem helpers accept N single-mode entries sharing one context (`permissionRedeem`, `redeemIdentity`, `decodeRedeemBatch`, `delegationFromRedeem`) |
| `0d60436` | `wallet/src/autopay/permission.ts`: `permissionRequestFor`, `verifyGrant`; test helper `wallet/test/support/grant.ts` builds grants with MetaMask's own caveat code |
| `cd92738` | `IntentExecutorV3.sol` renamed to `IntentExecutorV4.sol`; `register` accepts N ≥ 1 byte-identical contexts |
| `fff0c18` | Browser flow: `browser/delegation.ts` (permission store), controller (`envFor` dep), routes (`/browser/delegation` takes `{id, response}`), runner (`ctx.grantPermission`), `autopay-k.ts`, `ui.js` (calls `wallet_requestExecutionPermissions`) |
| `096063b` | Unused import |
| `6f58107` | README and spec updates; `wallet/cre/deployments.testnet.json` emptied (the V3 executors can't redeem a permission) |

Tests all pass: wallet unit 439, wallet chain 84 (4 opt-in skipped), root 2834, typecheck and lint clean.

Decisions made while building (all in the spec):
- No `redeemer` rule. The permission is delegated to the executor, which is the only account that can redeem it.
- `verifyGrant` compares MetaMask's caveats exactly against kit-built ones, plus one Nonce caveat of any value.
- A grant that differs from the request returns `409 PERMISSION_MISMATCH` and **stays pending**. The page tells the
  user to revoke the grant in MetaMask and review it again.
- Server-key mode (N = 1, signed exact batch) is unchanged.

## 2. What is left

1. **README address table** (`README.md` lines ~52-60, "Deployed contracts") still lists the three V3 addresses.
   Replace them with the V4 address on Base Sepolia (below) or drop the rows.
2. **Architecture diagram** (`assets/architecture.excalidraw` and `.png`) still says `IntentExecutorV3`. Change both
   together, or leave both. Editing only the source makes it disagree with the PNG.
3. **Live test on Base Sepolia** (spec, Testing section). Never completed; see section 4.
4. **Deploy V4 on Ethereum Sepolia and Arbitrum Sepolia** through `npm run testnet:onboard` → "Deploy payment
   executor". Arbitrum needs test ETH and the smart-account upgrade first. Then decide with the user whether to commit
   the V4 addresses into `wallet/cre/deployments.testnet.json`, using the same shape as the old entries: `address`,
   `deployment_block`, `transaction_hash`, `forwarder`.
5. Push or open a PR only when the user asks.

## 3. Live environment (shared machine state)

- **V4 executor on Base Sepolia:** `0x6ccd98da9dccfa9e5a9fa941539f8fe6d930fd5b`.
  - Deploy tx: `0x5f199f61e2aa839cc2ba91955677304be3265f9bfbaf824084e180793ef10c6f`, block 55450499.
  - Recorded in `.local/deployments.json`, `.local/wallet.config.json` and `.local/cre.config.json`.
- **`.local/wallet.config.json`:** the V3 executors were removed from all 3 chains. Ethereum and Arbitrum Sepolia have no
  executor, so autopay on those chains fails with `NOT_DEPLOYED` until V4 is deployed there.
  - Backup of the old file: `/tmp/claude-1000/-home-akronim26-Desktop-Skills-Blockchain-Flex/e0a9ea7f-38f2-4138-b293-5d7ffbb180b1/scratchpad/wallet.config.v3.json`
- **Running processes** (started by the previous session; stop them by PID if you need to restart):
  - `:8787` agent, pid 1980715, root `dist/`. Another session rebuilt the root `dist/` at 05:25, so run
    `npm run build` before you restart it.
  - `:8788` wallet, pid 2094475, `node wallet/dist/src/main.js .local/wallet.config.json`. Built from this branch.
  - `:8792` onboarding, pid 2090058, `npm run testnet:onboard`.
- The wallet serves `ui.js` as cached at startup. After editing `ui.js`, run `npm --prefix wallet run build` and restart
  the wallet.

## 4. Running the live test

1. **Create the plan through the agent API.** The bearer token is in `.local/ui_token`; never print it.
   - `POST /v1/sessions {"timezone":"Asia/Kolkata"}`
   - `POST /v1/sessions/:id/messages {"text": ...}`
   - `POST .../answers {question_id, chip_id}`
   - `POST .../confirm {request_id, decision:"yes"}`
2. **Phrase the request carefully.** The late window is 3600 s, so the interval must be at least 1 hour.
   - The agent read "every hour for 2 hours" as one daily payment. That is a separate agent bug, not F8.
   - "send 0.1 usdc to 0x…dEaD on base sepolia hourly, 2 payments in total, the first one 20 minutes from now" got a
     `Q_RECURRING` question.
   - Session `ses_1d48992d0196`, request `req_4a6c8ea306f6` is stale, with question `q_27cbcc50c594` unanswered. Start
     a fresh session.
3. **Approve on the wallet page** at `http://127.0.0.1:8788/#approve=<request_id>`. It calls
   `wallet_requestExecutionPermissions`, and MetaMask shows a "Token subscription request".
   - MetaMask confirmations appear in its **side panel**, which the chrome-live MCP cannot see. The user approves
     there. Never handle the MetaMask password or keys.
   - Then approve the `register` transaction, which goes through `wallet_sendCalls`.
4. **Check the plan is active:**
   - `store.autopayByStep` shows status `active`.
   - The `Registered` event on the executor carries N entries with one context.
5. **Run one slot through local CRE at `start_at`.** Use `npm run cre:broadcast` (one run) or `npm run cre:autopay`
   (watch); both are in `scripts/cre-local.mjs`. Check that the payee and the fee collector are paid.
   - Don't use `npm run testnet:start`: it starts the agent and wallet too and would clash with the running ports.
6. **Cancel through the agent** ("stop paying …"). Approve the cancel batch: `executor.cancel` plus
   `DelegationManager.disableDelegation`. Check that the next slot does not pay.

Gotchas:
- The onboarding page re-renders on a poll, so snapshot uids go stale. Click through `evaluate_script` instead.
- Base Sepolia had about 0.0199 test ETH before the deploy. Check USDC on Base too: a run costs about 0.15 USDC.

## 5. Coordination and rules

- **Peer session `flex-03`** works in the worktree `.claude/worktrees/install-fixes`, branch `worktree-install-fixes`.
  - It touches `README.md` (the same edits this branch has), `CLI_HANDOFF.md`, `src/cli/main.ts`, `install.sh` and
    install tests. Nothing under `wallet/`, and nothing in the services or `.local`.
  - The uncommitted `CLI_HANDOFF.md` edit in the main checkout is theirs and they redid it on their branch, so it can
    be discarded.
- **User rules:**
  - Commit and push only when asked. Commit messages end with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
  - Don't spawn subagents unless asked. Never paste secrets into chat.
- **To tell the user later:** after F5, the upstream single-recipient account-upgrade pause in the runner is no longer
  needed. It was left in place.
