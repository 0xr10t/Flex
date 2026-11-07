# Flex

**A private AI agent layer for your Ethereum wallet.**

Type what you want to pay. A local model understands it, code verifies every value, you confirm it, MetaMask signs it.

```text
› send 50 usdc to aradhya on base and 20 to mihir on arbitrum
```

No cloud AI and no server of ours. The model runs on your machine through Ollama, and network reads go through Tor.

## What you can ask

| | |
| --- | --- |
| **Pay** | `send 40 usdc to aradhya on base`: addresses, contacts or ENS, several people at once |
| **Cross-chain** | Funds on the wrong chain? A Chainlink CCIP bridge step is added for you |
| **Repeat** | `pay mihir 10 usdc every friday for 8 weeks`: one capped MetaMask permission, run by Chainlink CRE |
| **Cancel** | `stop paying mihir`: stops the plan and revokes the permission |
| **ENS groups** | `send 10 usdc to everyone under iitr.eth` |
| **Ask** | `what's my balance on arbitrum?` Most questions are answered from local data |

## Why it's safe

- **A fixed pipeline, not a free-roaming agent.** Code calls the model at four narrow points and checks every answer.
- **The AI never sees real values.** Amounts and addresses become placeholders before the model pairs them. Code swaps them back only after you say yes.
- **Untrusted content can't take over.** Pasted text, web pages and ENS records go to a quarantined model with no tools. What it extracts needs your confirmation and can never set up a recurring payment.
- **You stay in control of the money.** Spending limits live in settings, not the chat. The wallet decodes and simulates every transaction (`eth_simulateV1`) before MetaMask sees it.
- **Encrypted at rest.** SQLCipher, with the key in your OS keychain. Logs never contain amounts or addresses.

![How Flex works](assets/architecture.png)

## Get started

You need macOS or Linux, Node 24 (or 22.12+), Git, Python 3, a C/C++ toolchain, [Ollama](https://ollama.com), Tor and MetaMask. You'll also need testnet RPC URLs, plus testnet ETH and USDC ([faucet](https://faucet.circle.com)).

```sh
curl -fsSL https://raw.githubusercontent.com/0xr10t/Flex/master/install.sh | bash
cd ~/.flex/current && cp .env.example .env    # your public address and RPC URLs
npm run testnet:setup
~/.flex/bin/flexx
```

The installer builds into `~/.flex`. It never uses sudo, edits your shell or starts services. Inside `flexx`, type `/` for commands and run `/doctor` if anything misbehaves.

<details>
<summary>Recurring payments</summary>

These need Foundry, the CRE CLI (`cre login`), a test transmitter key (`CRE_ETH_PRIVATE_KEY`) and `FLEX_SOCKS_PROXY=direct`.

```sh
forge build --root wallet/contracts
npm run testnet:onboard    # deploy your IntentExecutorV4 at http://127.0.0.1:8792
```

Then set `FLEX_CRE_MODE=broadcast` in `.env` and run `flexx`.

</details>

<details>
<summary>Development</summary>

```sh
git clone https://github.com/0xr10t/Flex.git && cd Flex
npm ci && npm --prefix wallet ci && npm --prefix wallet/cre/autopay ci
npm run typecheck && npm run lint && npm test
npm run test:audit         # privacy, logging, network and storage checks
```

`/` is the agent and the `flexx` client. `wallet/` is the execution layer and contracts, and `packages/protocol/` is the shared hand-off schema.

</details>

## Scope

Testnets only (Sepolia, Base Sepolia, Arbitrum Sepolia) with USDC and ETH. No swaps, NFTs or mainnet.

## Team

[@xipharis](https://github.com/xipharis) · [@akronim26](https://github.com/akronim26) · [@YASH-ai-bit](https://github.com/YASH-ai-bit) · [@Okheer](https://github.com/Okheer) · [@0xr10t](https://github.com/0xr10t)
