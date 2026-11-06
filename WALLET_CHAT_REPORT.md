# Wallet-aware conversation — SQ-CHAT-02

The agent answers ordinary messages through the local conversational model and knows the configured public wallet
address. Read-only wallet questions refresh balances and select relevant verified facts: balance and spendable
amounts by network/token, pending spending, gas reserves and totals. This extends the existing SQ-CHAT-01 chat route;
the payment extraction prompts and financial validators are unchanged.

Wallet facts use the same bigint accounting as the planner. Unavailable chains have null values; readable-network
subtotals are labelled incomplete. The address remains available when balance reads fail. The model selects fact
IDs and their order, while code renders their complete sentences. The independent review caught that free-form
framing could contradict correct facts; wallet replies now reject additional prose fields. General conversation
continues to use model-written prose.

Wallet-information reads use a disposable S0 context. They update DB4 without replacing an active question, consuming
an answer attempt, modifying a summary, changing failed-payment correction context, or mutating a submitted envelope.
Chat history is bounded in session memory. No new chat persistence, credentials, contact inventory, execution tools,
or value-bearing application logs are introduced.

## Verification

- Independent review: 21 unit and 13 HTTP tests, including exact precision, stale/unavailable rows, partial totals,
  grounded output, pending state, failed-payment corrections, immutable retries, privacy and close/busy concurrency.
- Full deterministic run: 2,312 tests in 79 files passed. The additional comparison regression added afterward
  passed in the 13-case HTTP rerun; it confirms a pre-existing amount-span stop in both chat modes.
- Separate security audit: 205 checks passed. Typecheck, lint and production build passed.
- Ignored test frontend harness: 13 checks passed, including access control, session isolation and local-only capture.
- Real-model and browser evidence is retained under the ignored `test_frontend/runtime/` directory. The initial
  run passed all three new wallet/conversation scenarios; the existing native extraction limitation below stopped
  its combined request. The final four-scenario run passes, including successful model-written greeting/explanation
  assertions and normal combined request wording. The real Chromium round trip passes for a greeting, configured
  wallet address and Base 30 + Arbitrum 60 = 90 USDC, with zero intents, submissions or persisted prompts.

The updated local UI is **http://127.0.0.1:8893/**. It uses the approved Qwen3 chat profile and keeps capability
cookies separate by port. Existing demos were left running. Final live evidence is
`test_frontend/runtime/wallet-chat-live.json`; browser evidence is `test_frontend/runtime/wallet-chat-browser.png`.

## Existing model limitation observed

For `What is my balance, and send 10 USDC to Mihir on Base.`, Qwen3 returned the amount phrase `send 10 USDC`.
The native S3 verifier rejects that span with `S3_AMOUNT_SPAN_UNVERIFIED` / `UNSUPPORTED_REQUEST`. The new chat router
correctly selected the wallet workflow and forwarded the whole original message unchanged. The independent fixture
comparison confirms the identical stop with chat disabled. No later model calls, placeholders, reservations or
submission occur; confirmation returns 409. This change does not relax that guard or claim to fix the underlying
amount-extraction issue. Initial live evidence remains in `test_frontend/runtime/wallet-chat-initial.json`.

The testing frontend uses sample balances and a capture-only executor. Production wallet facts instead use the
configured wallet and RPC clients. `test_frontend/` stays ignored and untracked.
