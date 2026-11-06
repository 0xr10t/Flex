# Developing the agent layer

This TypeScript service accepts wallet requests over a local HTTP API and hands confirmed plans to a separate execution service. `README.md` is the specification; human-approved changes are recorded in `SPEC_QUESTIONS.md`.

## Install and check

Use Node.js 22.12.0+ on the 22.x line, or Node 24.0.0+; this matches the supported ranges of the development tools. The verified environment is macOS arm64 with Node 25.9.0 and npm 11.12.1, as approved in SQ-11. No separate Node 22 runtime was installed or tested in this remediation run.

```sh
cd /Users/phantomxsd/Flex
npm ci
npm run typecheck
npm run lint
npm run build
```

Run `npm ci` in each fresh checkout or worktree. `better-sqlite3-multiple-ciphers` and `@napi-rs/keyring` use native bindings, so install dependencies on the machine and architecture where they will run. The database driver supplies SQLCipher support; plain system SQLite is not a replacement. Reinstall dependencies after changing the runtime or platform if a native binding fails to load.

## Local model and configuration

Start Ollama with `ollama serve` if it is not already running. In another terminal:

```sh
ollama pull qwen2.5:7b-instruct
ollama pull qwen3:8b
curl --fail --silent http://127.0.0.1:11434/api/tags
```

The hackathon model selected in SQ-M-02 is `qwen2.5:7b-instruct` from `config.example.json`, with temperature `0`,
seed `42`, context `8192`, and timeout `60000` milliseconds. The optional `llm.think` field may be omitted for this
profile. SQ-M-03 enables thinking for chat using a separate model:
`chat: { "enabled": true, "think": true, "model": "qwen3:8b" }`, as in the local demo. Qwen2.5 handles intent
routing, follow-ups and wallet extraction; Qwen3 handles chat and wallet-information replies. Qwen2.5 rejects
Ollama's `think: true` setting. Omitting `chat.model` retains the existing single-model behavior.
`config.qwen3.example.json` remains available for experiments that use Qwen3 for wallet extraction too. Ollama must use an
`http://127.0.0.1` URL; configuration rejects remote hosts. A fixed seed does not make model output fully deterministic.

Create a local configuration from the template, preserving an existing configuration:

```sh
umask 077
mkdir -p "$HOME/.agent-layer"
if [ ! -e "$HOME/.agent-layer/config.json" ]; then
  cp config.example.json "$HOME/.agent-layer/config.json"
fi
```

Edit that local copy before starting. Replace the example wallet and universal-resolver address placeholders with the intended public addresses, and replace the `<anon-rpc>` placeholders with your anon-rpc endpoints. RPC URLs must be https, or `http://127.0.0.1` for a node on this machine, and `execution.url` must be `http://127.0.0.1`. The example sends everything that leaves this machine through Tor: `network.socks_proxy` is `socks5h://127.0.0.1:9050`, Tor's default SOCKS port. Install Tor and start it before the agent and the wallet (`tor`, or the system service); its default `IsolateSOCKSAuth` gives each kind of query its own circuit. If Tor isn't running, chain reads, ENS lookups, the indexer and links fail rather than go direct. Choose anon-rpc endpoints that accept Tor connections. Set `network.socks_proxy` to `null` only for a setup without Tor, such as a local node at `http://127.0.0.1`; `ens.indexer_url: null` and `fetch.enabled: false` turn group sends and link reading off. See `docs/spec/AGENT_SPEC_v1.1.md` §16.5. Configure the separate execution service URL and its token file. The template intentionally contains invalid placeholder addresses and is not a ready-to-run deployment. Configuration requires the baseline fields and rejects unknown fields; `llm.think` and `chat` are optional. Supported chain IDs are Sepolia `11155111`, Base Sepolia `84532`, and Arbitrum Sepolia `421614`.

For an existing configured installation, set `llm.model` to `qwen2.5:7b-instruct`, omit `llm.think` or set it to
`false`, and use `chat: { "enabled": true, "think": true, "model": "qwen3:8b" }` for thinking chat. Retain its wallet,
endpoints, tokens and database paths, then restart the service to load the configuration. Omitting `chat` or
setting `enabled: false` preserves wallet-only behavior. The local test frontend selects Qwen2.5 for wallet calls
and Qwen3 for thinking chat on its next launch; existing demo processes keep the configuration they loaded at startup.
Both models must be installed locally. The existing health check reports the primary wallet model's availability;
a missing chat model produces the normal chat-unavailable reply without switching wallet calls to another model.

