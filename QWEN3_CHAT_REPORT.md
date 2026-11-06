# Qwen3 8B and general chat

The human selected `qwen3:8b`, then explicitly approved general chat and explanations with thinking on while wallet
extraction keeps thinking off (SQ-M-01 and SQ-CHAT-01). Implementation and independent deterministic review are
complete. Final full-suite and real-model chat acceptance are still in progress; the results below distinguish
completed evidence from pending evaluation.

## Behavior

`config.qwen3.example.json` selects local Qwen3 8B with `llm.think: false` and
`chat: { "enabled": true, "think": true }`. The classifier uses thinking off; the conversational answer uses thinking
on. Per-call overrides do not change shared configuration. Only the final answer is read from Ollama; its separate
reasoning field is not returned, remembered or logged.

General chat shares the existing messages and text-answer endpoints. It preserves the pending question, attempt
count, current summary and explicit confirmation. Its model has no wallet tools. A wallet classification forwards
the original input unchanged to the existing pipeline. Native confirmation words, literal values and chips keep
their native handlers. Secrets and external content retain their guards before conversational inference.

The context includes bounded recent chat, current wallet state, guarded initial wording, pending-question guidance
and the current displayed summary. Initial wording is explicitly distinguished from the current corrected plan.
Chat history remains in memory for the session, with at most six complete pairs and 4,000 UTF-8 bytes; omission
is tracked. A message over 4,000 UTF-8 bytes receives a request to shorten it. Oversized summaries are omitted
whole. Closing a session clears conversational memory.

## Findings from implementation and migration review

| ID | Finding | Disposition |
| --- | --- | --- |
| Q3-01 | Qwen3 omitted lowercase recipients when an amount was supplied later, producing Q_NO_PAYEE for `pay mihir`. | The span prompt now distinguishes name extraction from the lexical candidate list and missing-amount state. Seven real-model conversation scenarios pass on the candidate; five independent HTTP cases cover the boundary. |
| Q3-02 | A chat explanation could use original Yash wording after the wallet summary had changed recipient. | Pass the bounded current summary separately and prohibit treating initial wording as the current plan. Independent HTTP tests cover the corrected recipient. |
| Q3-03 | History already trimmed by the session could be reported as complete to the model. | Retain a sticky omission flag until session close. Eight-turn and close/reopen regressions pass. |
| Q3-04 | Removing control characters could join a model reply into a secret-looking value after its first scan. | Scan both raw and cleaned output. The independent negative regression passes. |
| Q3-05 | After the final execution timeout, FAILED state could lose the explanation's submission-uncertainty warning. | Retain the native error code and apply the uncertainty rule whenever it is EXECUTION_UNAVAILABLE. Tests verify no resubmission or journal change. |
| Q3-06 | The demo deduplicated identical answers across distinct turns, repeated unchanged summaries, and could reannounce an earlier capture after chat. | Response revisions distinguish turns from polling; summaries and capture notices are deduplicated separately. Twenty independent frontend checks pass. |
| Q3-07 | Real Qwen3 sometimes copies `50 usdc` as `50 us dc`, causing unnecessary Q_AMOUNT_UNCOVERED stops. | The exact-source guard safely rejects it. A prompt-only candidate is being evaluated; no financial validator has been relaxed. |

## Completed verification

- Qwen3 installed locally: 8.2B, Q4_K_M, 5,225,388,164 bytes, digest
  `500a1f067a9f782620b40bee6f7b0c89e17ae61f686b92c24933e4ca4b2b8b41`.
- Before general chat, the Qwen3 migration and span fix passed **2,188 unit/acceptance tests and 205 audit checks**,
  plus typecheck, lint and build. These totals describe that earlier revision, not the final chat feature.
- The seven real-model wallet conversations pass on the span candidate: 18 turns, 41 logical calls, three explicit
  confirmations and zero premature submissions. Raw artifact:
  [`test/live/results/conversation/qwen3-spans-candidate.json`](test/live/results/conversation/qwen3-spans-candidate.json).
- The earlier Qwen3 demo reproduced Yash → `10 usd` → `pay riya` over TCP, retaining 10 USDC, twice weekly for
  three weeks, with no submission. That demo had general chat disabled.
- Independent general-chat review passes **166 focused tests**, including 23 HTTP state/lifecycle cases, plus the
  six focused error-provenance audits. Per-call thinking separately passed 51 client cases. The reviewer wrote
  tests only; source authors did not grade the implementation alone.

Independent reports and detailed deterministic evidence are retained under `/private/tmp/flex-qwen3-8b/`, including
`general-chat-independent-review.md`, `think-override-independent-review.md`, and `spans-independent-review.md`.
The earlier Qwen2.5 full evaluation remains historical evidence: 129 exact outcomes, 25 stops, zero wrong handoffs.
It must not be reported as a Qwen3 or chat-enabled result.

## Pending final verification

An independently verified frozen Qwen3 wallet-only snapshot is running the unchanged 154-case oracle under
`/private/tmp/flex-qwen3-full-i4vwwuui/`. Its configuration explicitly disables chat, so it cannot establish
chat-enabled behavior. It also ran alongside an unrelated unrestricted deterministic test process for part of
the run; latency must be interpreted with that contention noted.

The final chat-enabled runtime needs the dedicated four real-model scenarios, the enabled-router corpus check,
the full deterministic/audit/static pass and an actual browser/TCP smoke test. Final totals, source hashes, demo
URL and remaining limits will be recorded here when those checks finish. No signing or real funds are involved.
