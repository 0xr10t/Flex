# Handoff: the `flexx` CLI and the live testnet setup

Written 2026-11-07 for the next agent. Read this first, then `README.md` (sections "The `flexx` terminal" and the
setup steps) and `docs/wallet/`.

## 1. Where things stand

- **Repo** `~/Desktop/Flex`, branch **`CLI`** (pushed to `origin/CLI`, last pushed commit `e7a1eb8`). `CLI` contains
  everything on `origin/master` as of 2026-11-07 (agent, wallet, protocol v2, Tor routing, CRE testnet runner,
  installer). The user asked to **leave `master` alone** for now; do not push to it.
- **Uncommitted work (tested, not yet committed):** the Claude-Code-style UX pass on `flexx`, listed in section 4.
  All 2827 tests pass, lint/typecheck/build clean. The user commits by saying "commit and push" after each change;
  ask before committing.
- **Untracked:** `Flex animated ASCII art-handoff.zip` (the Claude Design export the CLI animations came from). Leave it.

## 2. What `flexx` is

A full-screen terminal client for the agent's UI API (`src/cli/`), installed with `npm link` as the `flexx` bin
(`/usr/bin/flex` already exists on macOS, hence the double x).

| File | Role |
| --- | --- |
| `main.ts` | Arg parsing, entry; views `opening` (default), `splash`, `scene`; `--static` prints one frame |
| `terminal.ts` | Full-screen runner: alt screen, row-diff redraw at ~30 fps, mouse + bracketed paste, phases intro → snap → shrink → box |
| `render/*` | ASCII renderers ported from the Claude Design handoff: `scene.ts` (gateway scene, layered), `splash.ts` (cube + FLEXX), `snap.ts` (dust dissolve), `stage.ts` (adaptive layout), `paint.ts` (ANSI, incl. the "marked" light bar), `frame.ts` |
| `repl.ts` | The conversation box: entries, `❯` user bars, `●` replies, `✻ Working…`, input line, slash-command palette, shortcuts panel, scrollback |
| `input.ts` | Raw input → keys, mouse, wheel, paste |
| `chat.ts` | Conversation logic against the agent: messages, numbered answers, y/n confirmation (re-asks on anything else), slash commands |
| `agent/client.ts` | HTTP client for `/v1/sessions…`, `/v1/settings/limits`, `/v1/health` |
| `agent/launcher.ts` | Finds the config (`AGENT_CONFIG` → `.local/agent.config.json` → `~/.agent-layer/config.json`), starts the agent if nothing answers on its port, stops it on exit |
| `open.ts` | Opens only loopback wallet URLs (optionally `#approve=req_<12hex>`); clipboard for `/copy` |

After a `y`, `flexx` opens `http://127.0.0.1:8788/#approve=<request_id>`. The wallet page (`wallet/src/browser/ui.*`)
then shows only that request with its details filled in and opens MetaMask by itself once the step's checks pass
(once per step; expired quotes are re-checked first).

Tests: `test/unit/cli/cli.test.ts`, `test/unit/cli/agent.test.ts`, and `test/acceptance/cli-chat.test.ts` (end to end
against the real agent app with recorded model replies).

## 3. Live testnet setup on this machine

- `.env` (user-filled, gitignored, mode 0600) → `node scripts/setup-testnet.mjs` → `.local/agent.config.json`,
  `wallet.config.json`, `cre.config.json`, tokens. Re-run it after editing `.env`.
- **Wallet address:** `0x141A811C87980B283aa6cC9E1B19d945FAA7ac78` (the user's MetaMask account; switched from
  `0x5eBA55e1b43c8714E4432250Dada7A518780C871` on 2026-11-07). `AUTOPAY_FEE_COLLECTOR` is still `0x5eBA…`.