General chat uses the existing messages and text-answer endpoints. It preserves pending questions and confirmations,
and has no execution, browsing or live-data tools. It can explain a current summary without approving it. It keeps
up to six complete conversational exchanges within a 4,000 UTF-8-byte memory budget, only for the current session;
omitted history is identified in the model context. Individual routed messages are limited to 4,000 UTF-8 bytes
and oversized messages receive a request to shorten them. Initial wallet wording, question guidance and the current
summary have separate bounds; chat cannot derive a current plan from stale original wording. These bounds retain
space for Qwen's thinking within the configured context. Reasoning traces are neither returned nor logged.

Common address and balance questions bypass Ollama and RPC, even with chat disabled or the model offline. Each
session captures its public wallet address when it opens. Balance replies read the background-updated DB4 cache
and current local spending reservations. Cache timestamps stay in internal context, outside the answer text. Asking while a payment is open preserves
its question, attempt count and confirmation. A cold or unavailable cache is reported as unavailable, never zero.
Unreadable networks are excluded from totals, which are labelled subtotals when incomplete.

Payment-status follow-ups (for example, “did the transaction go through?”) also read local state without Ollama
or RPC. They preserve the open question, summary and retry state. The current payment, or the last payment when
an unrelated request intervenes, is remembered only within the session. Handoff acceptance is separate from
execution: the submission journal and DB6 reports distinguish pending, failed, partial and completed payments.
Autopay schedule state is displayed separately from transaction confirmation. The demo execution adapter identifies
locally captured requests explicitly. General chat receives a code-owned status summary, without transaction hashes.

Received-payment questions for up to seven days and explicit hash explanations also bypass Ollama. Incoming history requires
an opt-in Blockscout source and uses its own background cache; unknown hashes are inspected locally without
being looked up or stored. See [received payments and identifiers](docs/agent/RECEIVED_PAYMENTS.md) for setup,
coverage, the 168-hour limit, shorter ranges and the ambiguity between private keys and transaction hashes.

With chat enabled, other contextual wallet questions use the read-only `wallet_info` path: the model selects
verified fact IDs from the same local cache, and code renders their exact values. Mixed display/payment requests
still use the payment pipeline. Neither wallet display path can approve a payment.

The experimental Qwen3 wallet-chat check is `LIVE_MODEL=qwen3:8b npm run test:live -- test/live/wallet-chat.test.ts`.
That suite enables Qwen3 chat thinking and does not validate the Qwen2.5 hackathon chat configuration.
Its synthetic-data results are written under the ignored `test_frontend/runtime/wallet-chat-live.json`.

The default configuration path is `~/.agent-layer/config.json`; `AGENT_CONFIG=/absolute/path/config.json` selects another file. Leading `~/` in configured filesystem paths is expanded. Keep local credentials, token files and database keys out of the repository. The wallet setting is a public address; the agent does not need a wallet private key or seed phrase.

## Tokens and encrypted storage

Startup creates missing token files with 32 random bytes encoded as 64 lowercase hexadecimal characters. Existing token files must contain that format and have mode `0600`; their parent directories are created with mode `0700` when needed.

| Configuration field                | Default file                              | Used by                                                |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `auth.ui_token_file`               | `~/.agent-layer/ui_token`                 | UI requests, including `/v1/health`                    |
| `auth.execution_report_token_file` | `~/.agent-layer/execution_report_token`   | Execution service callbacks to `/v1/execution/reports` |
| `execution.outbound_token_file`    | `~/.agent-layer/execution_outbound_token` | Agent requests to the execution service                |

Requests use `Authorization: Bearer <token>`. UI and report tokens must differ. Configure the execution service to accept the outbound token and use the report token for its callbacks. To provision the files without starting the server, after building and configuring:

```sh
node --input-type=module -e '
import { loadConfig } from "./dist/src/config/load.js";
import { loadTokens } from "./dist/src/config/tokens.js";
loadTokens(loadConfig());
'
```

The database encryption key is generated on first startup and stored through the OS keychain as service `agent-layer`, account `db-key`. Production startup needs access to that keychain entry. Keep the same entry when reopening the database: another key cannot decrypt the existing file. Tests inject a fake key store and do not access the production entry.

Database schema version 2 is applied automatically on open. Upgrading a version 1 database adds `handoff_journal` in a transaction and advances `PRAGMA user_version`; existing DB1–DB8 tables remain intact. The journal stores the envelope and request identity before submission, alongside pending execution records, so retries and late reports retain their original correlation. Session clearing removes session history from the journal while preserving delivery records.

