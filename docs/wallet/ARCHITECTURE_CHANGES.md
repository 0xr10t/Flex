# Changes from the agent architecture

Date: 6 November 2026. Branch: `wallet`.

This file records where the wallet's design differs from the agent layer, and why. It covers three versions of the design:

| Name | Where | State |
| --- | --- | --- |
| Agent code | `src/`, as on `origin/agentic_layer` (`cae2664`) | Running code. Sends envelope `version: "1"` |
| Spec v1.1 | `docs/spec/AGENT_SPEC_v1.1.md` | Corrected to what was tested onchain. Defines envelope `version: "2"` |
| This file | `wallet/src/schemas/handoff-envelope.schema.json` | Spec v1.1 plus the changes in Part A |

**Where they disagree, this file wins over spec v1.1, and spec v1.1 wins over the agent code.**

**Status:** the changes in Part A are applied and tested on the wallet side only. They have not been agreed with whoever owns
the agent layer (OQ-05), and no agent code has changed. The envelope stays `version: "2"`, because nothing has ever sent or
accepted a real v2 envelope, so no released version needs protecting.

## Part A: changes made here

### Changes to the JSON schema

| Id | Field | Spec v1.1 | Now |
| --- | --- | --- | --- |
| C-1 | `k` payees | `recipient` + `amount_per_payment` | `recipients[]`, 1 to 50, each with its own amount |
| C-2 | `l` | Has `recipient` | Field removed |
| C-3 | `intents` | No limit in the JSON schema; `PlanSchema` limit of 8 | `maxItems` 16 in both |
| C-4 | `amount.value` | `^[0-9]+(\.[0-9]+)?$` | `^(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?$` |
| C-5 | `unixTime` | Minimum only | Maximum 4102444800 (1 January 2100 UTC) |

#### C-1: `k` pays a list

**Why:** recurring payroll can't work with one `k` per person.

- Appendix A.5 rule 10: more than about 14 autopays due in one cron run exceed CRE's 15 HTTP calls. A payroll of 50 would be
  50 plans due at the same moment.
- Each `k` needs its own delegation and `register` transaction, and the user approves each one (OQ-01). That is 50 approvals.
- Separate plans can pay some people and not others in the same run.
- It was also refused by the step limit (C-3).

