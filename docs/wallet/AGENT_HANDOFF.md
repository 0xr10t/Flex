# Hand-off to the agent team

Date: 6 November 2026. From: the wallet work on branch `wallet`.

## What we need

The wallet can't accept what the agent sends today. The agent sends envelope `version: "1"`, and the wallet accepts only
`version: "2"`, in the shape defined by `wallet/src/schemas/handoff-envelope.schema.json`.

Please move the agent to that envelope, and to the execution model behind it. Most of this is spec v1.1, which the code hasn't applied
yet. `docs/spec/AGENT_SPEC_v1.1.md` §24 lists that work. On top of v1.1, the wallet made a few more changes, explained in
[ARCHITECTURE_CHANGES.md](ARCHITECTURE_CHANGES.md).

**The main shift:** money stays in the user's wallet. There is no prefund, delegate account, per-autopay CRE job or refund. The user
signs one delegation per autopay leg, and one shared CRE workflow pays each run on a fixed interval.

## What doesn't change

- S0–S8, the prompts and the LLM schemas. The exception is the P5 rule, in the payroll phase.
- Recipient resolution and ENS (§9), apart from the indexer: this branch added `indexer_kind: "ensnode-omnigraph"` in `src/recipients/subnames.ts`, because ENSv2's indexer doesn't use the old subgraph query. The hosted endpoint currently fails TLS (F-15 in the tracker).
- `POST {execution.url}/v1/intents`, its headers and its response codes (§14.2).
- `src/handoff/execution-client.ts`.

## Differences from spec v1.1

Where these disagree with the spec, these win.

| Change | Field or rule | Agent action |
| --- | --- | --- |
| `k` pays a list | `recipient` + `amount_per_payment` become `recipients[]`, 1 to 50 | Send a one-item list for a normal autopay |
| `l` has no recipient | `recipient` removed | Don't send it |
| Step limit | At most 16 intents | Refuse larger plans at S10, before the summary |
| Canonical amounts | `value` has no leading or trailing zeros | Already done by `fromBaseUnits`; keep it |
| Time ceiling | `start_at` and `end_at` at most 4102444800 | Nothing, unless a schedule could reach year 2100 |
| One-time payments merge | Spec §10.2 says one recipient per `i` | Merge by chain and token; see Phase 1, item 5 |

## Phase 1: required for the wallet to work

Do these in order. This makes one-time payments, bridges, single-person autopays and cancels work.

### 1. Envelope and types

| File | Change |
| --- | --- |
| `src/schemas/handoff-envelope.schema.json` | Replace with the wallet's schema |
| `src/contracts/types.ts:311-430` | Remove `CreJob`. Update `PlanI`, `PlanK`, `PlanL` and the `Envelope*` types. `Schedule` in the envelope becomes UTC seconds |
| `src/schemas/internal-plan.schema.json` | Update; see `scripts/gen-internal-plan-schema.mjs` |
| `src/handoff/swap-back.ts` | Emit the new shape, `version: '2'` |

### 2. Database

| File | Change |
| --- | --- |
| `src/db/schema.sql` | DB6 kinds: remove `autopay_prefund`, add `bridge_fee` and `autopay_fee`. DB7: remove `delegate_address` and `cre_job_id`; add `plan_id`, `executor_address`, `fee`, `display_json` |
| `src/contracts/repos.ts:140,200-219`, `src/db/repos/db6.ts:68`, `src/db/repos/db7.ts` | Match the new columns and kinds |
| `src/plan/spendable.ts` | Pending kinds become `payment`, `bridge_out`, `bridge_fee` (§10.1) |

### 3. Reports from the wallet

| File | Change |
| --- | --- |
| `src/contracts/types.ts:705`, `src/server/bodies.ts:104` | Accept the §14.3 shape: `plan_id`, `executor_address`, `slot`, `amount`, `fee`, `bridge_fee_eth` |
| `src/server/reports.ts:47-51` | Store `plan_id` and `executor_address` on the DB7 row. Insert `autopay_payment` and `autopay_fee` rows. Set `bridge_fee` to the actual fee |

A list autopay's `autopay.amount` is the run's total paid to recipients, not counting the fee.

Reports the wallet now sends, which `validateReport` must accept:

| Report | Detail |
| --- | --- |
| A failed `k` or `l` | Carries `autopay.autopay_id` even when nothing was sent, so DB7 doesn't stay `pending` |
| A repeated `l` | `executed` with no `tx_hash`, when the plan was already cancelled |
| `autopay_payment` | Has no `step`. Each run is sent until the agent answers, so a lost `204` causes a resend (question 5 below) |
| `autopay_status` | `ended`, with `autopay_id`, `plan_id`, `executor_address`, `chain_id` and `token` |

### 4. Planning (S9)

