# Open questions

These are the points the spec does not settle. None of them is assumed anywhere in this plan. Each one lists what the
sources say and what it blocks. A recommendation is a suggestion for the decider, not a decision.

## Decide before building

### OQ-01: How is the user's key held, and what signs?

- **Direction changed (user, 6 Nov 2026):** CLI based, with MetaMask holding the key and its popup approving each step. See the tracker.
- **DECIDED (user, 6 Nov 2026): Option A.** The wallet holds the key, encrypted on the user's device. The user approves
  each payment in the wallet, and the wallet then signs. Still open: where exactly it is encrypted, and whether the key is
  created or imported.
- **Sources:** D-12 says "execution layer signs". §14.2 says "the user signs". §2.3 says one EOA. `src/chain.ts` and
  `register.v3.test.ts` pass a raw `OWNER_KEY` to `signDelegation` and `signAuthorization`.
- **Gap:** no custody design anywhere. It must be able to sign EIP-7702 authorizations, EIP-712 delegations and normal
  transactions on three chains.
- **Blocks:** Part 3, so also 4, 5, 7 and 8.

### OQ-02: How does the user approve signing, and who builds that surface?

- **Sources:** after a 2xx the agent says "Sent to your wallet for signing." (§13.3). §14.1 defines UI ↔ agent only. The
  README header says the UI is another team's.
- **Gap:** there is no UI ↔ wallet interface. It is not stated whether the user approves per request or per step, or how
  a rejection is reported. A rejection presumably maps to `intent_result` `failed`, but nothing says so.
- **Blocks:** Part 3. Also decides whether any UI work belongs to this plan.

### OQ-03: Where does the wallet code live, and on what runtime?

- **Sources:** §21 lays out the agent only. §5 fixes the stack for the agent only. The lab runs on bun with viem
  `^2.57.16`, `@metamask/smart-accounts-kit` `^2.0.0`, zod `^4.6.7`. The old CRE workflow pins zod `3.25.76`.
- **Recommendation:** a separate package in this repo (for example `wallet/`) on Node 22 and TypeScript to match §5, with
  a `contracts/` folder and a `cre/` folder. Keep the kit and zod versions the tests used.
- **Blocks:** Part 1.

### OQ-04: What durable store and logging rules does the wallet use?

- **Sources:** §14.2 rule 7 needs repeated keys to return the original result, which must survive a restart. Parts 7, 8
  and 10 need `plan_id` ↔ `request_id`, `autopay_id` and amounts. No store is specified. §18's logging allowlist is
  written for the agent process.
- **Recommendation:** SQLite encrypted like the agent's, and the §18 allowlist applied to the wallet too. Autopay rows
  hold amounts and addresses, and the agent's rule is that those never reach logs.
- **Blocks:** Part 2.

### OQ-05: Who updates the agent layer to v1.1, and when?

- **Evidence (searched in `src/` on 6 Nov):**
  - `src/schemas/handoff-envelope.schema.json` is `handoff-envelope/v1`. `src/handoff/swap-back.ts:124` emits
    `version: '1'`, with `prefund`, `cre_job`, `delegate_address`, `refund_remaining`.
  - `src/db/schema.sql` still has `autopay_prefund`, `delegate_address`, `cre_job_id`.
  - `src/config/defaults.ts:18` has `bridge_buffer_pct: '2'`; the spec says `"0"`.
  - **Zero** files in `src/` contain `ETH_NOT_BRIDGEABLE`, `BRIDGE_LANE_UNAVAILABLE`, `LIMIT_GROUP_SIZE`,
    `Q_AUTOPAY_MONTHLY`, `fee_collector`, `ccip_fee_max_eth`, `isChainSupported`, `plan_id`, `bridge_fee`, `autopay_fee`,
    `late_window_seconds` or `max_group_size`. Tests A-61 to A-64 do not exist.
  - Re-checked on `cae2664` after 60 more agent commits: all of the above still holds. Those commits did apply the answers
    in `SPEC_ANSWERS_FOLLOWUP.md` (`contracts-v4`) and ran the live-model evaluation. Some of those answers were written
    against v1, for example SQ-D-15 on `expires_at`, a field v1.1 removes, so they need re-checking against v1.1.
