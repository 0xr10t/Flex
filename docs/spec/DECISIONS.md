# Architecture decisions

Date: 6 November 2026. Companion to the Flex README v1.1 and `TESTED.md`. Each decision says what we picked, why, what we
give up, and how far it is tested. Test tags (B1, C6, V, L…) point to `TESTED.md`.

**Status words:** **Tested live** (public testnet) · **Tested locally** (real contracts on a local chain, with the stand-ins
listed in `TESTED.md` §2) · **Schema-tested** (validators only) · **Not tested** (decided, never run).

---

## Part 1 — How the whole system is split

### D1. Three layers, and only one JSON file crosses from the AI to the chain

The agent layer (local LLM + code) turns a chat message into intents and asks questions when something is missing. After the
user says yes, it hands one JSON envelope (Flex §12.5) to the execution layer, which builds, signs and sends the
transactions. The execution layer never reads the agent's databases; it only reports results back.

**Why:** the model never touches keys or signing, and the hand-off is small enough to check twice: once by the agent
(Ajv), once by the execution layer (zod, after mapping).
**Status:** Schema-tested. The envelope and the mapping pass 29/29 (§4.4). The two layers aren't wired together yet.

### D2. The AI part stays exactly as Flex designed it

Placeholders instead of real amounts and addresses, four narrow LLM calls, a fixed state machine, a quarantined LLM for
pasted text and web pages, a local model only. v1.1 changed none of it.

**Why:** these choices protect privacy and stop prompt injection, and nothing in our onchain tests contradicted them.
**Status:** Not tested by us. Flex lanes A–C have partial code; the real model has never been run.

### D3. Checking twice is required, not optional

The agent's envelope schema can't express every cross-field rule. One of your scenarios (a bridge landing on the wrong chain
for its payment) passed the envelope and was only caught by the verified plan.

**Status:** Schema-tested (§4.3, §4.4: 10 envelope-valid cases rejected only by the second check).

---

## Part 2 — Wallet

### D4. The money stays in the user's wallet (EIP-7702)

The user's normal address is upgraded with EIP-7702 to MetaMask's smart-account code. Same address, same key, and the funds
never move to another account.

**Why:** the old design made a separate prefunded account per autopay. That meant scattered money, refunds that can fail, and a
factory contract. Before 7702 that box was the only way to limit what a bot could spend; with 7702 the limits come from a signed
permission instead.
**What we give up:** one 7702 authorization per chain. If the user spends their balance down, an autopay run is skipped (the old
box guaranteed the money was there).
**Status:** Tested live (Sepolia) and locally. MetaMask's contracts are at the same addresses on all three testnets (L).

### D5. Every automated payment is one signed permission with locked rules

For each autopay the user signs one MetaMask delegation to our executor contract, with three rules the chain checks on every run:
exact batch (recipient, amount, token, fee), run count, and time window.

**Why:** whoever triggers a run can only make that exact batch happen at those times. Redirecting the fee, swapping
recipients, paying early, paying after the end and forging the signature were all blocked.
**What we give up:** changing an autopay means cancelling it and creating a new one.
**Status:** Tested live (R1) and locally (B6, B7b, B8, V).

---

## Part 3 — Payments

### D6. A group send is one all-or-nothing transaction

Paying many people, including everyone under an ENS name, is one transaction with a list of recipients, at most 100.

**Why:** with one transaction per person, a failure halfway leaves some people paid and a retry can pay them twice.
**What we give up:** groups above 100 (100 USDC transfers ≈ 3.9 M gas).
**Status:** Tested locally (B4, B12: 20 / 50 / 100 recipients).

### D7. Group sends come from ENSv2 subnames

