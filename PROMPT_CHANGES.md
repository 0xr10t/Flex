# Prompt changes and live-model acceptance

Authorization: `SPEC_QUESTIONS.md` SQ-L-01 and `HANDOFF_PROMPT.md` §5.2 permit prompt edits and narrow action-label deduplication. JSON schemas and prompt slots remain unchanged; README remains the original specification.

Baseline: `05e67e5`. Candidate source revision: `f7334e2b75860b831ba3f1232834233b77bc6693`. Complete live-set acceptance is pending: 154 cases, zero wrong handoffs, fewer than 54 needless stops. The nine focused probes below are supporting evidence, not a substitute for that gate.

| Prompt | Reason | Focused evidence |
| --- | --- | --- |
| amounts.txt | Exact short amount spans; distinguish USDC from USD; no-amount messages return an empty list; bare-number story spans must not gain a currency word. | Balance and stop returned empty lists; multi-pay spans copied exactly; final story probe returned `100 usdc` as context and bare `30` as pay. |
| requestType.txt | Actions list unique kinds; clarify daily/twice-weekly recurrence; classify split as a payment so deterministic split rejection runs. | Multi-pay returned one `i`; twice-weekly returned `k`. |
| spans.txt | Recognize “all X members”; omit “myself”. | Model still emitted overbroad group/self spans in probes; deterministic S2/S5 guards handle them. No claim that wording alone fixes these cases. |
| payments.txt | Separate recurrence frequency/interval from duration; preserve explicit chains; avoid invented weekdays. | Independent deterministic regressions cover LIVE-P061/P073, interval one/two, and chain swaps. Live results pending below. |

Focused raw production-client evidence: `/private/tmp/flex-codex-fixes/understanding-live-probes.json` and `understanding-live-story-reprobe.json`. Ollama `qwen2.5:7b-instruct`, temperature 0, seed 42, context 8192, timeout 60 seconds. Probes include raw prompt/response text and SHA-256 hashes.

## Exact old and new text

The unified diff records every removed old line and added new line. Unchanged surrounding lines make each edit reviewable. Both full versions are recoverable by the revisions above.

| File | Old SHA-256 | New SHA-256 |
| --- | --- | --- |
| `src/llm/prompts/amounts.txt` | `733b5467906c31ff7189798cc6eeae7794ae7fdedd506b03f59480deb74c3a96` | `ae68f239ee2084c0f3435f0060841be4ed6a5c917f1318a481d48254e0f314b7` |
| `src/llm/prompts/requestType.txt` | `0f153ae7cc8323c4987f49691dac27c73785c95cdff00ffbfa00d8bffa575d9c` | `8ea94dcef4eaf61fa4ed6dba558ea81076a9aaab43d10cc0ce82bf50f1c74b22` |
| `src/llm/prompts/spans.txt` | `79e801b6005c5f17e739feced49bd39fc439da0cc93f2fa99d403019e935a363` | `7725c67273032a7bc887037ef7e2007716a97bbcc0e60af9e93b7858c6c910d4` |
| `src/llm/prompts/payments.txt` | `9002e9bc0efc3c38da7e117ef4d5082b2777655e66512d6e7c205508fbe401e9` | `e915bb142dfe6825047624623514927394010c36627b85dd8e199f3e1431f41c` |

