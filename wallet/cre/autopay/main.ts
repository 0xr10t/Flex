// Shared cron. Local qualification and dry-run never create reports. Explicit broadcast mode alone reaches writeReport.
import {
  CronCapability,
  EVMClient,
  HTTPClient,
  Runner,
  blockNumber,
  bytesToHex,
  consensusIdenticalAggregation,
  handler,
  hexToBase64,
  protoBigIntToBigint,
  type EVMLog,
  type Runtime,
} from '@chainlink/cre-sdk';
import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { configSchema, snapshotPlans, validateConfig, type Config, type PaymentConfig } from './lib/config';
import { qualifyFetch, simulateFetch } from './lib/http-simulation';
import { simulationUrls, type SimulationRequest } from './lib/simulation';
import { successfulWriteHash } from './lib/write-result';
import {
  EVENTS,
  gasFor,
  metadataOf,
  onReportCall,
  pickDue,
  plansFrom,
  reportOf,
  simulationPaid,
  type PlanEvent,
  type Simulated,
} from './lib/due';
export type { Config, PaymentConfig } from './lib/config';

const TOPICS = EVENTS.map((event) => toEventSelector(event));
// Longer history requires the durable indexer; never discard older active plans using a rolling lookback.
const MAX_DISCOVERY_BLOCKS = 10;

function eventsOf(logs: EVMLog[]): PlanEvent[] {
  return logs.map((log) => {
    const decoded = decodeEventLog({
      abi: EVENTS,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    });
    if (decoded.eventName === 'Registered') {
      const { intentId, startAt, interval, lateWindow, maxRuns, redeem } = decoded.args;
      return { name: 'Registered', id: intentId, startAt, interval, lateWindow, maxRuns, redeem };
    }
    return decoded.eventName === 'Executed'
      ? { name: 'Executed', id: decoded.args.intentId, slot: decoded.args.slot }
      : { name: 'Cancelled', id: decoded.args.intentId };
  });
}

function discover(runtime: Runtime<Config>, config: PaymentConfig) {
  const heads = config.chains.map((chain) => ({
    chain,
    reply: new EVMClient(BigInt(chain.selector)).headerByNumber(runtime, { blockNumber: blockNumber(-3n) }),
  }));
  const anchored = heads.map(({ chain, reply }) => {
    const header = reply.result().header;
    if (!header?.blockNumber || header.hash.length !== 32) throw new Error('discovery anchor unavailable');
    const height = protoBigIntToBigint(header.blockNumber);
    if (chain.snapshot) {
      if (BigInt(chain.snapshot.blockNumber) > height) throw new Error('snapshot not finalized');
      return {
        chain,
        verify: new EVMClient(BigInt(chain.selector)).headerByNumber(runtime, {
          blockNumber: blockNumber(chain.snapshot.blockNumber),
        }),
      };
    }
    const from = BigInt(chain.deploymentBlock);
    if (height < from || height - from + 1n > BigInt(MAX_DISCOVERY_BLOCKS))
      throw new Error('plan discovery requires local indexer');
    return {
      chain,
      logs: new EVMClient(BigInt(chain.selector)).filterLogs(runtime, {
        filterQuery: {
          fromBlock: blockNumber(from),
          toBlock: blockNumber(height),
          addresses: [hexToBase64(chain.executor)],
          topics: [{ topic: TOPICS.map((t) => hexToBase64(t)) }],
        },
      }),
    };
  });
  return anchored.map(({ chain, verify, logs }) => {
    if (verify && chain.snapshot) {
      const header = verify.result().header;
      if (!header || bytesToHex(header.hash).toLowerCase() !== chain.snapshot.blockHash.toLowerCase())
        throw new Error('snapshot reorg detected');
      return { chain, plans: snapshotPlans(chain.snapshot) };
    }
    return { chain, plans: plansFrom(eventsOf(logs!.result().logs)) };
  });
}

