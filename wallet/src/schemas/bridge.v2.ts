// CCIP bridge step (README intent `j`) in the same style as intent.v2.ts, plus the ordered plan
// that ties bridges to the payments they fund. Payments stay exactly IntentSchema from intent.v2.ts.
import { z } from "zod";
import { isAddress, parseUnits, zeroAddress } from "viem";
import { IntentSchema, USDC, CHAINS } from "./intent.v2.js";

// CCIP identifies chains by selector, not chain id (architecture doc §cross-chain step 1).
export const CCIP: Record<(typeof CHAINS)[number], { selector: bigint; router: `0x${string}` }> = {
  11155111: { selector: 16015286601757825753n, router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59" },
  84532: { selector: 10344971235874465080n, router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93" },
  421614: { selector: 3478487238524512106n, router: "0x2a9C5afB0d0e4BAb2BCdaE109EC4b0c4Be15a165" },
};
export const MAX_BRIDGES_PER_PLAN = 3; // README max_bridges_per_request
export const MAX_FEE_ETH = "0.01"; // hard ceiling for one CCIP fee paid in native ETH

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine((a) => isAddress(a, { strict: true }), "bad EIP-55 checksum").refine((a) => a.toLowerCase() !== zeroAddress, "zero address");
const decimalAmount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, "amount must be a positive decimal string");
const chain = z.union([z.literal(11155111), z.literal(84532), z.literal(421614)]);

export const BridgeSchema = z
  .object({
    intentId: z.string().uuid(),
    version: z.literal(1),
    from: addr,
    sourceChainId: chain,
    destChainId: chain,
    // v1: USDC only. CCIP has no native-ETH transfer on these lanes; ETH bridging is out of scope.
    asset: z.object({ type: z.literal("erc20"), token: addr, decimals: z.literal(6) }).strict(),
    amount: decimalAmount,
    receiver: addr, // README `receiver: "self"`, resolved by code to `from`
    fee: z.object({ payIn: z.literal("native"), max: decimalAmount }).strict(), // quoted with router.getFee, capped here
    execution: z.object({ mode: z.literal("immediate") }).strict(), // bridges are always signed by the user, never automated
  })
  .strict()
  .superRefine((b, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    if (b.sourceChainId === b.destChainId) bad(["destChainId"], "source and destination are the same chain");
    if (b.asset.token.toLowerCase() !== USDC[b.sourceChainId].toLowerCase()) bad(["asset", "token"], `not the registered USDC on chain ${b.sourceChainId}`);
    if (b.receiver.toLowerCase() !== b.from.toLowerCase()) bad(["receiver"], "bridges only go to the user's own address");
    const frac = b.amount.split(".")[1] ?? "";
    if (frac.length > 6) bad(["amount"], "more than 6 decimals");
    else if (parseUnits(b.amount, 6) === 0n) bad(["amount"], "amount must be > 0");
    const ff = b.fee.max.split(".")[1] ?? "";
    if (ff.length > 18 || parseUnits(b.fee.max, 18) === 0n) bad(["fee", "max"], "fee cap must be a positive ETH amount");
    else if (parseUnits(b.fee.max, 18) > parseUnits(MAX_FEE_ETH, 18)) bad(["fee", "max"], `fee cap above ${MAX_FEE_ETH} ETH`);
  });
export type Bridge = z.infer<typeof BridgeSchema>;

/** README intent `l`: cancel an autopay. Executed as DelegationManager.disableDelegation(delegation),
 *  signed by the user's own account [B5]; the executor plan then stops (V2 `due` skips it). No refund:
 *  funds never left the wallet. The full delegation is looked up by delegationHash in DB7. */
export const CancelSchema = z
  .object({
    intentId: z.string().uuid(),
    version: z.literal(1),
    from: addr,
    chainId: chain,
    autopayId: z.string().regex(/^ap_[a-f0-9]{12}$/),
    delegationHash: z.string().regex(/^0x[0-9a-f]{64}$/),
    execution: z.object({ mode: z.literal("immediate") }).strict(),
  })
  .strict();
export type Cancel = z.infer<typeof CancelSchema>;

/** README envelope: ordered steps, bridges first, each payment lists the bridges that fund it. */
export const PlanSchema = z
  .object({
    requestId: z.string().regex(/^req_[a-f0-9]{12}$/),
    steps: z.array(z.discriminatedUnion("kind", [
      z.object({ step: z.number().int().min(0), kind: z.literal("bridge"), funds: z.array(z.number().int().min(0)).min(1), intent: BridgeSchema }).strict(),
      z.object({ step: z.number().int().min(0), kind: z.literal("payment"), dependsOn: z.array(z.number().int().min(0)), intent: IntentSchema }).strict(),
      z.object({ step: z.number().int().min(0), kind: z.literal("cancel"), intent: CancelSchema }).strict(),
    ])).min(1).max(8),
  })
  .strict()
  .superRefine((p, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const byStep = new Map(p.steps.map((s) => [s.step, s]));
    p.steps.forEach((s, k) => s.step !== k && bad(["steps", k, "step"], "steps must be numbered 0..n-1 in order"));
    const bridges = p.steps.filter((s) => s.kind === "bridge");
    if (bridges.length > MAX_BRIDGES_PER_PLAN) bad(["steps"], `more than ${MAX_BRIDGES_PER_PLAN} bridges`);
    let seenPayment = false;
    const owner = p.steps[0]?.intent.from.toLowerCase();
    p.steps.forEach((s, k) => {
      if (s.intent.from.toLowerCase() !== owner) bad(["steps", k, "intent", "from"], "all steps must be from the same account");
      if (s.kind !== "bridge") { seenPayment = true; return; }
      if (seenPayment) bad(["steps", k], "bridges must come before payments");
      for (const f of s.funds) {
        const target = byStep.get(f);
        if (!target || target.kind !== "payment") bad(["steps", k, "funds"], `step ${f} is not a payment`);
        else if (target.intent.chainId !== s.intent.destChainId) bad(["steps", k, "funds"], `bridge lands on ${s.intent.destChainId} but step ${f} pays on ${target.intent.chainId}`);
        else if (!target.dependsOn.includes(s.step)) bad(["steps", f, "dependsOn"], `payment does not wait for bridge ${s.step}`);
      }
    });
    p.steps.forEach((s, k) => {
      if (s.kind !== "payment") return;
      for (const d of s.dependsOn) {
        const src = byStep.get(d);
        if (!src || src.kind !== "bridge" || d >= s.step) bad(["steps", k, "dependsOn"], `step ${d} is not an earlier bridge`);
        else if (!src.funds.includes(s.step)) bad(["steps", k, "dependsOn"], `bridge ${d} does not list this payment in funds`);
      }
      // v1: a bridged payment must be paid in the bridged token (USDC on the destination)
      if (s.dependsOn.length && s.intent.asset.token?.toLowerCase() !== USDC[s.intent.chainId].toLowerCase()) bad(["steps", k, "intent", "asset"], "bridged funds are USDC; the payment must be USDC");
      // a recurring payment fed by a bridge must be prefunded once, not bridged per run (architecture doc §cross-chain autopay)
    });
  });
export type Plan = z.infer<typeof PlanSchema>;