| File | Change |
| --- | --- |
| `src/plan/schedule.ts` | Remove `cronFor` and `expiresAt`. Compute `start_at`, `interval_seconds`, `max_runs`, `late_window_seconds` and `end_at` (§10.6) |
| `src/pipeline/s9-plan.ts` | Add the per-run fee, `max_per_run` and `max_total`. The funding need is `max_total`. Remove prefund. Monthly asks `Q_AUTOPAY_MONTHLY` |
| `src/plan/bridges.ts` | USDC only: an ETH shortfall gives `ETH_NOT_BRIDGEABLE`. Add the lane check, which can give `BRIDGE_LANE_UNAVAILABLE` (§10.4). Add the CCIP fee to the gas check |
| `src/config/defaults.ts:18` | `bridge_buffer_pct` becomes `'0'`. The real value is still unproven, because the wallet's real bridge test hasn't run |
| `config.example.json`, config loader | Add `autopay` and `bridge`; add `max_group_size` (§6) |

### 5. One `i` per chain and token

| Rule | Detail |
| --- | --- |
| Group | One `i` with every selected member, replacing one `i` per member at `src/pipeline/s9-plan.ts:499`. Over `max_group_size`: `LIMIT_GROUP_SIZE` |
| Merge | After chains are chosen, combine `i` intents with the same `chain_id` and `token`. Their `depends_on` already match (§10.5) |
| Don't merge | When the same person appears twice, or the list would pass 100. Start another `i` |
| DB6 | Still one `payment` row per recipient (§11.4) |
| Summary | The current group template assumes one amount each. Merged payments with different amounts need a new line that lists each person and amount |

### 6. Validation (S10)

| Where | Change |
| --- | --- |
| `src/pipeline/s10-validate.ts:39,163,193` | Use `max_total`, `max_per_run` and the per-period check, which is no longer handed off |
| `src/pipeline/s10-validate.ts:126` | V-09 checks `plan_id`, not `delegate_address` |
| New | V-09a and V-09b from §11.1. A plan over 16 intents gets a new error, with its text in `src/contracts/catalog.ts` |
| New | V-09c runs the wallet's check. Where it lives depends on question 2 below |

### 7. Summary and hand-off (S11, S12)

| File | Change |
| --- | --- |
| `src/messages/templates.ts:25,27` | Remove "Sets aside" and "refund". Use the §13.1 wording: the money stays in the wallet, and nothing is refunded |
| `src/messages/summary.ts:124,136` | No `first_occurrence` or `total_cap` from the old shape |
| `src/pipeline/s12-handoff.ts:74-78` | `k` writes no DB6 row, only a DB7 `pending` row. `j` also writes a `bridge_fee` row (§11.4) |

### 8. Tests

Seventeen test files use v1 terms, including `test/unit/D/handoff.test.ts`, `plan.test.ts`, `validate.test.ts` and `schedule.test.ts`,
and the acceptance fixtures. Add A-61 to A-64 from §20, which don't exist yet.

## Phase 2: payroll

Start this after question 4 below is answered. Phase 1 doesn't depend on it.

| Change | Where |
| --- | --- |
| Per-member amounts for a group, from a list of ENS name and amount | S8, S9. The source is question 4 |
| **Required:** each member can have their own amount, in ETH or USDC | S8, S9, summary, `Q_GROUP_MEMBERS`. Each `recipients[]` entry already has its own amount |
| Allow a group on `k`, up to 50 members | `src/plan/pairing-checks.ts:152`. Over 50 gives `LIMIT_GROUP_SIZE`; `GROUP_AUTOPAY_UNSUPPORTED` goes away |
| One `k` carries the whole list. Each weekly leg still gets its own `k` | `src/pipeline/s9-plan.ts`, §10.6 |
| V-14 per member; `per_period_cap` from the total; the summary lists everyone | `src/pipeline/s10-validate.ts`, `src/messages/` |
| DB7: move recipients to a child table keyed by `autopay_id` | `src/db/schema.sql`, repos |
| `find_autopays` finds an autopay by any of its recipients. Cancelling cancels the whole plan | §10.7 |

Before this ships, users need to know that recurring payroll makes everyone's pay public when the plan is registered.

## Example envelopes

Each of these passes the wallet's `checkEnvelope`. Their `start_at` is 1 January 2027, so update it if that has passed. `l` also needs the
wallet to read the delegation from the chain, so that check used a test hash.

**One-time, one or many people, with a bridge first (`j` + `i`)**

```json
{
  "version": "2",
  "request_id": "req_0123456789ab",
  "wallet_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "created_at": "2026-11-06T10:00:00Z",
  "intents": [
    {
      "intent_id": "j",
      "step": 0,
      "token": "USDC",
      "source_token_address": "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
      "dest_token_address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "source_chain_id": 421614,
      "dest_chain_id": 84532,
      "amount": {
        "value": "10",
        "base_units": "10000000",
        "decimals": 6
      },
      "receiver": "self",
      "fee_max_eth": "0.002",
      "funds_steps": [
        1
      ]
    },
    {
      "intent_id": "i",
      "step": 1,
      "depends_on": [
        0
      ],
      "token": "USDC",
      "token_address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "chain_id": 84532,
      "recipients": [
        {
          "recipient": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
          "amount": {
            "value": "10",
            "base_units": "10000000",
            "decimals": 6
          }
        },
        {
          "recipient": "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
          "amount": {
            "value": "20",
            "base_units": "20000000",
            "decimals": 6
          }
        }
      ]
    }
  ]
}
```