- **Why it matters:** the agent is done for the spec it was built from, but today every `k` or `l` it sends would fail
  the §12.5 schema. Every other intent would too, because of `version` and the `i` shape.
- **Impact:** blocks Part 11 only. The wallet can be built against §12.5 fixtures.
- **Note:** §24 lists the code impact. `docs/spec/DECISIONS.md` D9 and D17 and `docs/spec/TESTED.md` and `docs/spec/TEST_MAP.md` describe the Flex status from before
  the lanes finished, so read those status lines as out of date.

### OQ-06: Where does the V-09c check run?

- **Conflict:** §11.1 V-09c makes the envelope → verified schema mapping an **agent S10** rule. §12.5 says the mapping is
  "done by the execution layer". S10 runs before `swap_back` (S12), though V-09c says "after `swap_back`". The agent has
  no zod schemas or translator.
- **Recommendation:** one shared package holding the schemas and translator, used by both layers. Otherwise the agent
  shows a summary for a plan the wallet will reject.
- **Blocks:** the shape of Part 1, and the agent v1.1 work.

## Behaviour the spec leaves open

### OQ-07: How is bridge arrival detected, and how long does the wallet wait?

- **Sources:** §14.2 rule 4 says a dependent step starts "only after the USDC has arrived". Rule 8 says success is the
  effect. A.6 says arrival time has never been measured. No detection method or timeout exists.
- **Options:** poll the destination USDC balance through the wallet's RPC, or track the CCIP message. Balance polling
  needs no extra provider, but an unrelated incoming transfer could look like arrival. Tracking may need a third-party
  API, which has privacy implications.
- **New (6 Nov):** the live USDC lanes burn and mint through Circle CCTP (F-7, F-8), so arrival may also depend on CCTP.
- **Needs first:** the real transfer in Part 0, to size the timeout. Forks cannot answer this.
- **Blocks:** Part 5.

### OQ-08: What happens to other steps when one fails?

- **Sources:** rule 2 says never start a step before its `depends_on` succeeded. Rule 8 says report every outcome. E3 has
  an independent step 2 next to a bridge-dependent step 1.
- **Gap:** must independent steps still run? Are never-started dependents reported as `failed`? §14.3 only has `executed`
  and `failed`.
- **Why it matters:** the agent counts `pending` DB6 rows toward the daily limit (V-15) with no expiry, so a step left
  unreported uses up limit for that day.
- **Recommendation:** run independent steps, and report never-started dependents as `failed`.
- **Blocks:** Part 2.

### OQ-09: How is `intentId` chosen, given it feeds the delegation salt?

- **Sources:** §14.2 rule 5 says `salt` = hash of the intent. `intentHash` hashes the whole intent including `intentId`,
  which `IntentSchema` requires to be a UUID. The envelope has no such field, and `flex.handoff.test.ts` uses
  `crypto.randomUUID()`.
- **Risk:** if a crash happens after signing and before the result is stored, a re-run with a fresh UUID produces a
  different `redeem`, so `AlreadyRegistered` does not fire and **two live plans can pay the same recipient**.
- **Recommendation:** derive the UUID from `request_id` + `step`, and persist the signed delegation before sending
  `register`.
- **Blocks:** Part 7.

### OQ-10: Which timestamp bounds does the caveat use?

- **DECIDED by test (6 Nov 2026):** `start_at - 1` and `end_at + 1`. The enforcer's bounds are exclusive, so the spec's literal values
  refuse a run at exactly the first or last second. See `test/chain/executor.test.ts`.
- **Conflict:** §14.2 and A.3 say `timestamp(afterThreshold: startAt, beforeThreshold: endAt)`. Every passing test
  (`register.v3.test.ts:38`, `e2e.v2.test.ts:36`) uses `afterThreshold: start - 1`.
