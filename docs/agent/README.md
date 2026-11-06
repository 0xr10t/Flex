# Received payments and identifier explanations

The session API answers these read-only questions without Ollama, payment pipeline steps, signing, or request-triggered network calls:

- “How many transactions did I receive this week?” (`recieve` is accepted too).
- “How much did my account receive this week?”
- “How much USDC did I receive on Base this week?”
- “Explain this hash: …” / “What is this: …”

Weekly history covers incoming ETH (external and internal contract transfers) and the configured USDC contract on the enabled testnets. The week begins Monday at 00:00 in the session timezone. Amounts are summed in integer base units and displayed separately per token. A transaction with multiple incoming transfers counts once per chain; failed transactions, zero-value transfers, self-transfers, other tokens, NFTs and staking rewards are excluded. Incoming bridge deliveries count as receipts, not income or profit. The response labels indexed data and its refresh time; it does not promise finality.

## Configure account history

Balance RPC calls and the outgoing spend log cannot enumerate incoming payments. Configure a trusted **Blockscout API v2** instance for each chain you want included:

```json
{
  "history": {
    "enabled": true,
    "sources": [
      { "chain_id": 84532, "api_url": "https://YOUR-BASE-SEPOLIA-BLOCKSCOUT/api/v2" }
    ]
  }
}
```

Replace the example host with your own instance or a provider you trust, bound to the indicated chain. The service makes account-indexer requests only to these configured bases. URLs in user messages never configure an indexer. HTTPS or an HTTP service on `127.0.0.1` is accepted; URL credentials, query strings and fragments are rejected. Omit `history` or set `enabled: false` to disable this network source. Existing configurations remain valid.

Production startup refreshes the previous eight days immediately, then on a jittered five-minute timer. `network.socks_proxy` applies, using a separate `history` isolation class and no direct fallback. The indexer sees the public wallet address, but not message text, amounts requested in chat, or unknown pasted identifiers. Cache entries stay in memory, are tied to one account, and are discarded on stop. A fresh full rescan replaces old entries, including reorganized transactions. No existing database migration is needed.

The adapter follows bounded pagination on the same endpoint, checks raw integer amounts, contract identity, parent transaction success and duplicate event identities, and rejects pending indexing, malformed pages, timeouts, repeated cursors and pagination limits. If any required feed fails, that chain is unavailable, rather than a fabricated zero. Responses explicitly mark subtotals when another enabled chain is missing. Cache entries older than 15 minutes cannot answer a weekly total. Indexer correctness and lag remain provider trust assumptions; this data never authorizes a payment.

The provider contract is described by [Blockscout's address-history API](https://github.com/blockscout/blockscout-api-v2-swagger/blob/main/swagger.yaml) and its [internal-transfer response](https://github.com/blockscout/blockscout/blob/master/apps/block_scout_web/lib/block_scout_web/views/api/v2/internal_transaction_view.ex). Ordinary JSON-RPC URLs are not Blockscout API bases.

## Unknown identifiers

A bare 32-byte hex value cannot be reliably distinguished as a private key, transaction hash, block hash or arbitrary digest. Explicit explanation requests return that uncertainty locally. A match against the account-history cache can identify a recorded transaction without sending the pasted value anywhere. No online lookup is attempted for an unknown value, even if the user calls it a “transaction hash.” Other local checks explain EVM addresses, extended/WIF keys, recovery phrases, keystores and signature/public-key-shaped values without claiming more than their format establishes.

The original secret detector still rejects secrets in payment requests. Explanations never echo the candidate, store it in chat/prompt history, or pass it to either model. Read-only questions preserve pending recipient questions, payment summaries and confirmation identities.

Custom frontends that construct `SessionManager` or `createApp` directly should pass a `history: HistoryReader` and run/stop the matching `HistoryCache` with the connected account's lifecycle, as `src/index.ts` does. A missing reader produces an explicit unavailable response.
