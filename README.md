# Flex

> Tell your wallet what you want in plain words. A model on your own machine works out the plan, you check it, MetaMask signs it.

Flex lets you type something like *"send 40 usdc to aradhya on base and 20 to mihir on arbitrum"* and turns it into real transactions. It works out who you mean, which chain your money is sitting on, whether it has to bridge first, and what to ask you when something is unclear. Then it shows you a summary. Nothing moves until you say yes, and MetaMask still asks you once more before anything is signed.

The model runs locally through Ollama, so your requests, contacts and balances never go to someone else's API. By default, chain reads, ENS lookups and fetched web pages all go out through Tor.

Flex runs on Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia, with USDC and ETH.

## What it can do

- **Pay people.** Addresses, saved contacts or ENS names, one person or several at once. Several payments on one chain can go out as a single atomic batch.
- **Bridge when it has to.** If your USDC is on the wrong chain, Flex adds a Chainlink CCIP bridge step to the plan, with a cap on the fee.
- **Recurring payments.** *"Pay mihir 10 usdc every friday for 8 weeks."* You sign a MetaMask delegation for that one plan, and a Chainlink CRE workflow pays each run when it's due. The money stays in your wallet until then. *"Stop paying mihir"* cancels the plan and revokes the permission.
- **Pay an ENS group.** *"Send 10 usdc to everyone under iitr.eth."* Flex lists the subnames and you pick who gets paid.
- **Answer questions about your wallet.** Balances, what you received this week, whether the last payment went through, what a pasted hash is. The common ones are answered from local data without calling the model.
- **Stick to your limits.** Spending limits are set in settings or with `/limits`. Nothing typed into the chat can change them.

## How it keeps your money safe

Letting a language model near a wallet is asking for trouble, so most of Flex is plain code built around four small model calls.

- **The model doesn't drive.** Flex is a fixed pipeline, not an agent that picks its own tools. Code calls the model at four points (amounts, request type, recipients, pairing), checks every answer, and decides what happens next.
- **The model never sees your real addresses or amounts.** Before it pairs payments with recipients, those values are swapped for placeholders. Code puts the real ones back only after you confirm.
- **Untrusted text gets its own model.** Pasted text, PDFs, web pages and ENS text records go to a separate, quarantined call with no tools that never sees your request. Anything it pulls out is marked untrusted, needs your explicit confirmation, and can never set up a recurring payment.
- **Private keys and seed phrases are blocked.** Paste one and the request stops right there.
- **The wallet checks again before signing.** It validates the plan on its own, decodes the transaction bytes and simulates them with `eth_simulateV1`. If the plan, the decoded call and the simulation don't all agree, it stops. After sending, it confirms the expected transfers actually happened.
- **Local data is encrypted.** The databases use SQLCipher with the key kept in your OS keychain, and logs never contain amounts or addresses.

## How it works

![How Flex works](assets/architecture.png)