- **Unknown:** the `TimestampEnforcer` source is not in `~/zkApi`, so its strictness at the boundary was not read. The
  tests pay at `start + 30`, so the exact-second case has not been exercised.
- **Why it matters:** the executor accepts a run at exactly `start_at` and exactly `slot + late_window_seconds`. If the
  enforcer is strict, those two moments would revert.
- **Next step:** read the enforcer at the deployed address and add both boundary tests. Then follow the tested `start - 1`
  or amend the spec.
- **Blocks:** Part 7.

### OQ-11: What if `start_at` passes before registration?

- **Sources:** V-09b checks `start_at > now` at S10, before the user answers the summary. `IntentSchema` rejects a start
  more than 300 s in the past. Signing and a `[j, k]` bridge wait both add delay. `register()` has no start check, so a
  late registration silently loses slot 0.
- **Gap:** reject with a report, or accept and lose a run? The promised `max_runs` and the summary would no longer match.
- **Recommendation:** fail the step and report it, so the user re-creates it. Never register a plan whose first slot has
  already gone.
- **Blocks:** Part 7.

### OQ-12: Is the 8-step plan limit intended?

- **Conflict:** `PlanSchema` has `.max(8)` steps. §12.5 has no limit, and A.2 does not list the rule. A request with 3
  bridges and legs on 6 weekdays passes the envelope and S10, then fails at the wallet.
- **Options:** raise the limit in `PlanSchema`, or add it to the agent's validation with its own message.
- **Provisional answer:** both. The limit is now 16 in the JSON schema and `PlanSchema`, and the agent should refuse larger plans
  before the summary. See C-3 in [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md).

### OQ-13: 52 weeks at the wallet, up to 520 in agent settings

- **Conflict:** §14.1 allows `autopay_max_weeks` 1–520. A.2 and `IntentSchema` cap at 52 weeks. A user who raises the
  setting gets a summary and then a wallet rejection.
- **Options:** cap the setting at 52, or lift the wallet limit. No test covers beyond 52.
- **Blocks:** nothing in the wallet; A.2 is implemented as written until decided.

### OQ-14: What reports autopay runs to the agent?

- **Sources:** §14.3 needs `autopay_payment` per run, and rule 8 puts reporting on the execution layer. CRE pays the runs
  in the cloud and cannot reach an agent on `127.0.0.1`. `Executed(intentId, slot, paid)` has no amounts or `request_id`.
- **Derived need:** a wallet-side watcher reading `Executed` per chain, joined with its own store.
- **Gaps:** (a) catching up after the wallet was off; (b) skipped slots have no report kind; (c) what triggers `ended`:
  last slot passed, or `end_at` passed; (d) retry when the agent is down; (e) no field carries the slot time, so
  `executed_at` must come from the block; (f) `autopay_payment` inserts rows with no duplicate check, so a resend after a
  lost `204` double-counts. DB6 already has `autopay_id` and `tx_hash`, which the agent could dedupe on.
- **Why it matters:** runs missed by the watcher are not counted in the daily limit (D-19).
- **Blocks:** Part 10.

### OQ-15: Which RPC and which address config does the wallet use?

- **Sources:** §6.1 config covers the agent. "Who runs the RPC and the ENS indexer" is `docs/spec/DECISIONS.md` open item 3. R1
  used Alchemy; `run.sh` notes Alchemy apps often lack Base and Arbitrum and falls back to public endpoints.
- **Needed fields regardless:** per chain RPC, executor address, deployment block, plus the A.1 and A.4 constants.
- **Blocks:** Parts 2 and 10.

## Deployment

### OQ-16: CRE access, forwarders and chain coverage

- **Partly answered (6 Nov 2026):** all three chains are supported, and the real forwarders are known (F-10 in the tracker). Deploy
  access is still open.
- **Sources:** deploy access not enabled (`RESULTS.md`). Every CRE run so far was on Sepolia. The only forwarder value on
  disk is `0x15fC6ae953E024d975e77382eEeC56A9101f9F88` in the old staging config, used with the simulator. Nothing
  confirms it is the production KeystoneForwarder. Nothing on disk gives one for Base Sepolia or Arbitrum Sepolia.
