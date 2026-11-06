// The one shared workflow (A.1, D11): cron only. It holds no key that can spend. Each run, per chain: read the plan list from the
// chain's events, work out what's due, simulate it, and write only what the simulation shows paying.
// A failure here means a run is missed, never paid wrongly. Missed runs are skipped, not paid late (D9).

import {
  CronCapability,
  EVMClient,
  HTTPClient,
  Runner,
  blockNumber,
  bytesToBase64,
  bytesToHex,
  consensusIdenticalAggregation,
  handler,
  hexToBase64,
  ok,
  protoBigIntToBigint,
  type EVMLog,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import { decodeEventLog, toEventSelector, type Hex } from 'viem';
import { simulateProvidersConcurrent, simulationUrls, type SimulationRequest } from './lib/simulation';
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

interface ChainConfig {
  chainId: number;
  selector: string;
  executor: Hex;
  forwarder: Hex;
  deploymentBlock: string;
  simulation: { urlsSecret: string; quorum: number };
}

export interface Config {
  schedule: string;
  maxSimulationsPerRun: number;
  workflow: { id: Hex; name: Hex; owner: Hex };
  chains: ChainConfig[];
}

const TOPICS = EVENTS.map((event) => toEventSelector(event));

function requestEvents(runtime: Runtime<Config>, chain: ChainConfig) {
  const evm = new EVMClient(BigInt(chain.selector));
  return evm.filterLogs(runtime, {
    filterQuery: {
      fromBlock: blockNumber(chain.deploymentBlock),
      addresses: [hexToBase64(chain.executor)],
      topics: [{ topic: TOPICS.map((t) => hexToBase64(t)) }],
    },
  });
}

function eventsOf(logs: EVMLog[]): PlanEvent[] {
  const events: PlanEvent[] = [];
  for (const log of logs) {
    const decoded = decodeEventLog({
      abi: EVENTS,
      data: bytesToHex(log.data),
      topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
    });
    if (decoded.eventName === 'Registered') {
      const { intentId, startAt, interval, lateWindow, maxRuns, redeem } = decoded.args;
      events.push({ name: 'Registered', id: intentId, startAt, interval, lateWindow, maxRuns, redeem });
    } else if (decoded.eventName === 'Executed') {
      events.push({ name: 'Executed', id: decoded.args.intentId, slot: decoded.args.slot });
    } else {
      events.push({ name: 'Cancelled', id: decoded.args.intentId });
    }
  }
  return events;
}

const simulateFetch = (sender: HTTPSendRequester, a: SimulationRequest): Simulated => {
  try {
    const result = simulateProvidersConcurrent(a, (url, body) => {
      const pending = sender.sendRequest({
        url,
        method: 'POST',
        body: bytesToBase64(new TextEncoder().encode(JSON.stringify(body))),
        headers: { 'Content-Type': 'application/json' },
      });
      return {
        result: () => {
          const resp = pending.result();
          if (!ok(resp)) throw new Error('simulation HTTP unavailable');
          return JSON.parse(new TextDecoder().decode(resp.body));
        },
      };
    });
    return result[0][0];
  } catch {
    return { status: 'unavailable', gasUsed: 0, logs: [] };
  }
};

export const onCron = (runtime: Runtime<Config>): string => {
  const { config } = runtime;
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const pendingEvents = config.chains.map((chain) => ({ chain, reply: requestEvents(runtime, chain) }));
  const chains = pendingEvents.map(({ chain, reply }) => ({ chain, plans: plansFrom(eventsOf(reply.result().logs)) }));
  const due = pickDue(chains, now, config.maxSimulationsPerRun);
  runtime.log(`plans: ${chains.map((c) => c.plans.length).join('/')}; due now: ${due.length}`);
  if (due.length === 0) return JSON.stringify({ due: 0 });

  // One secret batch, with independent chain headers started before any result is awaited.
  const sources = new Map<string, { urls: string[]; anchor: SimulationRequest['anchor'] }>();
  const dueChains = [...new Map(due.map(({ chain }) => [chain.selector, chain])).values()];
  const pendingSecrets = runtime.getSecrets(
    [...new Set(dueChains.map((chain) => chain.simulation.urlsSecret))].map((id) => ({ id })),
  );
  const pendingHeaders = dueChains.map((chain) => ({
    chain,
    reply: new EVMClient(BigInt(chain.selector)).headerByNumber(runtime, {}),
  }));
  const secrets = pendingSecrets.result();
  for (const { chain, reply } of pendingHeaders) {
    const urls = simulationUrls(secrets[chain.simulation.urlsSecret].value, chain.simulation.quorum);
    const header = reply.result().header;
    if (!header?.blockNumber || header.hash.length !== 32) throw new Error('simulation anchor unavailable');
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
  const results = due.map(({ plan, slot, chain }) => {
    const report = reportOf(plan.redeem);
    const source = sources.get(chain.selector)!;
    const sim = new HTTPClient()
      .sendRequest(
        runtime,
        simulateFetch,
        consensusIdenticalAggregation<Simulated>(),
      )({
        ...source,
        chainId: chain.chainId,
        quorum: chain.simulation.quorum,
        time: Math.max(Number(now), Number(BigInt(source.anchor.timestamp)) + 1),
        from: chain.forwarder,
        to: chain.executor,
        data: onReportCall(metadata, report),
      })
      .result();
    runtime.log(`plan ${plan.id} slot ${slot}: simulated ${sim.status}, gas ${sim.gasUsed}`);
    if (!simulationPaid(sim, chain.executor, { id: plan.id, slot }))
      return { id: plan.id, slot: slot.toString(), skipped: sim.status };

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
    // Only the `Executed` event proves the payment (A.5 rule 5). The wallet's watcher reports that, not this.
    runtime.log(`plan ${plan.id} slot ${slot}: receiver status ${written.receiverContractExecutionStatus ?? -1}`);
    return { id: plan.id, slot: slot.toString(), tx: successfulWriteHash(written) };
  });
  return JSON.stringify({ due: due.length, results });
};

export const initWorkflow = (config: Config) => {
  // Two HTTP calls per provider, up to three providers: two runs use at most 12 of CRE's 15 HTTP calls.
  if (
    !Number.isInteger(config.maxSimulationsPerRun) ||
    config.maxSimulationsPerRun < 1 ||
    config.maxSimulationsPerRun > 2 ||
    config.chains.length < 1 ||
    config.chains.length > 3
  )
    throw new Error('workflow exceeds simulation call budget');
  return [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