"Send 10 USDC to everyone under iitr.eth" lists the direct subnames from an ENS indexer (ENSv2 can't list them onchain),
resolves each member's address for the chosen chain through ENSv2, lets the user untick people, then pays them as in D6.
One chain per group; recurring group payments are out of scope.

**Status:** The payment side is Tested locally (B12). The ENS side is **Not tested**. The indexer query in Flex §9.6 uses the
classic subgraph shape, so it must be checked against the ENSv2 indexer the team picks.

### D8. The schema stops what the chain would silently get wrong

The chain happily runs some bad payments, so the schema checks for them:
- ETH sent instead of USDC
- payment to the zero address
- a payment a day early
- caps too low to cover the fee
- a late window longer than the interval
- an end date that cuts off promised runs

**Status:** Tested locally and Schema-tested (B1, B7a, B9, 43/43).

---

## Part 4 — Autopay

### D9. Fixed interval, late window, missed runs skipped

Run *n* is due at `start + n × interval` and can be paid until `+ late window` (default 1 h). A run missed by more is skipped,
never paid late, and still counts toward the run count.

**Why:** the old executor measured from the last payment, so the schedule drifted and the same delegation sent again under a
new id was paid again. Anchoring every run to the start makes double payment impossible.
**What we give up:** no monthly or "on the 1st"; the agent offers "every 4 weeks" or "every 30 days". A weekly autopay on
several days becomes one autopay per day. Times are fixed in UTC, so in daylight-saving countries the local time moves by an
hour twice a year (India has none).
**Status:** Tested locally (C4–C7, e2e, V). The Flex planner code for it is not written yet (lane D).

### D10. The user registers each autopay with their own transaction

After signing, the wallet calls `IntentExecutorV3.register(...)`. The contract checks the delegation is from the caller and
names itself, stores only a hash, and emits the full signed delegation. CRE's timer reads those events from the chain.

**Why:** CRE's HTTP trigger only accepts requests signed by keys listed in the workflow, so we'd need our own gateway server.
That server would be a required middleman, and whoever sent the first report chose the schedule. With `register()`, only the
user can register their delegation and set its schedule. The plan list is on the chain, and CRE can run plans but never
create them.
**What we give up:** one extra transaction at setup (154 k gas).
**Status:** Tested locally (V 16/16). Reading the events with `filterLogs` inside a deployed CRE workflow is Not tested (no
deploy access).

### D11. One shared CRE workflow, no per-autopay job, no session keys

One cron workflow and one executor per chain serve every user.

**Why:** CRE allows 3 workflows per organisation, so one job per autopay can't scale. Session keys would need someone holding a
spending key online at payment time. CRE never holds a key that can spend; it can only deliver a report the contract and the
signed rules check.
**What we give up:** if CRE stops, runs stop (nothing wrong can be paid). Because the plan list is onchain, the executor could
later accept any keeper.
**Status:** The executor side is Tested locally, with a stand-in forwarder. The real KeystoneForwarder and a deployed
workflow have only run with your first executor (R1).

### D12. The autopay fee is inside the signed batch

Each run pays the recipient plus a small fee to the operator. Caps include the fee.

**Status:** Tested locally (B8, e2e, V); Schema-tested (fee rules).

### D13. Cancel is one batch, nothing to refund

`l` sends one transaction that marks the plan cancelled in the executor and disables the delegation in MetaMask's
DelegationManager.

**Status:** Tested locally (V, B5).

---

## Part 5 — Cross-chain

### D14. Bridge to yourself, then pay

If the money is on the wrong chain, the plan bridges USDC to the user's own address, waits until it arrives, then pays as a
normal payment.

**Why:** paying on arrival needs a receiver contract on every chain and a recovery path when the payment fails. Bridging to
yourself needs neither; a failed payment just leaves the money in your own wallet.
**Status:** Tested locally with the stand-in router (J1, J2); the plan rules are Schema-tested (P). The live arrival isn't
tested (fork run pending).

### D15. Only USDC is bridged, never ETH

**Why:** CCIP moves ETH only as WETH, and only where a WETH pool exists. Live, Base Sepolia has no WETH pool to either other
chain, so "send my ETH from Base to Arbitrum" and "combine my ETH from Base and Arbitrum" can't work. USDC has a pool on all
six lanes. The agent checks the lane before planning, using the same calls the live check used.
**What we give up:** no moving ETH between chains in v1. The agent says so (`ETH_NOT_BRIDGEABLE`).
**Status:** Tested live (L, read-only).

### D16. CCIP fee in ETH, exact quote, no padding

One batch: approve exactly the amount, then send with the fee quoted right before signing, capped at 0.002 ETH. Padding is
0 % by default.

**Why:**
- The router keeps any overpayment (seen in the test and in Chainlink's own router code).
- A separate unlimited approval is left behind if the bridge fails.
- Paying the fee in ETH should make USDC arrive in full.
- Live fees for USDC were 0.00012–0.00082 ETH.

**Status:** Tested locally (J1, J3, J4, J7) and live, read-only (fees). Whether USDC arrives 1:1 is Not tested; the fork
run decides it. If it arrives short, `bridge_buffer_pct` goes up; no schema change.

---

## Part 6 — Limits and scope

### D17. Limits

- **One-time payments** count when handed off.
- **Autopay runs** count when they run. A run can push the day over the limit because the signed delegation enforces it; the
  summary says so.
- **Bridges** count only the CCIP fee in ETH, plus the buffer when padding is on.

**Status:** Decided; the Flex validation code is not written yet.

### D18. Scope of v1

- Three testnets: Sepolia, Base Sepolia, Arbitrum Sepolia.
- USDC and ETH payments; USDC bridging.
- ENS group sends.
- No swaps, monthly schedules, group autopays or mainnet.

---

## Still open

1. **Simulation before confirmation.** `eth_simulateV1` works (R1), but nothing simulates a hand-off file yet. Flex has no
   simulate step. Proposal: the agent calls the execution layer's `/v1/simulate` before the summary. That needs state overrides
   for the 7702 code and for bridged balances, and a forwarder-as-sender plus time override for an autopay's first run.
2. **Open the executor to any keeper**, so CRE isn't the only trigger.
3. **Who runs the RPC and the ENS indexer** (for "no required provider").
4. **Monthly schedules** (needs a signed list of dates).
5. **Autopay groups**, and autopays above 50 recipients.
6. **ETH between chains:** keep saying no, or add a second bridge.
7. **Session keys** for small agent budgets.