- **Needed:** `cre account access`; forwarder addresses from Chainlink's published list; confirmation that CRE supports
  writes on all three chains from one workflow, as A.1 expects.
- **Note:** `setForwarderAddress` is owner-only, so the executor can be repointed from simulator to production.
- **Blocks:** live parts of 6 and 9.

### OQ-17: Who is the operator?

- **Gaps:** who owns the executors (`Ownable(msg.sender)` controls the forwarder and workflow id, so that key can change
  who may trigger runs); the real `autopay.fee_collector` (the config has a placeholder); who funds CRE. The tested rules
  keep the owner from redirecting payments, but the owner can stop runs.
- **Blocks:** Part 6 deploy.

### OQ-18: Which simulation provider and capacity limit does the workflow use?

- **Sources:** A.3 step 4 says the cron simulates each due run. `eth_simulateV1` is proven on Alchemy Sepolia only. A.5
  rule 10 says more than ~14 due runs exceed 15 HTTP calls: "batch simulations or add a workflow". The old config uses
  `maxIntentsPerRun: 10`.
- **Gap:** provider for Base and Arbitrum; which of the two options; CRE's per-execution quotas for log reads and writes
  are not recorded in the sources.
- **Blocks:** Part 9.

### OQ-19: When does the 7702 upgrade happen?

- **Sources:** A.1 says one authorization per chain. The method is proven (`flow.ts:48`, `chain.ts`). The timing is not
  stated, nor what happens if the account is already delegated to other code.
- **Recommendation:** upgrade on first use per chain, inside the first signing flow, and refuse if the account points at
  anything other than `0x63c0…E32B`.
- **Blocks:** Part 3.

## Payroll

### OQ-20: How is the fee set for an autopay with a list of recipients?

- **Sources:** `fee` is one amount per run (§12.5). C-1 lets a run hold 50 recipients. A run with 2 recipients and a fee took 271 k to
  318 k gas (A.3). 100 USDC transfers took 3.91 M (B12), so 50 is roughly 2 M. This has not been measured on `IntentExecutorV3`.
- **Gap:** a flat fee could leave the operator paying for most of a large run. Nothing says who covers that.
- **Recommendation:** a base fee plus an amount per recipient, decided once the 50-recipient test gives a real gas number.
- **Blocks:** Part 7, for lists above one person.

### OQ-21: Where does the payroll list come from?

- **Sources:** §9.6 pays group members one shared amount. §1.3 says values from untrusted content need explicit confirmation and "can
  never fund an autopay".
- **Options:** (a) typed in the chat; (b) a pasted or uploaded list, confirmed row by row; (c) a saved list in settings.
- **Gap:** under the current rule, option (b) can't create recurring payroll unless confirming a row removes the untrusted tag.
- **Recommendation:** (b) for one-time payroll. Decide the recurring rule separately, because it weakens a safety rule.
- **Blocks:** the agent's R-2 work. The envelope doesn't change.

## Stale spec text: no decision needed

§0 settles these. Recorded so nobody builds from the old text.

| Where | Says | Follow |
| --- | --- | --- |
| §19 E1 | `version: "1"`, single `amount` and `recipient` on `i` | §12.5: `version: "2"`, `recipients[]` |
| §8.14 step 4 | DB6 rows per "§11.3 kinds" | §11.4 |
| §24, first list | `autopay_prefund`, `prefund`, `first_occurrence` | The v1.1 list below it, which removes them |
| `bridge.v2.ts` comments | Cancel looks up the delegation "in DB7"; "prefunded once" | §12.5 and A.3: read from `Registered`; no prefund |
| `flex.handoff.test.ts` | `delegationHash: x.plan_id` (marked "stand-in") | §12.5: hash of the delegation from `Registered` |
| §12.5, §10.2, §14.2 rule 5, §1.5 | `k` with one `recipient`; `l` with `recipient`; "group autopays" out of scope | [ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md) |
