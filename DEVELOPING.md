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
curl --fail --silent http://127.0.0.1:11434/api/tags
```

The production settings in `config.example.json` are model `qwen2.5:7b-instruct`, temperature `0`, seed `42`, context `8192`, and timeout `60000` milliseconds. Ollama must use an `http://127.0.0.1` URL; configuration rejects remote hosts. A fixed seed does not make model output fully deterministic.

Create a local configuration from the template, preserving an existing configuration:

```sh
umask 077
mkdir -p "$HOME/.agent-layer"
if [ ! -e "$HOME/.agent-layer/config.json" ]; then
  cp config.example.json "$HOME/.agent-layer/config.json"
fi
```

Edit that local copy before starting. Replace the example wallet and universal-resolver address placeholders with the intended public addresses, and replace the `<anon-rpc>` placeholders with your anon-rpc endpoints. RPC URLs must be https, or `http://127.0.0.1` for a node on this machine, and `execution.url` must be `http://127.0.0.1`. The example sends everything that leaves this machine through Tor: `network.socks_proxy` is `socks5h://127.0.0.1:9050`, Tor's default SOCKS port. Install Tor and start it before the agent and the wallet (`tor`, or the system service); its default `IsolateSOCKSAuth` gives each kind of query its own circuit. If Tor isn't running, chain reads, ENS lookups, the indexer and links fail rather than go direct. Choose anon-rpc endpoints that accept Tor connections. Set `network.socks_proxy` to `null` only for a setup without Tor, such as a local node at `http://127.0.0.1`; `ens.indexer_url: null` and `fetch.enabled: false` turn group sends and link reading off. See `docs/spec/AGENT_SPEC_v1.1.md` §16.5. Configure the separate execution service URL and its token file. The template intentionally contains invalid placeholder addresses and is not a ready-to-run deployment. Configuration requires every declared field and rejects extra fields. Supported chain IDs are Sepolia `11155111`, Base Sepolia `84532`, and Arbitrum Sepolia `421614`.

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
LIVE_SET=all LIVE_TAG=validation-2026-11-06 npm run test:live
node test/live/summarize.mjs validation-2026-11-06
```

`LIVE_SET` selects `all`, `acceptance`, or `paraphrase`. Optional `LIVE_IDS=A-15,P-061,P-073` selects named cases within that set; unknown IDs are rejected. `LIVE_FROM` and `LIVE_TO` select a zero-based slice after that filtering. The full set contains 154 cases. Results are written incrementally to `test/live/results/<tag>.json`; reusing a tag overwrites that file. The summarizer without explicit tags combines every result file, including partial runs and repeated cases, so pass the intended tag when comparing runs.

Inspect wrong hand-offs, unexpected stops, rejected summaries, crashes, questions and latency in the results, not only Vitest's exit status. SQ-L-01 prompt changes require a full live run with zero wrong hand-offs and fewer unnecessary stops. Recheck unstable cases. A reviewer other than the production-code author grades final acceptance.