<sub>Source: [`assets/architecture.excalidraw`](assets/architecture.excalidraw). Open it at [excalidraw.com](https://excalidraw.com) to edit.</sub>

1. You type a request into `flexx`.
2. The agent refreshes balances, checks for secrets and untrusted content, pulls out the amounts and recipients, and resolves names through your contacts and ENS.
3. If anything is missing or ambiguous, it asks you.
4. Code builds the plan: which chain each payment comes from, any bridges, the schedule for recurring payments. It checks the plan against your balances and limits.
5. You get a summary and answer `y` or `n`.
6. On `y`, the wallet opens an approval page in your browser and MetaMask pops up for that exact plan.

The repo has three parts:

| Path | What it is |
| --- | --- |
| `/` | The agent, which turns a request into a plan you confirm, plus the `flexx` terminal client |
| `wallet/` | The execution layer. It checks, simulates and sends what you approved through MetaMask, and holds the `IntentExecutorV3` contract and the CRE autopay workflow |
| `packages/protocol/` | `@flex/protocol`, the hand-off format both sides validate |

## Deployed contracts

`IntentExecutorV3` runs registered recurring plans. It can only execute a plan you registered from your own wallet, on the schedule you signed.

| Network | Address |
| --- | --- |
| Ethereum Sepolia | [`0xe282252b6cff630bdb5f584417daf24e8e3843ff`](https://sepolia.etherscan.io/address/0xe282252b6cff630bdb5f584417daf24e8e3843ff) |
| Base Sepolia | [`0xcb775819bf181f91e8a124157368f3e29ba35005`](https://sepolia.basescan.org/address/0xcb775819bf181f91e8a124157368f3e29ba35005) |
| Arbitrum Sepolia | [`0x37af59078638387f0416bef031d8d70b9b6b00f2`](https://sepolia.arbiscan.io/address/0x37af59078638387f0416bef031d8d70b9b6b00f2) |

## Quick start

### You'll need

- Node 24 (see `.nvmrc`), or 22.12+ on the 22.x line
- [Ollama](https://ollama.com) installed. `flexx` starts it and downloads the configured model if needed.
- Tor installed (macOS: `brew install tor`), unless you switch it off (see below). Setup and `flexx` start it automatically when needed.
- MetaMask, plus test USDC ([faucet.circle.com](https://faucet.circle.com)) and test ETH on the chains you want to use
- RPC URLs for the three testnets, and RPCs that support `eth_simulateV1`
- For recurring payments and the contract tests: [Foundry](https://getfoundry.sh) and the CRE CLI

### Install

```sh
git clone https://github.com/0xr10t/Flex.git
cd Flex
npm ci
(cd wallet && npm ci)
(cd wallet/cre/autopay && npm ci)
```

The database and keychain packages use native bindings, so install on the machine that will run Flex.

### Configure

```sh
cp .env.example .env    # your public wallet address, RPC URLs and simulation RPCs
npm run testnet:build
npm run testnet:setup   # writes the agent, wallet and CRE configs to .local/
```

Flex only needs your wallet's public address. Signing happens in MetaMask.

Tor is on by default. `FLEX_SOCKS_PROXY` in `.env` controls it: set it to `direct` to connect without Tor, or to `socks5h://127.0.0.1:9050` to use Tor. Left blank, setup keeps whatever the current config uses, which is Tor on a fresh setup. Run `npm run testnet:setup` again after changing `.env`.

With Tor enabled, `npm run testnet:setup` and `flexx` reuse an existing local SOCKS listener, or start the installed `tor` executable and wait up to two minutes for it to connect. A missing installation or failed connection shows an actionable error; traffic never falls back to a direct connection. Put `tor` on your PATH or set `FLEX_TOR_PATH` in your shell to its executable. If you start the agent directly with `npm start`, run Tor first. Explicit direct mode skips Tor.

Tor's private state and startup log go beside the agent config under `tor/<port>/`. Tor stays running after `flexx` exits so the wallet and other sessions can keep using it.

Questions about payments you've received are off by default. They need a Blockscout API for each chain under `history` in the agent config.

### Run

If no wallet address is saved, `flexx` opens a local connection page in your **default browser**. Approve access in MetaMask and choose an account if it shares more than one. Flexx saves the public address, updates the local configs, and brings your terminal back to the foreground where the desktop supports it. This step requests no signature or payment. An existing address skips it; cancellation or timeout saves nothing. The other RPC/model settings still need to be configured in `.env`.

Interactive `npm run testnet:setup` offers the same connection step when `FLEX_WALLET_ADDRESS` is blank. Noninteractive setup (`--non-interactive`, or without a TTY) reports missing settings instead of opening a browser. If MetaMask is unavailable in the default browser, the connection page explains how to continue.

```sh
npm link  # once, puts flexx on your PATH
flexx
```

`flexx` starts and checks Tor (when enabled), Ollama, the wallet service and the agent while the opening animation plays. It downloads missing configured models, checks that they load, and waits for authenticated wallet and agent health checks before opening the chat session. Startup progress and errors appear in the terminal. An unrelated process on a service port or a mismatched wallet config is reported instead of being treated as ready.

The wallet config defaults to `wallet.config.json` beside the agent config; set `FLEX_WALLET_CONFIG` in your shell for another location. The wallet and agent must agree on the public wallet address, ports, tokens and network routing. Run `npm run testnet:build` after updating the source. `--help`, `--static`, `splash` and `scene` do not start services.

Services that were already running are reused. When you exit, `flexx` cancels unfinished startup and stops the wallet, agent and optional recurring runner it started. Ollama and Tor stay running for other sessions. If startup fails, its newly started Ollama, wallet, agent and recurring processes are cleaned up; existing services are left alone.

Then just talk to it:

```text
send 50 usdc to aradhya on base
what's my balance on arbitrum?
pay mihir 10 usdc every friday for 8 weeks
stop paying mihir
```

When you say yes to a summary, `flexx` opens the wallet's approval page and MetaMask pops up. The first payment on each network also asks you to switch your MetaMask account to a smart account (EIP-7702). The approval page walks you through it, and it costs a little test ETH.

Type `/` for commands and `?` for keyboard shortcuts. If something isn't working, `/doctor` checks Node, the config, the agent, the database, the model, Tor and the wallet, and tells you how to fix whatever failed.

### Recurring payments

Recurring payments need a few more things:

- Foundry
- The CRE CLI, logged in with `cre login`, and either installed at `.local/bin/cre` or pointed to by `CRE_CLI_PATH`
- `FLEX_SOCKS_PROXY=direct`, because the local CRE runner can't go through Tor
- A test-only transmitter key in `.env` (`CRE_ETH_PRIVATE_KEY`), with test ETH on all three chains

```sh
forge build --root wallet/contracts
npm run testnet:onboard               # once: open http://127.0.0.1:8792 in your MetaMask browser
```

Set `FLEX_CRE_MODE=broadcast` in `.env` once, then run `flexx`. It starts the recurring runner after the wallet and agent are ready. Use `FLEX_CRE_MODE=dry-run` to check registered schedules without sending payments, or `off` (the default) to leave recurring execution disabled. Enabling the runner does not change Tor settings: explicitly choose `FLEX_SOCKS_PROXY=direct` and rerun setup first. The runner still requires the CRE CLI login and a funded test transmitter key for broadcasts.

Keep `flexx` open for recurring payments when it started the runner. A run that misses its window is skipped, not paid late. The separate `npm run testnet:start -- --broadcast` launcher remains available for a persistent foreground service session; `flexx` reuses services that are already running.

## Tests

```sh
npm run typecheck
npm run lint
npm test                            # unit and acceptance, no model or network needed
npm run test:audit                  # privacy, logging, network and storage checks
(cd wallet && npm test)
(cd wallet && npm run test:chain)   # real contracts on local anvil chains, needs Foundry
```

To run the acceptance prompts against your real local model, use `LIVE_SET=all LIVE_TAG=<tag> npm run test:live`.

## Current limits

- Testnets only, and only USDC and ETH. No swaps, NFTs or arbitrary contract calls.
- Recurring payments are broadcast by the CRE CLI running on your machine, not by a deployed DON. On testnets the receivers trust Chainlink's mock forwarder.
- `install.sh` is ready, but no release has been published yet, so install from source.

## Docs

- [`wallet/README.md`](wallet/README.md) covers the execution layer and how each payment is checked.
- [`packages/protocol/README.md`](packages/protocol/README.md) describes the hand-off format between agent and wallet.
- `agent-layer-architecture.html` is a visual walkthrough of the agent. Open it in a browser.

## Team

- [@xipharis](https://github.com/xipharis)
- [@akronim26](https://github.com/akronim26)
- [@YASH-ai-bit](https://github.com/YASH-ai-bit)
- [@Okheer](https://github.com/Okheer)
- [@0xr10t](https://github.com/0xr10t)