```diff
diff --git a/src/llm/prompts/amounts.txt b/src/llm/prompts/amounts.txt
index 435420b..fdd62f4 100644
--- a/src/llm/prompts/amounts.txt
+++ b/src/llm/prompts/amounts.txt
@@ -1,18 +1,19 @@
 SYSTEM
 You find money amounts in a message sent to a wallet assistant. Output JSON only.
 For every phrase that states an amount of money, return one item:
-- phrase: the exact characters from the message, copied without any change
+- phrase: only the few words that state the amount (for example "50 usdc", "fifty bucks", "half my eth"), copied exactly as written. Never the whole message.
 - number: the amount as a plain decimal like "5000" or "0.5", or null if the phrase is relative
 - relative: "all", "half" or "max" when the phrase means a share of the user's balance, else null
 - token: "USDC" or "ETH" when the phrase itself names it, else null
-- fiat: "USD" if the phrase uses $, dollars, bucks or usd; "OTHER" for any other currency; else null
+- fiat: "USD" only for $, dollars, bucks or usd; "OTHER" for other fiat currencies; else null. USDC and USD Coin are tokens, never fiat.
 - role: "pay" if this amount should be sent (now or on a schedule); "context" if it only tells the story
   (a past price, what someone charged before, what a friend paid)
 Rules:
-1. Copy phrase exactly. Never merge two amounts into one phrase.
+1. Copy only the amount words exactly. Leave out payment verbs, recipients and the rest of the sentence. Never add a token or currency word absent from that exact span. Never merge two amounts into one phrase.
 2. Dates, times, counts of payments ("3 times a week", "for 10 weeks") and parts of addresses are not amounts.
 3. Write 5k as 5000, 1.2m as 1200000, "five lakh" as 500000, "two crore" as 20000000.
 4. If unsure whether an amount should be sent, use "pay".
+5. If the message states no amount at all, return {"amounts":[]}. Never invent a context amount for a balance or cancellation request.
 Examples:
 Message: send 50 usdc to aradhya on base
 {"amounts":[{"phrase":"50 usdc","number":"50","relative":null,"token":"USDC","fiat":null,"role":"pay"}]}
@@ -20,5 +21,11 @@ Message: pay mihir fifty bucks, he charged 500 last time
 {"amounts":[{"phrase":"fifty bucks","number":"50","relative":null,"token":null,"fiat":"USD","role":"pay"},{"phrase":"500","number":"500","relative":null,"token":null,"fiat":null,"role":"context"}]}
 Message: send half my eth to riya
 {"amounts":[{"phrase":"half my eth","number":null,"relative":"half","token":"ETH","fiat":null,"role":"pay"}]}
+Message: Mihir lent me 100 usdc. Send him 30 back
+{"amounts":[{"phrase":"100 usdc","number":"100","relative":null,"token":"USDC","fiat":null,"role":"context"},{"phrase":"30","number":"30","relative":null,"token":null,"fiat":null,"role":"pay"}]}
+Message: stop paying riya
+{"amounts":[]}
+Message: what's my balance
+{"amounts":[]}
 USER
 Message: <<<{typed_text}>>>
diff --git a/src/llm/prompts/payments.txt b/src/llm/prompts/payments.txt
index 3355ef0..e65b7e2 100644
--- a/src/llm/prompts/payments.txt
+++ b/src/llm/prompts/payments.txt
@@ -19,6 +19,15 @@ Rules:
 5. Use a chain only for the payments the user said it for. A chain named once at the end of the
    whole request applies to every payment in it.
 6. Use a SESSION recipient only if it is listed under SESSION.
+7. Schedule frequency is how often: "daily" / "every day" means daily; a named weekday, "weekly",
+   or "N times a week" means weekly; "monthly" / "every month" means monthly.
+8. For "k", interval is 1 unless the user explicitly says "every other" (2), "every N days/weeks/months" (N),
+   or "fortnightly" (weekly, 2). "For 4 weeks", "for 4 months" and "for 3 payments" describe duration,
+   never interval. "Every Monday for 4 weeks" is weekly, interval 1, days_of_week ["MON"].
+   "Every month on the 31st for 4 months" is monthly, interval 1, day_of_month 31.
+9. "Twice a week" is weekly, interval 1, times_per_week 2, days_of_week null unless days are named.
+   "Every day" is daily, interval 1, times_per_week null, days_of_week null. Do not invent weekdays.
+10. An explicitly named chain must be preserved for its payment; use "unstated" only when no chain applies.
 Examples:
 Message: Send amount_aa11bb22 to address_0a0b0c0d on base, and amount_cc33dd44 to address_1e1f2a2b on arbitrum
 CHAINS MENTIONED: [{"word":"base","chain_id":84532},{"word":"arbitrum","chain_id":421614}]
diff --git a/src/llm/prompts/requestType.txt b/src/llm/prompts/requestType.txt
index 64c55d5..e849d6e 100644
--- a/src/llm/prompts/requestType.txt
+++ b/src/llm/prompts/requestType.txt
@@ -5,11 +5,17 @@ request_type:
 - "balance" if the user only asks about their balance
 - "unsupported" if the user asks for anything else (swaps, approvals, buying, NFTs, staking, history,
   other tokens), even when they also ask for something supported
-actions (only when request_type is "actions"); include each that applies:
+actions (only when request_type is "actions"); list each kind at most once, even for several recipients or payments:
 - "i" a one-time payment
-- "k" a repeating payment (every week, monthly, 3 times a week, ...)
+- "k" a repeating payment (every day, every week, monthly, twice a week, 3 times a week, ...)
 - "l" stopping or cancelling an existing repeating payment
 also_balance: true if the user also asks about their balance, else false.
 amount_… words are amounts that were already found.
+"split amount_… between people" is a payment request: classify it as "actions" with ["i"].
+Examples:
+Message: send amount_1a2b3c4d to mihir and amount_5e6f7a8b to aradhya
+{"request_type":"actions","actions":["i"],"also_balance":false}
+Message: pay mihir amount_1a2b3c4d twice a week
+{"request_type":"actions","actions":["k"],"also_balance":false}
 USER
 Message: <<<{masked_text_s3}>>>
diff --git a/src/llm/prompts/spans.txt b/src/llm/prompts/spans.txt
index f12a756..3283fe9 100644
--- a/src/llm/prompts/spans.txt
+++ b/src/llm/prompts/spans.txt
@@ -3,12 +3,12 @@ You find who should receive money in a request sent to a wallet assistant. Outpu
 Return one span for every person name, ENS name, address or group in the message:
 - text: the exact characters from the message
 - kind: "name" (a person's name), "ens" (a name like riya.eth or iitr.ac.in used as a person),
-  "address" (0x...), "group" (the parent name in "everyone under X", "all of X", "@X")
+  "address" (0x...), "group" (the parent name in "everyone under X", "all of X", "all X members", "@X")
 - role: "payee" if money goes to them (now, on a schedule, or their repeating payment should stop);
   "mentioned" if they are only part of the story (who a service was for, who paid before, a friend)
 Rules:
 1. Include every item listed in CANDIDATES with its text unchanged.
-2. Never return pronouns (her, him, them, they), "me", "my" or "I".
+2. Never return pronouns (her, him, them, they), "me", "my", "I" or "myself".
 3. amount_… words and [amount] are not people.
 4. If unsure, use "payee".
 Example:
```

## Complete live-set results

Pending the integrated 154-case evaluation and independent grading. Candidate wording is retained only if the SQ-L-01 acceptance conditions pass.
