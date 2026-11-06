# Part 0: Prerequisites and gates

**Goal:** clear what blocks the build, and get results for the checks the spec says are still pending.

**Spec:** Appendix A.6, §24 code impact, §6.1. **Depends on:** nothing.

## Tasks

| ID | Task | Source | Done when |
| --- | --- | --- | --- |
| W0-01 | Answer OQ-01, 02, 03, 04, 06 | [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md) | Answers recorded in that file |
| W0-02 | Decide who does the agent v1.1 work (OQ-05) | §24, evidence in OQ-05 | Owner named; agent work tracked separately |
| W0-03 | Run the CCIP fork suite: `cd ~/zkApi/ccipfork && bash run.sh` | A.6, `docs/spec/TEST_MAP.md` §6 | 9 tests have results in `results/fork.txt` |
| W0-04 | Use fork test 4 to confirm or change `bridge_buffer_pct` | A.6, D16 | 1:1 confirmed, or a new value given to the agent config |
| W0-05 | Request CRE deploy access: `cre account access` | `RESULTS.md`, A.6 | Access enabled, or a date from Chainlink |
| W0-06 | Fund one testnet wallet with ETH and USDC on all three chains | A.6 "needs a funded testnet wallet" | Balances visible |
| W0-07 | One real Sepolia → Base Sepolia USDC CCIP send; record arrival time | A.6 | Time recorded; input to OQ-07 |
| W0-08 | Verify the three USDC addresses against Circle's published list | §6.1 | Checked and noted |
| W0-09 | Move the lab sources from `lab.zip` into the chosen location | OQ-03 | Sources under version control |

## Facts about the fork run

- `results/fork.txt` holds only the first failure ("stack too deep" at `CcipLive.t.sol:225`). The test file changed after
  that result was written, which matches `docs/spec/TEST_MAP.md`: fix made, rerun pending.
- `forge`, `anvil`, `cre` and `bun` are installed on this machine.
- `run.sh` reads `ALCHEMY_KEY` from `../work1/.env`. No funds are needed for forks.

## Update after running it (6 Nov)

The suite needs `--via-ir` to compile, and **forks cannot show USDC arriving**: these lanes burn and mint through Circle
CCTP, and the simulator has no attestation to mint with. `bridge_buffer_pct` is therefore decided by the real send
(W0-07), not by test 4. The table below is the original intent. See F-1 to F-8 in [IMPL_TRACKER.md](IMPL_TRACKER.md).

## What each fork test decides

| Test | Result it gives | Used by |
| --- | --- | --- |
| 4 | USDC arrives 1:1, allowance 0, ETH spent = fee | `bridge_buffer_pct` (W0-04), Part 5 |
| 5 | Unified USDC, then one payment | Part 5 |
| 7 | Overpay on the live router | Part 5 fee rule |
| 8 | 7702 receiver with a gas limit | Part 5; the spec sends `gasLimit` 0 |
| 3, 6, 9 | ETH limits | Confirms `ETH_NOT_BRIDGEABLE` scope |

## Agent v1.1: what the wallet needs from it

This is a dependency only; the work is not part of this plan. The wallet needs the agent to:

1. Send the §12.5 envelope, `version: "2"`.
2. Accept the §14.3 report shape (`plan_id`, `executor_address`, `slot`, `amount`, `fee`, `bridge_fee_eth`).
3. Store `plan_id` in DB7, so that `l` can carry it.

The §24 list and the evidence in OQ-05 give the wider change. Until these land, Part 11 cannot start.

## Exit criteria

- Blocking decisions recorded.
- Fork results known and `bridge_buffer_pct` settled.
- CRE access status known. If it is still blocked, Parts 6 and 9 go ahead with the simulator, and the real-forwarder items
  stay open in Part 11.