**Why this is a small change:** the layers below already support it. `IntentSchema` allows 50 automated recipients, sized from
test B12 (50 USDC transfers make a 27.3 KB report; 100 make 52.9 KB, over CRE's 50 KB limit). `executionsOf` already builds every
recipient plus the fee as one batch, and test V ran 2 recipients plus a fee through `IntentExecutorV3`. Only the envelope allowed
just one person. `docs/spec/DECISIONS.md` lists "autopay groups" as still open.

**A normal autopay** is a list of one.

**What we give up:**

- A run pays everyone or no one. If the balance is short, nobody is paid that run.
- Removing one person means cancelling the plan and creating a new one. This matches the existing rule for edits (D5).
- All recipients and amounts become public together when `Registered` is emitted (§16.2). For payroll this publishes everyone's
  pay and links them to one employer. One-time payroll also shows each payment onchain, but a registered plan shows future pay
  as well.

**Tested on a local chain, with a mock USDC:** 50 recipients through `register` and a run on `IntentExecutorV3`: 513 k gas to
register, 2.15 M for the first run, 1.29 M for later runs, and a 27.9 KB report. All are within CRE's limits (F-9). Not yet run on a
testnet, through the real forwarder, or with real USDC.

**New question:** the fee is one amount per run, but gas grows with the list. See OQ-20.

#### C-2: `l` has no `recipient`

**Why:** `plan_id` already identifies the plan, and the wallet never read this field. It wasn't checked either: a zero address or
a bad checksum passed, because the verified `CancelSchema` has no such field. With C-1 a plan can have many recipients, so one
field would be misleading. Removing it also sends one less address across the hand-off.

#### C-3: up to 16 steps

**Why:** 8 was too low, and only the wallet knew about it. The spec has no such limit (OQ-12), so the agent could show a summary,
get a "yes", and then be refused. Valid requests go over 8: 3 bridges plus 6 one-time payments (3 chains × 2 tokens) is already 9.

**Why 16:** 3 bridges + 6 one-time payments + 7 autopay legs, one per weekday, as a ceiling (the spec turns 7 days a week into a daily
schedule, so 6 legs is the usual maximum). A test builds exactly this plan. It's a derived
ceiling, not a tested capacity limit, and it's easy to change: a test keeps the JSON schema and `PlanSchema` equal.

#### C-4: one spelling for each amount

**Why:** the spec already says "`value` has no trailing zeros" (§12.5), but nothing enforced it. `value` goes into `intentHash`,
which becomes the delegation's salt, so `10.5` and `10.50` would produce different plans for the same payment. Leading zeros
(`010`) were already refused, but only at the later stage, with a less precise message.

#### C-5: timestamps have an upper bound

**Why:** this fixes a bug. A very large `start_at` or `end_at` passed the schema, then `toISOString()` threw a `RangeError` during
mapping. That would become a 5xx, and §14.2 treats a 5xx as "retry", so a bad request would be retried instead of refused. It is
now a normal 4xx rejection.

### Changes to agent behaviour, with no schema change

These are not implemented. The wallet already accepts their output.

#### R-1: merge one-time payments

Spec §10.2 says every `i` that isn't a group has exactly one recipient. So "10 to Alex and 20 to Bob" is two transactions.

**Change:** after chains are chosen, combine `i` intents with the same `chain_id` and `token` into one `i`. Their `depends_on`
already match, because §10.5 derives it from chain and token. Keep a separate `i` when the same person appears twice, because
`IntentSchema` refuses duplicates, or when a list passes 100.

**Why:** one approval, one transaction, lower gas, and no half-paid request. It also keeps plans well under the step limit.

**What we give up:** one failing transfer stops everyone in that `i`. The sender's address already links these payments onchain,
so there's little privacy cost. Merging is the default for now and the user isn't asked each time. This is provisional.

#### R-2: per-member payroll amounts

Spec §10.2 pays every group member the same amount. Payroll needs each person's own amount.

**Change:** let the agent take a list of ENS name and amount. ENS supplies only the addresses. No envelope change is needed.

**Decided by the user (6 Nov 2026):** members need not get the same amount, so this is required, for ETH as well as USDC.

**Not decided (OQ-21):** where the list comes from. The spec's rule that values from a document "can never fund an autopay"
(§1.3) would block a payroll file from creating recurring payroll.

Amounts should not come from ENS text records: they're public, and the spec treats them as untrusted.

**Limits to expect:** `per_tx_max` is 100 USDC per payment by default and `autopay_max_per_period` is 100 USDC per 7 days. Both are
user settings, and the agent's `Q_LIMIT_OVERRIDE` can lift a limit once (SQ-D-16), but real payroll will hit them.

#### R-3: the check before signing

**Change:** this replaces "Not in this plan: simulating a hand-off". A decoder and `eth_simulateV1` run together on every transaction, in the wallet, before approval. The intent, the decoded bytes and the simulated result must all match, or nothing is signed. If simulation isn't available, the payment stops.

**Why:** the decoder catches a batch built wrongly. The simulation catches one that looks right and does nothing.

**What we give up:** a payment now depends on the RPC offering `eth_simulateV1`, so an outage or a provider without it stops payments. It also shows the RPC what you're about to do, before you've approved it.

**What it can't show:** a bridge's arrival, or a balance that drops after a check. It also still trusts the RPC's answer.

**Still to do at the agent:** nothing for this check. Simulating at the summary stage would be separate work.

## Part B: changes from spec v1.1 the agent code hasn't applied

These aren't new decisions. Spec v1.1 corrected the design to match what was tested onchain, and the code still follows v1.

| Area | Agent code (v1) | Spec v1.1 | Why |
| --- | --- | --- | --- |
| Envelope | `version: "1"` | `version: "2"` | Marks the new shape |
| `i` | One `amount`, one `recipient` | `recipients[]` | D6: a group is one all-or-nothing transaction |
| Groups | One `i` per member (`src/pipeline/s9-plan.ts:499`) | One `i`, at most 100 | D6: a failure can't leave a group part paid |
| `j` | No fee field | `fee_max_eth` | D16: the fee is quoted and capped |
| `k` funding | `prefund`, delegate account | No prefund; money stays in the wallet | D4: no scattered balances or refunds that can fail |
| `k` trigger | `cre_job` per autopay, calendar cron | One shared workflow, fixed interval, late window | D9, D11 |
| `k` caps | `per_period_cap`, `total_cap`, `expires_at` | `max_per_run`, `max_total` | D5: enforced by the signed exact batch |
| `k` fee | None | `fee {to, amount}` in the batch | D12 |
| `l` | `delegate_address`, `refund_remaining` | `plan_id`, no refund | D13: nothing to refund |
| `bridge_buffer_pct` | `2` (`src/config/defaults.ts:18`) | `0` | D16. Not settled until a real send (W0-04, F-7) |
| DB6 | `autopay_prefund` kind | `bridge_fee`, `autopay_fee` kinds | §24 |
| DB7 | `delegate_address`, `cre_job_id` | `plan_id`, `executor_address`, `fee`, `display_json` | §24 |
| New errors | None | `ETH_NOT_BRIDGEABLE`, `BRIDGE_LANE_UNAVAILABLE`, `LIMIT_GROUP_SIZE`, `Q_AUTOPAY_MONTHLY` | §24 |

The S0–S8 steps, the prompts and the recipient resolution in §9 did not change in v1.1.

## Part C: deliberately not changed

| Item | Why it stays |
| --- | --- |
| The four intents `i`, `j`, `k`, `l` | Together they express every request type we need |
| Monthly or calendar-date schedules | `interval_seconds` is fixed, and the contract works on intervals. This needs a signed list of dates, so it's a separate design. "Every 30 days" is available meanwhile |
| More than 100 in one `i`, or 50 in one `k` | 100 is sized from gas and 50 from the CRE report limit. Splitting would end all-or-nothing |
| A payment waiting on another payment or a cancel | `depends_on` only points at bridges. Failure handling is OQ-08 |
| Bridging ETH | D15: no WETH pool from Base Sepolia |
| 52-week cap | OQ-13 is still open |
| Fields that aren't onchain data, such as names | D1: the envelope stays limited to what the chain needs |

## Part D: what the agent must change

The version to send to the agent team, with file locations and examples, is [AGENT_HANDOFF.md](AGENT_HANDOFF.md). In order. None of this has been started, and an owner is needed (OQ-05).

| # | Change | Where | From |
| --- | --- | --- | --- |
| 1 | Replace the envelope schema with the wallet's | `src/schemas/handoff-envelope.schema.json` | B, A |
| 2 | Emit the new envelope | `src/handoff/swap-back.ts`, `src/contracts/types.ts`, `internal-plan.schema.json` | B, C-1, C-2 |
| 3 | Apply the DB6 and DB7 changes, and store `k` recipients in a child table keyed by `autopay_id` | `src/db/schema.sql`, repos | B, C-1 |
| 4 | Accept the new report shape and store `plan_id` | `src/server/reports.ts` | B |
| 5 | Add the schedule, fee and caps; remove prefund and `cre_job` | `src/plan/schedule.ts`, `src/pipeline/s9-plan.ts` | B |
| 6 | One `i` per group; merge one-time payments; set `bridge_buffer_pct` | `src/pipeline/s9-plan.ts`, `src/config/defaults.ts` | B, R-1 |
| 7 | Refuse plans over 16 steps before the summary, with a new error | `src/pipeline/s10-validate.ts`, `src/contracts/catalog.ts` | C-3 |
| 8 | Keep sending canonical amounts. `fromBaseUnits` already does; a contract test should hold it there | `src/contracts/money.ts` | C-4 |
| 9 | Allow a group on `k` up to 50 members; apply V-14 per member; update the summary and `Q_AUTOPAY_PICK` | `src/plan/pairing-checks.ts:152`, `src/pipeline/s10-validate.ts`, `src/messages/templates.ts` | C-1 |
| 10 | Per-member payroll amounts | Depends on OQ-21 | R-2 |

Steps 1–8 are enough for examples 1–3, and for a one-person autopay using a one-item list. Steps 9 and 10 add payroll.

§14.3 also needs one clarification: for a list autopay, `autopay.amount` is the run's total paid to recipients, not counting the
fee.
