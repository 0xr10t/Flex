# Spec questions — Lane D

Format: id · section · question · what the code does now.

**SQ-D-01** · §10.6 `time_of_day` "Chrono time in the clause"
A chrono span of kind `end` can carry a time ("until Friday 5pm"), which is not a time of day for the payment.
*Now:* the first span in the clause with a time whose kind is not `end`; else `defaults.autopay_time_of_day`.

**SQ-D-02** · §13.1 group line vs §19 E4
The template `Send {amount} {token} each to {count} members of {parent} on {Chain}: {name1}, {name2}, …` has no final
period; the E4 example ends with one.
*Now:* ends with a period, as in E4.

**SQ-D-03** · §13.1 `i` line " After step {n}."
An `i` can depend on several `j` steps; the template has one `{n}`.
*Now:* step numbers joined like other lists: "After step 1 and 2.".

**SQ-D-04** · §13.1 `{cadence}` "on the {d}th of every month"
Taken literally the 1st reads "1th".
*Now:* English ordinals (1st, 2nd, 3rd, 4th, …), which give the spec's own "28th".

**SQ-D-05** · §10.7 step 3 chip "10 USDC weekly on MON, Base Sepolia, since 2026-11-10"
Only a weekly example is given.
*Now:* `daily`; `weekly on MON, THU`; `monthly on day 15`.

**SQ-D-06** · §10.6 `end` "for N payments" with N > 520
§12.5 and `Q_AUTOPAY_COUNT` cap the count at 520. When N > 520 is still within `autopay_max_weeks`, nothing is specified.
*Now:* over the duration limit → `LIMIT_AUTOPAY_DURATION`; otherwise `UNSUPPORTED_REQUEST`.

**SQ-D-07** · §17.2 step 7 follow-up note
"Recipient and chain from your last payment." is unconditional, but on "send 5 more on arbitrum" the chain is not from the
last payment.
*Now:* the note is shown for every follow-up payee, as the spec says.

**SQ-D-08** · §10.3 rule order, states with no reply
(a) A group payment whose S8 `chain` differs from the group's chain: rule 2 would pick a chain the members were not resolved
on. (b) An ENS-pinned recipient paired with a relative amount pinned to another chain and no stated chain.
*Now:* both → `UNSUPPORTED_REQUEST` (rule ids `S9_GROUP_CHAIN_VS_STATED`, `S9_TWO_PINS`).

**SQ-D-09** · §14.2 4xx without a usable `message`
*Now:* `EXECUTION_REJECTED` with the message `HTTP <status>`.

**SQ-D-10** · §13.1 note "From attached content: {what}. You confirmed it."
`{what}` has no wording in §13.1; §19 E9 shows "From attached content: 120 USDC to 0xAAAA…1111. You confirmed it."
*Now:* as E9: one note per `i`/`k` payment that uses an untrusted amount or recipient, `{what}` =
`{amount} {token} to {short address}`.

**SQ-D-11** · §13.1 `{end text}` "for {n} payments" with n = 1
*Now:* the template as written: "for 1 payments".

**SQ-D-12** · §13.1 " After step {n}." on the `k` and group lines
The suffix is only on the `i` row; a `k` or a group can also depend on a bridge.
*Now:* as written: no suffix on those lines.

**SQ-D-13** · §13.1 footer "one line per token used"
A plan with only `l` intents moves no token.
*Now:* tokens of `i`, `j`, `k` intents; an `l`-only plan has no footer (E7 shows none).

**SQ-D-14** · §10.5 rule 2 "the first payment that needs their destination chain"
The rule does not say whether "needs" is per token.
*Now:* same token and destination chain.

**SQ-D-15** · §19 E6 `expires_at` vs §10.6 derived 8
"every friday for 8 weeks" from Thu 2026-11-05: §10.6 puts `expires_at` at 23:59:59 on the last occurrence date
(Fri 2026-12-25 → `2026-12-25T18:29:59Z`); §19 E6 shows `2026-12-31T18:29:59Z` (the `on_date` end).
*Now:* the §10.6 rule (last occurrence date); the end date and summary still read "until 31 Dec 2026".

**SQ-D-16** · §19 E9 vs V-13 with the default limits
The E9 invoice is 120 USDC, above the default `per_tx_max` USDC 100, so V-13 ends E9 with `LIMIT_PER_TX`; §19 does
not mention it.
*Now:* V-13 as written (`LIMIT_PER_TX`). Tests also run E9 with `per_tx_max` raised.

**SQ-D-17** · §9.5 "Recipients pinned by ENS (§9.3 step 6) are never reused on another chain"
A saved ENS contact (`source='contact'`, DB2 rows only on the chains where its record resolved, no `Q_ENS_CHAIN` pin in
this request) can still be silently reused on another stated chain or by §10.3 rule 4.
*Now:* only a recipient pinned in this request (DB3 `chain_id`, the `Q_ENS_CHAIN` choice) is never reused; saved ENS
contacts follow §10.3 rule 4 / §9.5 like any contact.

**SQ-D-18** · §14.2 contract 4 / §10.6 weekly `interval > 1`
"weeks since `schedule.first_occurrence`" can mean 7-day blocks from the first occurrence or calendar weeks.
*Now:* 7-day blocks from the first occurrence's date (occurrence enumeration for limits and caps).