**Autopay, one or many people (`k`)**

```json
{
  "version": "2",
  "request_id": "req_0123456789ab",
  "wallet_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "created_at": "2026-11-06T10:00:00Z",
  "intents": [
    {
      "intent_id": "k",
      "step": 0,
      "depends_on": [],
      "autopay_id": "ap_0123456789ab",
      "token": "USDC",
      "token_address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "chain_id": 84532,
      "recipients": [
        {
          "recipient": "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
          "amount": {
            "value": "10",
            "base_units": "10000000",
            "decimals": 6
          }
        },
        {
          "recipient": "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
          "amount": {
            "value": "20",
            "base_units": "20000000",
            "decimals": 6
          }
        }
      ],
      "fee": {
        "to": "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
        "amount": {
          "value": "0.05",
          "base_units": "50000",
          "decimals": 6
        }
      },
      "schedule": {
        "start_at": 1798761600,
        "interval_seconds": 604800,
        "max_runs": 8,
        "late_window_seconds": 3600,
        "end_at": 1802998800
      },
      "limits": {
        "max_per_run": {
          "value": "30.05",
          "base_units": "30050000",
          "decimals": 6
        },
        "max_total": {
          "value": "240.4",
          "base_units": "240400000",
          "decimals": 6
        }
      },
      "executor": "chainlink-cre"
    }
  ]
}
```

**Cancel (`l`)**

```json
{
  "version": "2",
  "request_id": "req_0123456789ab",
  "wallet_address": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "created_at": "2026-11-06T10:00:00Z",
  "intents": [
    {
      "intent_id": "l",
      "step": 0,
      "autopay_id": "ap_0123456789ab",
      "chain_id": 84532,
      "plan_id": "0xabababababababababababababababababababababababababababababababab"
    }
  ]
}
```

## Done when

- [ ] Every envelope produced by the acceptance tests passes the wallet's `checkEnvelope`.
- [ ] The envelopes above can be produced by the agent, field for field apart from ids, time and placeholder addresses.
- [ ] A test for 10 to Alex and 20 to Bob on one chain gives one `i` with two recipients.
- [ ] A plan with 17 intents is refused before the summary.
- [ ] A-61 to A-64 pass.
- [ ] `src/` no longer contains `prefund`, `cre_job`, `delegate_address`, `refund_remaining`, `per_period_cap` as an envelope field, `total_cap` or
      `expires_at`.
- [ ] The existing agent suite is green. Today it has 1678 tests.

Agent-to-wallet testing on a real chain comes later (`IMPLEMENTATION_PLAN.md`, M3), because the wallet can't sign or send yet.

## Earlier answers still apply

The human answers in `docs/agent/SPEC_QUESTIONS.md` and `SPEC_ANSWERS_FOLLOWUP.md` were written against v1, and spec v1.1 doesn't include
them. Please keep them, except where the field they discuss no longer exists.

| Answer | What to do |
| --- | --- |
| SQ-D-16 `Q_LIMIT_OVERRIDE` | Keep. It conflicts with the v1.1 text, which still names `Q_GROUP_OVER_LIMIT`, but it is the later, human-approved behaviour. Please confirm |
| SQ-D-15, SQ-O-02 `expires_at` | No longer applies. The field is gone |
| The rest | Please re-check any that mention prefund, `cre_job` or `expires_at` |

## Questions for the agent team

| # | Question | Our suggestion | Blocks |
| --- | --- | --- | --- |
| 1 | Who owns this work, and when can it start? (OQ-05) | One named owner | Everything end to end |
| 2 | Where do the schemas and `checkEnvelope` live, so S10 can run V-09c? (OQ-06) | One shared package. Otherwise the agent can show a summary for a plan the wallet refuses | Phase 1, item 6 |
| 3 | Is there any DB7 or DB6 data to keep, or can these tables be recreated? | Recreate, if it's only test data | Phase 1, item 2 |
| 4 | Where does the payroll list come from? V-08 and §1.3 stop document values from funding an autopay (OQ-21) | Pasted or uploaded list, confirmed row by row, for one-time payroll. Decide recurring separately | Phase 2 |
| 5 | Can reports dedupe on `autopay_id` + `tx_hash`? A resent `autopay_payment` currently double counts toward the daily limit (OQ-14) | Yes | Phase 1, item 3 |

## What the wallet side provides

- **Available now:** the schema, `checkEnvelope` and the verified schemas, in `wallet/`. Run `npm install && npm test` there.
- **Later:** `POST /v1/intents` and the reports (`IMPLEMENTATION_PLAN.md`, M1). Until then, keep using the fake execution layer.
- **Changes to the envelope:** we'll tell you first. Nothing has shipped on v2, so it can still change if something here doesn't work for you.
