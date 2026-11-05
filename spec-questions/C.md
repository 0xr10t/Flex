# Lane C spec questions

Format: **SQ-C-nn** · section · question · what the code does now. A "Now" path that is a true gap returns
`UNSUPPORTED_REQUEST` (spec §0) and logs `event: "unsupported_state"` with a `rule_id` (SQ-19).

**SQ-C-01** · §9.3 step 3, §14.5 "a failure … fails the ENS lookup for S6"
The ENS RPC call (`getEnsAddress`) fails or times out while a payee's ENS name is being resolved. This is not a saved
contact's re-check, which §9.4 covers. The spec says the lookup "fails" but gives no error code, question or reply.
*Now:* `UNSUPPORTED_REQUEST`, `rule_id: "ens_lookup_unavailable"`. Group members are different: §9.6 step 6 makes an
unresolvable member "can't pay", and the code does that.

**SQ-C-02** · §9.4 ENS re-check table, row "Different address"
A contact saved on several chains is re-resolved per chain, and two chains now return two *different* new addresses.
`Q_ENS_CHANGED` names one new address ("now points to 0xNEW…").
*Now:* `UNSUPPORTED_REQUEST`, `rule_id: "ens_recheck_several_new_addresses"`. When one new address comes back on some
chains and the saved address or no address on the others, the code asks `Q_ENS_CHANGED` with that one new address.

**SQ-C-03** · §9.4 "Use new address (update the address on all of this name's DB2 rows, then continue)" vs the §7.1
invariant (one name per address, D-11)
The new address is already saved in DB2 under a different contact name, so the update would break the invariant.
*Now:* `UNSUPPORTED_REQUEST`, `rule_id: "ens_new_address_saved_under_other_name"`; DB2 is unchanged.

**SQ-C-04** · §9.6 step 2 `Q_GROUP_CHAIN` "chips: allowed ok chains"
No allowed chain has status `ok` in DB4 for this request, so there is no chip to offer.
*Now:* `UNSUPPORTED_REQUEST`, `rule_id: "group_chain_no_ok_chain"`.

**SQ-C-05** · §9.2 step 5, untrusted address → "No, re-enter" → `Q_ADDRESS_REENTER`
After the user re-enters an address for a document payee, is the new address still "from the attached content"?
*Now (a reading of the spec, not a gap):* the re-entered address or ENS name is typed by the user. The next
`Q_ADDRESS_CORRECT` has no content wording and no "Don't pay this one" chip, and the contact is resolved with
`source = 'user'` (or `'ens'`). Please confirm.

**SQ-C-06** · §9.2 steps 1–2 "re-ask" for an address typed in the *message* (not in an answer)
An address payee in the prompt has a bad EIP-55 checksum or is the zero address. There is no question yet to re-ask.
*Now (a reading of the spec):* `Q_ADDRESS_REENTER` at attempt 1, with the quoted hint before the question text
("That address has a typo: its checksum doesn't match. Paste the address."). Please confirm.

**SQ-C-07** · §9.3 step 3 / §9.6 step 2 "exactly one chain word"
Does "exactly one chain word" count words or chains? For example, "on base … base sepolia" is two words but one chain.
*Now:* distinct chains; several words naming the same chain count as one.

**SQ-C-08** · §17.2 step 4 "S9 uses that payee's previous chain"
`db8_history.payments_json` holds "the S8 payments (placeholders only)", whose `chain` may be `"unstated"`. The chain
S9 actually chose is then not in that JSON.
*Now:* S7 takes the previous chain from the most recent history entry that names the placeholder: a numeric `chain_id`
(plan intent) or a numeric `chain` (S8 payment). `"unstated"` gives `last_chain_id = null`. Lane D should write the
resolved chain into each history item (see the lane report, "Needs from other lanes").

**SQ-C-09** · §9.6 step 9 `Q_GROUP_MEMBERS` "every payable member preselected"
The §13.4 chip shape (`id`, `label`, `disabled`, `detail`) has no "selected" flag, so preselection cannot be sent.
*Now:* every enabled chip is meant to be preselected; disabled chips are the unpayable members. The UI team must
preselect all enabled chips of a `multiselect` question (or the contract needs a `selected` flag). Please confirm.
