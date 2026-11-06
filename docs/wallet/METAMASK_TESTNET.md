# MetaMask testnet execution

The local wallet can prepare atomic USDC CCIP transfers and request approval in MetaMask. It uses only the public wallet address; browser mode never reads the signing-key entry in the OS keychain. Database encryption still uses its separate OS keychain entry.

From the repository root:

```powershell
npm.cmd --prefix wallet run build
node scripts/setup-testnet.mjs
node scripts/preflight-ccip.mjs
node wallet/dist/src/main.js .local/wallet.config.json
```

Open `http://127.0.0.1:8788` in the browser with MetaMask. Connect the configured account, choose the two testnets, enter an amount, and check the transfer. Review the prepared amount, exact USDC approval, quoted CCIP fee and any account upgrade in MetaMask. Pay network gas in test ETH. The application requests atomic execution and does not fall back to separate approval/send transactions.

The protected setup uses Alchemy, QuickNode and PublicNode simulation endpoints, requiring matching results from two of the three at the same block. Ordinary chain reads use the configured read RPC. This is provider redundancy, not a cryptographic proof of chain state. The CCIP fee ceiling is 0.003 test ETH per transfer; network gas is additional.

Log scanning adapts to a provider's explicit block-range limit, including the 10-block limit observed on the configured Alchemy plan. It keeps contiguous coverage and remembers the limit for subsequent scans. Authentication failures, rate limits and outages are retried normally rather than mistaken for a range limit.

Each request gets a durable application ID before the wallet prompt. MetaMask can return its own batch ID, which is saved alongside it for status queries. An uncertain wallet submission stays pending across restarts. It cannot be dispatched again, even if the wallet ignores the supplied application ID. If MetaMask confirms but the app cannot retrieve its batch status, use the existing card's **Recover by hash** with the source transaction hash. The server verifies the actual sender, recipient, calldata, nonce, block and account implementation before accepting it. Do not create a replacement transfer to repair tracking.

Delivery is checked against the exact CCIP 2.0 message, canonical finalized receipts and destination USDC transfer. The UI distinguishes an observed destination transfer from finalized completion: it can show **delivered, waiting for finality**, but dependent payments and success reports still wait for finality. An unfinalized observation that disappears after a reorg is withdrawn. Source confirmation alone is not delivery. A delay or failed destination execution remains tracked without resending source funds.

## Verified on 6 November 2026

- 333 wallet unit tests and 75 local chain tests passed, including browser recovery after restart and exact finalized delivery. The wallet build and typecheck passed.
- Live read-only preflight for 0.1 USDC passed all four routes originating on Ethereum Sepolia and Base Sepolia. The configured account had zero USDC on Arbitrum Sepolia, so both outbound Arbitrum simulations reverted.
- The user submitted 0.02 USDC from Ethereum Sepolia to Base Sepolia. Source transaction: `0xa01a7df8a37bcf487dcbf86780bb5b8bc302a2c4fe2acc29af6cca40622b4879`. Its exact atomic calldata passed independent verification and was recovered into tracking.
- CCIP message: `0xf148ce641bed66961bb8fa30c2644cdc53896a480a1862d055738a3c3b7f72bf`. Destination execution succeeded in transaction `0x7b87e547c3b17e62d5fc270bff37257ff87e4d132c9eb6d40381dd8c714915f0`, Base Sepolia block 55324000. Its receipt contains the expected 0.020000 USDC transfer to the configured account. Source finality was verified; destination finality was still pending at this checkpoint.

## Remaining limits

Real delivery has been observed on Ethereum Sepolia → Base Sepolia. The other five directions still need live delivery tests, and finalized completion of this first transfer remains pending. Fund Arbitrum Sepolia with Circle test USDC before testing its outbound routes. The current browser transport supports direct MetaMask EIP-7702 batch transactions from the configured account to itself; different account implementations, relayed wrappers or gas-payment calls are not accepted as equivalent.

Browser mode supports immediate payments and CCIP transfers. Recurring-payment creation and cancellation still need browser typed-data/transaction support and a configured executor, so intake rejects those requests in this mode. The existing local signing mode remains separate. CRE deployment access does not gate CCIP; CRE build/simulation and executor setup are separate work.

For a single-recipient payment, MetaMask sends one call directly. The app supplies the checked batch wrapper as that call. This requires the account's MetaMask smart-account upgrade to already be active on that chain; otherwise the request stops with `BROWSER_ACCOUNT_UPGRADE_REQUIRED` before any wallet prompt. A multi-call CCIP approval/send can request the upgrade through MetaMask.

This skill never signs or sends. You must sign and broadcast from your own wallet.
