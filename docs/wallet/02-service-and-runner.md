# Part 2: Service and step runner

**Goal:** the local service the agent hands off to. It accepts envelopes safely, runs steps in order, and reports results.

**Spec:** §14.2, §14.3, §6.1 (`execution`, `auth`), §3.2, §16.2, §16.4. **Depends on:** Part 1; OQ-04, OQ-08, OQ-15.

## What exists

Nothing. The agent's client side exists at `src/handoff/execution-client.ts`, and is the other end of this contract.

## Interface: inbound

`POST {execution.url}/v1/intents`. The default URL in §6.1 is `http://127.0.0.1:8788`.

| Header or field | Rule | Source |
| --- | --- | --- |
| `Authorization: Bearer` | Token from `execution.outbound_token_file` | §14.2, §6.1 |
| `Idempotency-Key` | The `request_id` | §14.2 |
| Body | §12.5 envelope | §14.2 |

| Outcome | Response | Agent then shows |
| --- | --- | --- |
| Accepted | `202` (any 2xx is accepted) | "Sent to your wallet for signing." |
| Rejected | `4xx` with `{ "message": "…" }` | `EXECUTION_REJECTED` |
| Temporary failure | `5xx`, or no reply within `execution.timeout_ms` (15 s) | `EXECUTION_UNAVAILABLE`; agent may retry with the same key, 3 attempts in total |

## Interface: outbound

`POST http://127.0.0.1:{server.port}/v1/execution/reports` with the token from `auth.execution_report_token_file`.
Replies: `204` success, `400` malformed, `404` unknown `request_id` or `autopay_id`. Reports never contain names or prompt
text (§14.3).

## Tasks

| ID | Task | Source |
| --- | --- | --- |
| W2-01 | Service bound to `127.0.0.1`, bearer auth, reads token files | Spec: §14.2, §16.4 |
| W2-02 | Run Part 1's checks on intake; return `4xx` with a value-free message on failure | Spec: §14.2, D3, §15 |
| W2-03 | Durable store (OQ-04): request, envelope, per-step status | Derived from §14.2 rule 7 |
| W2-04 | Idempotency: same key returns the original result, executes nothing twice | Spec: §14.2 rule 7 |
| W2-05 | Persist the envelope **before** replying `202` | Derived: the 15 s timeout means the agent retries on a lost reply, so the key must already be known |
| W2-06 | Run execution after the reply; do not hold the HTTP call during signing | Derived: signing can take longer than the 15 s `timeout_ms`, and the agent's reply says the request was sent "for signing" |
| W2-07 | Runner: run steps in order; never start one before every `depends_on` step succeeded | Spec: §14.2 rule 2 |
| W2-08 | Failure handling for other steps | **OQ-08** |
| W2-09 | Resume after restart: each step continues from its stored state | Derived from rule 7 ("nothing twice") |
| W2-10 | Report client with `intent_result`, including retry when the agent is unreachable | Spec: §14.3; retry policy is **OQ-14** |
| W2-11 | Config: chain RPCs, executor addresses, deployment blocks, A.1 and A.4 constants | **OQ-15** |
| W2-12 | Logging per OQ-04 | **OQ-04** |

## `intent_result` content

Per §14.3, the agent's action on each `intent_result` report is:

| Step | Fields the wallet must send | Agent action |
| --- | --- | --- |
| `i` | `request_id`, `step`, `status`, `tx_hash`, `executed_at` | DB6 rows updated |
| `j` | The above plus `bridge_fee_eth` | DB6 rows updated; `bridge_fee` row gets the actual fee |
| `k` | The above plus `autopay.autopay_id`, `plan_id`, `executor_address` | DB7 → `active`, or `failed` |
| `l` | The above plus `autopay.autopay_id` | DB7 → `cancelled` |

## Rules

- **Success means the effect, not the receipt** (rule 8, A.5 rule 5). Each intent part defines its effect check.
- **Only envelope fields become calldata** (rule 1). Never add memos or extra data.
- **The wallet never reads agent databases**; it only writes through reports (§3.2).
- **Tx hashes and amounts stay out of agent logs** (§18). Send them only in the report body.

## Crash points the tests must cover

| Crash moment | Required result |
| --- | --- |
| After persist, before the `202` reaches the agent | Agent retry returns the original result; one execution |
| After a transaction is sent, before its result is stored | On restart, the tx is found and not sent again |
| Between two steps | The next step continues; the finished one is not repeated |
| While the report is being sent | Report is retried; the agent handling a duplicate needs checking (see below) |

**Duplicate reports.** `intent_result` overwrites status on the agent's side, so a repeat is harmless. `autopay_payment`
**inserts** rows (§14.3), so a repeat double-counts. See Part 10.

## Tests

| Test | Expected | Source |
| --- | --- | --- |
| No or wrong token | Rejected | §14.2 |
| Bad envelope | `4xx` with `message`, no amounts or addresses in it | §15 |
| Same key twice, in parallel and after completion | One execution, same result | Rule 7 |
| `[j, i, i]` where `j` is not done | Dependent `i` waits; independent `i` per OQ-08 | Rule 2, E3 |
| Failed receipt or missing effect | Reported `failed` | Rule 8 |
| Report answered 404 or 400 | Logged by code only; not retried forever | §14.3 |

## Exit criteria

With fake chain steps, the runner passes the ordering and crash tests above, and the agent's `execution-client.ts`
behaviour (A-51, A-52) works against the real service.