## Start and inspect

```sh
npm run build
AGENT_CONFIG="$HOME/.agent-layer/config.json" npm start
```

The server binds only to `127.0.0.1`, normally port `8787`. Every route requires its appropriate bearer token. An authenticated `GET /v1/health` reports `ok`, `db`, and model availability as `ollama`. If the configured model is unavailable, requests return `MODEL_FAILED`. Allowlist logs are written to `~/.agent-layer/logs/agent.log`.

Production requests can contact configured RPC servers, the ENS indexer, the execution service, local Ollama, and user-supplied HTTPS content. A plan still needs confirmation. Before its first submission, confirmation refreshes balances and current limits and checks whether an autopay start has passed. Changed settings or summaries require another confirmation; a stale autopay start asks for a new start. A retry after submission preserves the original envelope and idempotency identity.

## Tests

Install dependencies first. Unit and acceptance tests use model fixtures, temporary databases, fake key stores and fake execution; they do not send real payments or require Ollama. The audit suite is separate from the default test command and includes local transport checks. These suites do not require external RPC, ENS or wallet services.

```sh
npm test -- --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000
npm run test:unit -- --maxWorkers=2
npm run test:acceptance -- --maxWorkers=2
npx vitest run --config test/audit/vitest.audit.config.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000
```

The first command already includes unit and acceptance tests; the next two select those suites separately. Limiting workers avoids load-related timeouts on this machine.

The live suite uses the real local Ollama model with fake RPC, ENS, content-fetch and execution dependencies. It sends no real payments. Run it without competing model calls or heavy test jobs, and use a new tag to preserve earlier results:

```sh
LIVE_SET=all LIVE_TAG=validation-2026-11-06 npm run test:live -- test/live/live.test.ts
node test/live/summarize.mjs validation-2026-11-06
```

`LIVE_SET` selects `all`, `acceptance`, or `paraphrase`. Optional `LIVE_IDS=A-15,P-061,P-073` selects named cases within that set; unknown IDs are rejected. `LIVE_FROM` and `LIVE_TO` select a zero-based slice after that filtering. The full set contains 154 cases. Results are written incrementally to `test/live/results/<tag>.json`; reusing a tag overwrites that file. The summarizer without explicit tags combines every result file, including partial runs and repeated cases, so pass the intended tag when comparing runs.

Inspect wrong hand-offs, unexpected stops, rejected summaries, crashes, questions and latency in the results, not only Vitest's exit status. SQ-L-01 prompt changes require a full live run with zero wrong hand-offs and fewer unnecessary stops. Recheck unstable cases. A reviewer other than the production-code author grades final acceptance.

The historical wallet and conversation suites default to the Qwen2.5 hackathon model. Select the experimental
Qwen3 model explicitly for comparisons:

```sh
LIVE_MODEL=qwen3:8b LIVE_THINK=false LIVE_CHAT=true LIVE_SET=all LIVE_TAG=qwen3-validation npm run test:live -- test/live/live.test.ts
LIVE_MODEL=qwen3:8b LIVE_THINK=false LIVE_TAG=qwen3-conversation npm run test:live -- test/live/conversation.test.ts
LIVE_MODEL=qwen3:8b LIVE_THINK=false LIVE_CHAT=true LIVE_TAG=qwen3-chat npm run test:live -- test/live/general-chat.test.ts
```

The suites record model settings and effective thinking per call. `LIVE_THINK` and `LIVE_CHAT` must be `true` or
`false`; unset flags preserve baseline settings in the historical suites. `LIVE_CHAT=true` enables general chat
with thinking on while `LIVE_THINK` selects wallet extraction's setting. The dedicated general-chat suite enables
chat by default. The deterministic fixtures and historical live comparison oracle are unchanged.

The separate conversational suite exercises seven multi-turn scenarios, including corrections while a question is
pending, natural amount/address/token answers, refund clarification and new requests. Run it separately when
comparing benchmark metrics:

```sh
LIVE_TAG=conversation-validation npm run test:live -- test/live/conversation.test.ts
```

Its transcripts and model outputs are written to `test/live/results/conversation/<tag>.json`, outside the
154-case summarizer's input directory. General-chat traces are separately written under
`test/live/results/general-chat/<tag>.json`. Running `npm run test:live` without a file filter runs every live suite
serially; use the explicit file filters above to keep benchmark results distinct.
