# Spec questions — Lane A (Platform)

Format: **SQ-A-nn** · section · question · what the code does now · status.
Until the Orchestrator or the human answers, the code follows the stated interim behaviour.

**SQ-A-01** · §14.1 `POST /v1/sessions/{id}/cancel`, §17.3 row 3
`cancel` "cancels the active request". The spec gives no outcome when there is no request to cancel: no active request,
a `request_id` that is not the active request, or an active request that already ended (`ANSWERED`, `HANDED_OFF`,
`DISCARDED`, `FAILED`). `/answers` (stale `question_id`) and `/confirm` (wrong state) are given 409; `/cancel` is not.
*Now:* HTTP 200 with an `AgentResponse` of `state: "error"`, `error.code = "UNSUPPORTED_REQUEST"` (§0), the given
`request_id` echoed, and a log line `event: "unsupported_state"`, `rule_id: "cancel:no_active_request"`. Nothing is
changed. A request that is `HANDOFF_FAILED` counts as active and is cancelled (→ `DISCARDED`, reply `CANCELLED`).
*Status:* OPEN. Options: (a) keep; (b) 409 as for `/confirm`; (c) 200 with `CANCELLED` (idempotent).

**SQ-A-02** · §14.1 `PUT /v1/settings/limits` validation
§14.1 lists: amounts positive decimals; `allowed_chain_ids` ⊆ configured chains, non-empty; `autopay_max_weeks` 1–520;
`max_bridges_per_request` 0–10; `bridge_buffer_pct` 0–20. It does not say:
(a) whether an amount may have more fractional digits than its token (USDC 6, ETH 18);
(b) which keys `eth_gas_reserve` must have;
(c) whether `allowed_chain_ids` may repeat an id;
(d) whether `bridge_buffer_pct` is a decimal string (as in §6.3, `"2"`) or a number;
(e) whether unknown keys are accepted.
*Now:* (a) rejected (`must have at most N decimal places`; such an amount could not be stored in DB1 or handed off);
(b) keys must be configured chain ids, every allowed chain must have one, each value a positive ETH decimal string;
(c) rejected; (d) decimal string, as in §6.3; (e) rejected (`unknown key`); every §6.3 key is required ("Full limits
object"). Invalid → 400 `{ statusCode, error, errors: [{ field, message }] }`.
*Status:* OPEN (confirm the interim choices).

**SQ-A-03** · §17.3 table, §8.14 step 6, §14.1 `/confirm` — a `messages` call while the request is `HANDOFF_FAILED`
§17.3 says what `HANDOFF_FAILED` does with `confirm` yes (retry S12). It has no row for a `messages` call in that state:
neither text such as "yes" (the `EXECUTION_UNAVAILABLE` message says "Confirm again to retry"), nor a cancel text, nor
any other text (a new request?).
*Now:* a cancel text (§17.3 list) cancels the request like the cancel endpoint (`DISCARDED`, reply `CANCELLED`). Any
other text → `UNSUPPORTED_REQUEST` (§0), logged as `rule_id: "handoff_failed:message"`; the request stays
`HANDOFF_FAILED`, so `confirm` yes can still retry it and `cancel` can still drop it.
*Status:* OPEN. Options: (a) keep; (b) treat it like `AWAITING_CONFIRMATION` (yes texts retry, no texts discard,
other text discards and starts a new request with the "dropped the previous plan" line); (c) any text abandons the
failed hand-off and starts a new request.

**SQ-A-04** · §14.3 `intent_result` on a `k` / `l` step
§14.3 says what happens to "the DB7 row" of a `k` or `l` step but not how the row or the step's kind is identified, nor
what a failed `l` step does ("or `failed`" is given only for `k`). §11.4: an `l` intent writes no DB6 row and DB7 holds
only the row of the original `k`, so the `request_id` of a pure `l` request is stored nowhere.
*Now:* the row is the one named by `autopay.autopay_id`. Created by this `request_id` → `k` step (`executed` needs
`delegate_address`, else 400; `failed` → DB7 `failed`). Created by another request → `l` step (`executed` → `cancelled`;
`failed` → row unchanged, the autopay is still running). A known `autopay_id` is enough for a request id that has no
row (an `l` request can be checked no other way). A report without `autopay` updates DB6 only; if the request has no
rows at all → 404.
*Status:* OPEN (confirm).

**SQ-A-05** · §7.4, §14.1 `DELETE /v1/sessions/{id}`, §17.1 — closing a leftover session id while another session is open
A crashed process leaves its row in `db8_sessions`, and §7.4 clears every row on any close. §14.1 gives 404 only for an
unknown id. Closing the leftover id would delete the rows of the session that is open now.
*Now:* with a session open, any other id → 404, nothing cleared (the next close wipes the leftover, §7.4). With no session
open, a leftover id → clears, 204.
*Status:* OPEN (confirm).

**SQ-A-06** · §8.14 step 6, §15 `EXECUTION_UNAVAILABLE` — the message after the third failed hand-off
The only catalogue text is "I couldn't reach your wallet. Confirm again to retry." After the third failure the request is
`FAILED` and `confirm` → 409, so the text promises a retry that does not exist. No other wording is given.
*Now:* the §15 text is returned unchanged, with state `error`.
*Status:* OPEN (human). Give the wording for the final failure, or confirm.

**SQ-A-07** · §6.1, §16.4 — a token file that exists with a mode other than `0600`
§6.1 says token files are mode `0600` and §16.4 says tokens come from `0600` files. Neither says what happens when an
existing file has another mode.
*Now:* startup refuses it (`TokenFileError`, no token value in the message). The file is not changed.
*Status:* OPEN (confirm). Option: tighten the mode with `chmod` and continue.

**SQ-A-08** · §14.1 "attachments are base64" — which base64
The alphabet, padding and line breaks are not specified.
*Now:* RFC 4648 §4 standard alphabet, padded, length a multiple of 4, no whitespace; anything else → 400. Non-zero
trailing bits (`aGl=`) are not checked and are accepted.
*Status:* OPEN (confirm).