- **Tor** (user's choice, for privacy): `brew services start tor`, SOCKS `127.0.0.1:9050`. Because of it,
  `npm run testnet:start` refuses (`CRE_LOCAL_PROXY_UNSUPPORTED`), so start the pieces separately:
  - wallet: `node wallet/dist/src/main.js .local/wallet.config.json` (MetaMask mode, port 8788, no signing key)
  - agent: `flexx` starts it, or `AGENT_CONFIG=$PWD/.local/agent.config.json node dist/src/index.js` (port 8787)
- **Node:** project uses 24.22.1 (`.nvmrc`). The user's nvm default is 23.11.1 and `flexx` was linked under it, so
  `/doctor` flags node. Suggested fix (user's call, not done): `nvm alias default 24.22.1`, then `nvm use 24.22.1 && npm link`.
- **Models:** Ollama has `qwen2.5:7b-instruct` (configured) and `qwen3:8b`. CRE CLI, Foundry, Bun installed.
- **Currently running when this was written:** wallet in the Terminal tab "flex wallet"; an **old agent** (PID 8696,
  started by the user's earlier `flexx` session) still configured with the old wallet `0x5eBA…`. The user must exit
  that `flexx` (Ctrl-C twice) before payment tests, or the agent will plan for the wrong wallet.

## 4. Uncommitted UX pass (commit message suggestion: `feat(cli): command palette, shortcuts and setup commands`)

- `/` opens a command palette above the input (prefix, alias and substring matches; ↑↓, Tab completes with an
  argument hint, Enter runs, Esc closes). `?` on an empty line shows the shortcuts panel.
- Keys: Ctrl-C twice (or Ctrl-D twice) to leave, Esc clears the line, Ctrl-A/E, Ctrl-U/K/W, bracketed paste (one line,
  never submits), PgUp/PgDn and mouse wheel scroll back with a "↓ N more below" marker, a key-hint row on the lower rule.
- New commands: `/doctor` (node, agent, db, model pulled, Tor port, wallet; each failure shows the fix), `/config`
  (setup summary, never RPC URLs or tokens), `/copy`, `/version`, `/shortcuts`; aliases `/quit`, `/balances`, `/reset`.
- README "The `flexx` terminal" section updated to match.

## 5. Open problems found, not fixed

1. **ENS group sends are blocked: the indexer is down.** `ens.indexer_url` (`config.example.json`, `.env.example`, the
   user's `.env`) is `https://api.v2-sepolia.ensnode.io/api/omnigraph`. That host now serves Railway's default
   certificate (`CN=*.up.railway.app`), directly and over Tor, so TLS fails and the agent reports
   `ENS_INDEXER_UNAVAILABLE`. `api.alpha-sepolia.ensnode.io` / `api.sepolia.ensnode.io` also failed over Tor in a
   quick probe (not diagnosed further; may be Tor-specific). Next step: find a working Sepolia ENSNode Omnigraph
   endpoint (see https://ensnode.io/docs/hosted-instances; NameHash recommends pinning enssdk@1.13.1 against hosted
   instances) or self-host ENSNode, then update `.env` `ENS_INDEXER_URL`, re-run the setup script, and test.
   The test group is `iitr.eth` with `alpha`, `beta`, `gamma`, `delta.iitr.eth` (owner `0x89cE79730f8a1F4B05B4EF9334ef4f53E237dE20`,
   see `scripts/ens-check.iitr.json`). Whether each subname has an address record per chain was not yet checked.
2. **Funding.** The new wallet's balances were not read yet. The user wants test USDC on several chains for CCIP
   tests. An agent must not move funds itself; the user funds via faucet.circle.com (USDC, Sepolia / Base Sepolia /
   Arbitrum Sepolia) and an ETH faucet (Alchemy / Chainlink) for gas and CCIP fees. The old wallet `0x5eBA…` held
   ~13.8 USDC and ~9.6 ETH across the three chains.
3. **Contact "ARADHYA" is now the user's own wallet** (`0x141A…ac78`), so "send … to ARADHYA" fails with
   `SELF_PAYMENT`. Ask the user for real addresses for aradhya and mihir (mihir is not a contact yet).
4. **Small-number amounts:** "Send 1 USDc to ARADHYA" made the model ask `Q_AMOUNT_UNCOVERED` ("Should 1 be paid?").
   Worth a look in the S3 amount prompt/parser.
5. **Base Sepolia balance occasionally unreadable over Tor** right after startup; the planner then avoids that chain.

## 6. The test plan the user wants next

The user's prompts (scaled to the funds available; the user approves each MetaMask prompt themselves):

1. `Send 50 USDc to ARADHYA`
2. `Send 50 usdc to ARADHYA on base` (bridging)
3. `Send 40 usdc to ARADHYA on base, and 20 usdc to mihir on arbitrum` (balance split 50 arb / 30 base)
4. `Send 10 usdc to everyone on the list with @iitr.ac.in subdomain` (ENS group; parent → `iitr.eth`)

How to drive it (worked in this session):

- Keep the agent and wallet running as separate processes (section 3) so `flexx` doesn't stop the agent between runs.
- `.local/e2e/driver.py` runs `flexx` in a pty with an emulated screen (`.local/e2e/screen.txt`) and a fake `open`
  (`.local/e2e/bin/open`) that records the approval URL in `.local/e2e/opened.log` instead of opening a browser:
  `python3 .local/e2e/driver.py .local/e2e "$(command -v node)" "$PWD/dist/src/cli/main.js"` (run in background, Node 24).
  Type with `.local/e2e/say.sh "<line>"` (adds Enter) or write `::raw <text>` / `::key` / `::quit` to `.local/e2e/in.fifo`;
  `.local/e2e/ask.sh "<line>"` types, waits for the reply and prints the conversation.
- Open the recorded `#approve=…` URL in the user's Chrome (the user asked for `/browser-skill` / `bsk`; it needs
  `cooperate sync` and `--context`/`--observation` for navigation). Then tell the user exactly what MetaMask should
  show (amount, recipient, network) and wait for them to approve. **Never answer `y` without the user expecting it,
  and never approve anything yourself.** If the user stops the bsk session, do not resume it unasked.
- Check the result on the wallet page and in the wallet tab's log (`step_finished`), then in `flexx`.

## 7. User preferences seen in this session

- Wants each change committed and pushed to `origin/CLI` on request ("commit and push"); not to `master`.
- Iterates on the CLI look from screenshots; keep the Claude Design visual language (dark starfield, amber accent).
- Privacy matters: chose Tor; never print `.env` values, RPC URLs (they carry API keys) or tokens.
