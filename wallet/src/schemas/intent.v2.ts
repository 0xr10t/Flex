// Your intent schema (same shape and field names), corrected from the local onchain tests.
// Changes are marked [Tn] with the test that motivated them (see results/onchain.json, results/schema.txt).
import { z } from "zod";
import { getAddress, isAddress, keccak256, parseUnits, toBytes, zeroAddress } from "viem";

// [README scope] the three v1 testnets
export const CHAINS = [11155111, 84532, 421614] as const;
// [B1/B2] ERC-20 must be a known token per chain (Circle testnet USDC), never an arbitrary address
export const USDC: Record<(typeof CHAINS)[number], `0x${string}`> = {
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
};
export const MAX_RECIPIENTS = 100; // [B12] one-time: 100 USDC transfers = 3.9M gas, fine (no CRE involved)
export const MAX_RECIPIENTS_AUTOMATED = 50; // [B12] automated: 50 USDC = 27.3 KB report; 100 = 52.9 KB, over CRE's 50 KB
export const MAX_DURATION_S = 52 * 7 * 86400; // README autopay_max_weeks

// [B9] zero address is payable onchain (funds burned), so reject it here; [EIP-55] mixed-case must checksum
const addr = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "not a 20-byte hex address")
  .refine((a) => isAddress(a, { strict: true }), "bad EIP-55 checksum")
  .refine((a) => a.toLowerCase() !== zeroAddress, "zero address");
const decimalAmount = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/, "amount must be a positive decimal string");
const iso = z.string().datetime({ offset: true });