export const onCron = (runtime: Runtime<Config>): string => {
  const config = validateConfig(runtime.config);
  const nowNumber = Math.floor(runtime.now().getTime() / 1000);
  const now = BigInt(nowNumber);
  if (config.mode === 'local-simulation') {
    const chain = config.chains[0];
    const secret = runtime.getSecrets([{ id: chain.simulation.urlsSecret }]).result();
    const urls = simulationUrls(secret[chain.simulation.urlsSecret].value, chain.simulation.quorum);
    const result = new HTTPClient()
      .sendRequest(
        runtime,
        qualifyFetch,
        consensusIdenticalAggregation<ReturnType<typeof qualifyFetch>>(),
      )({
        urls,
        quorum: chain.simulation.quorum,
        chainId: chain.chainId,
        now: nowNumber,
      })
      .result();
    return JSON.stringify({ mode: config.mode, broadcast: false, paymentExecuted: false, qualification: result });
  }

  const chains = discover(runtime, config);
  const due = pickDue(chains, now, config.maxSimulationsPerRun);
  runtime.log(`plans: ${chains.map((c) => c.plans.length).join('/')}; due now: ${due.length}`);
  if (due.length === 0) return JSON.stringify({ mode: config.mode, due: 0, results: [] });
  const dueChains = [...new Map(due.map(({ chain }) => [chain.selector, chain])).values()];
  const pendingSecrets = runtime.getSecrets(
    [...new Set(dueChains.map((chain) => chain.simulation.urlsSecret))].map((id) => ({ id })),
  );
  // Latest state for execution; historical discovery is finalized. The quorum verifies the exact simulation anchor.
  const pendingHeaders = dueChains.map((chain) => ({
    chain,
    reply: new EVMClient(BigInt(chain.selector)).headerByNumber(runtime, { blockNumber: blockNumber(-2n) }),
  }));
  const secrets = pendingSecrets.result();
  const sources = new Map<string, { urls: string[]; anchor: SimulationRequest['anchor'] }>();
  for (const { chain, reply } of pendingHeaders) {
    const urls = simulationUrls(secrets[chain.simulation.urlsSecret].value, chain.simulation.quorum);
    const header = reply.result().header;
    if (!header?.blockNumber || header.hash.length !== 32) throw new Error('simulation anchor unavailable');
    if (header.timestamp > now + 60n || header.timestamp < now - 300n) throw new Error('simulation anchor stale');
    sources.set(chain.selector, {
      urls,
      anchor: {
        number: `0x${protoBigIntToBigint(header.blockNumber).toString(16)}`,
        hash: bytesToHex(header.hash),
        timestamp: `0x${header.timestamp.toString(16)}`,
      },
    });
  }
  const metadata = metadataOf(config.workflow);
  // Independent simulations start together; report writes remain sequential to avoid overlapping account nonces.
  const pending = due.map(({ plan, slot, chain }) => {
    const report = reportOf(plan.redeem);
    const source = sources.get(chain.selector)!;
    const simulationTime = Math.max(nowNumber, Number(BigInt(source.anchor.timestamp)) + 1);
    const slotTime = plan.startAt + slot * plan.interval;
    if (
      BigInt(simulationTime) > slotTime + plan.lateWindow ||
      (BigInt(simulationTime) - plan.startAt) / plan.interval !== slot
    ) {
      return { plan, slot, chain, report, reply: null };
    }
    const reply = new HTTPClient().sendRequest(
      runtime,
      simulateFetch,
      consensusIdenticalAggregation<Simulated>(),
    )({
      ...source,
      chainId: chain.chainId,
      quorum: chain.simulation.quorum,
      time: simulationTime,
      from: chain.forwarder,
      to: chain.executor,
      data: onReportCall(metadata, report),
    });
    return { plan, slot, chain, report, reply };
  });
  const checked = pending.map((entry) => ({ ...entry, sim: entry.reply?.result() }));
  const results = checked.map(({ plan, slot, chain, report, sim }) => {
    const identity = { chainId: chain.chainId, id: plan.id, slot: slot.toString() };
    if (!sim) return { ...identity, skipped: 'window_closed' };
    if (!simulationPaid(sim, chain.executor, { id: plan.id, slot })) return { ...identity, skipped: sim.status };
    if (config.mode === 'dry-run')
      return { ...identity, status: 'would_execute', gasLimit: String(gasFor(sim.gasUsed)) };
    const signed = runtime
      .report({
        encodedPayload: hexToBase64(report),
        encoderName: 'evm',
        signingAlgo: 'ecdsa',
        hashingAlgo: 'keccak256',
      })
      .result();
    const written = new EVMClient(BigInt(chain.selector))
      .writeReport(runtime, {
        receiver: chain.executor,
        report: signed,
        gasConfig: { gasLimit: String(gasFor(sim.gasUsed)) },
      })
      .result();
    return { ...identity, status: 'submitted', tx: successfulWriteHash(written) };
  });
  return JSON.stringify({ mode: config.mode, due: due.length, results });
};

export const initWorkflow = (config: Config) => {
  validateConfig(config);
  return [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];
};
export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