export const IntentSchema = z
  .object({
    intentId: z.string().uuid(),
    version: z.literal(1),
    chainId: z.union([z.literal(11155111), z.literal(84532), z.literal(421614)]),
    from: addr,
    asset: z.object({
      type: z.enum(["native", "erc20"]),
      token: addr.nullable(),
      decimals: z.number().int().min(0).max(36),
    }).strict(),
    recipients: z.array(z.object({ to: addr, amount: decimalAmount }).strict()).min(1).max(MAX_RECIPIENTS),
    atomic: z.boolean(),
    schedule: z.object({
      type: z.enum(["once", "recurring"]),
      startAt: iso.nullable(),
      interval: z.number().int().positive().nullable(),
      maxRuns: z.number().int().positive().max(520).nullable(),
      endAt: iso.nullable(),
      lateWindow: z.number().int().positive().nullable(), // [C6] new: seconds a slot stays payable
    }).strict(),
    execution: z.object({
      mode: z.enum(["immediate", "automated"]),
      executor: z.enum(["chainlink-cre", "backend"]).nullable(),
      fee: z.object({ to: addr, amount: decimalAmount }).strict().nullable(), // [B8] new: per-run fee, same asset
    }).strict(),
    limits: z.object({ maxPerRun: decimalAmount, maxTotal: decimalAmount.nullable() }).strict(),
  })
  .strict()
  .superRefine((i, ctx) => {
    const bad = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
    const { asset, schedule: s, execution: e, limits } = i;

    if (asset.type === "native" && (asset.token !== null || asset.decimals !== 18)) bad(["asset"], "native asset needs token=null and decimals=18");
    if (asset.type === "erc20") {
      if (asset.token === null) bad(["asset", "token"], "erc20 needs a token address");
      else if (asset.token.toLowerCase() !== USDC[i.chainId].toLowerCase()) bad(["asset", "token"], `not the registered USDC for chain ${i.chainId}`);
      if (asset.decimals !== 6) bad(["asset", "decimals"], "USDC has 6 decimals");
    }

    const units = (x: string, p: (string | number)[]) => {
      const frac = x.split(".")[1] ?? "";
      if (frac.length > asset.decimals) { bad(p, `more than ${asset.decimals} decimals`); return 0n; }
      return parseUnits(x, asset.decimals);
    };
    const amounts = i.recipients.map((r, k) => units(r.amount, ["recipients", k, "amount"]));
    amounts.forEach((a, k) => a === 0n && bad(["recipients", k, "amount"], "amount must be > 0"));
    const tos = i.recipients.map((r) => r.to.toLowerCase());
    if (new Set(tos).size !== tos.length) bad(["recipients"], "duplicate recipient");
    if (tos.includes(i.from.toLowerCase())) bad(["recipients"], "recipient equals from");
    if (asset.token && tos.includes(asset.token.toLowerCase())) bad(["recipients"], "recipient is the token contract (tokens would be lost)");

    // [B8] fee: required for automated (user pays per run), forbidden for immediate (user pays gas directly)
    const fee = e.fee ? units(e.fee.amount, ["execution", "fee", "amount"]) : 0n;
    if (e.mode === "automated" && !e.fee) bad(["execution", "fee"], "automated needs a per-run fee");
    if (e.mode === "immediate" && e.fee) bad(["execution", "fee"], "immediate has no executor fee");
    if (e.fee && tos.includes(e.fee.to.toLowerCase())) bad(["execution", "fee", "to"], "fee recipient is also a payee");

    const perRun = amounts.reduce((a, b) => a + b, 0n) + fee;
    const maxPerRun = units(limits.maxPerRun, ["limits", "maxPerRun"]);
    if (perRun > maxPerRun) bad(["limits", "maxPerRun"], `recipients + fee ${perRun} exceeds maxPerRun ${maxPerRun}`);
    if (e.mode === "automated" && i.recipients.length > MAX_RECIPIENTS_AUTOMATED) bad(["recipients"], `automated payments allow at most ${MAX_RECIPIENTS_AUTOMATED} recipients (CRE 50 KB report limit)`);
    if (i.recipients.length > 1 && !i.atomic) bad(["atomic"], "non-atomic multi-recipient is not supported: partial payment risk");

    // [B7a/C1/C5] an automated intent must carry a concrete start time; it becomes TimestampEnforcer.afterThreshold
    const start = s.startAt ? Date.parse(s.startAt) / 1000 : null;
    if (e.mode === "automated" && start === null) bad(["schedule", "startAt"], "automated needs a concrete startAt (code fills 'now' before signing)");
    if (start !== null && start < Date.now() / 1000 - 300) bad(["schedule", "startAt"], "startAt is in the past");

    if (s.type === "once") {
      if (s.interval !== null || s.maxRuns !== null || s.endAt !== null || s.lateWindow !== null) bad(["schedule"], "once: interval, maxRuns, endAt, lateWindow must be null");
      if (limits.maxTotal !== null && units(limits.maxTotal, ["limits", "maxTotal"]) < perRun) bad(["limits", "maxTotal"], "maxTotal below one run");
    } else {
      if (s.interval === null) bad(["schedule", "interval"], "recurring needs interval");
      if (s.interval !== null && s.interval < 60) bad(["schedule", "interval"], "interval below 60s (CRE cron min is 30s; keep headroom)");
      // [C2/C6] slots are counted, so maxRuns is required (endAt alone no longer enough)
      if (s.maxRuns === null) bad(["schedule", "maxRuns"], "recurring needs maxRuns (number of slots)");
      if (s.lateWindow === null) bad(["schedule", "lateWindow"], "recurring needs lateWindow");
      if (s.lateWindow !== null && s.interval !== null && (s.lateWindow < 60 || s.lateWindow > s.interval)) bad(["schedule", "lateWindow"], "lateWindow must be 60s..interval");
      if (s.interval !== null && s.maxRuns !== null && s.interval * s.maxRuns > MAX_DURATION_S) bad(["schedule"], "longer than 52 weeks");
      if (start !== null && s.endAt && s.interval !== null && s.maxRuns !== null && Date.parse(s.endAt) / 1000 < start + s.interval * (s.maxRuns - 1) + (s.lateWindow ?? 0))
        bad(["schedule", "endAt"], "endAt cuts off slots that maxRuns promises");
      if (limits.maxTotal === null) bad(["limits", "maxTotal"], "recurring needs maxTotal (hard cap)");
      if (limits.maxTotal !== null && s.maxRuns !== null && units(limits.maxTotal, ["limits", "maxTotal"]) < perRun * BigInt(s.maxRuns)) bad(["limits", "maxTotal"], "maxTotal below (recipients + fee) x maxRuns: later runs would fail");
    }
    if (s.startAt && s.endAt && Date.parse(s.endAt) <= Date.parse(s.startAt)) bad(["schedule", "endAt"], "endAt before startAt");

    if (e.mode === "immediate" && (s.type !== "once" || s.startAt !== null)) bad(["execution", "mode"], "immediate only fits once + startAt=null");
    if (e.mode === "immediate" && e.executor !== null) bad(["execution", "executor"], "immediate is signed by the wallet itself: executor must be null");
    if (e.mode === "automated" && e.executor === null) bad(["execution", "executor"], "automated needs an executor");
  });

export type Intent = z.infer<typeof IntentSchema>;

/** Deterministic hash of the intent (keys sorted), used as the delegation salt so the signature commits to it. */
export function intentHash(intent: Intent) {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v;
  return keccak256(toBytes(JSON.stringify(canon(intent))));
}
export { getAddress };
