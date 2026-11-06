// The one shared workflow (A.1, D11): cron only. It holds no key that can spend. Each run, per chain: read the plan list from the
// chain's events, work out what's due, simulate it, and write only what the simulation shows paying.
// A failure here means a run is missed, never paid wrongly. Missed runs are skipped, not paid late (D9).

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
  ok,
  type HTTPSendRequester,
  type Runtime,
} from '@chainlink/cre-sdk';
import { decodeEventLog, toEventSelector, type Hex } from 'viem';
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
  selector: string;
  executor: Hex;
  forwarder: Hex;
  deploymentBlock: string;
  simulationUrl: string;
}

export interface Config {
  schedule: string;
  maxSimulationsPerRun: number;
  workflow: { id: Hex; name: Hex; owner: Hex };
  chains: ChainConfig[];
}

const TOPICS = EVENTS.map((event) => toEventSelector(event));

function readEvents(runtime: Runtime<Config>, chain: ChainConfig): PlanEvent[] {
  const evm = new EVMClient(BigInt(chain.selector));
  const reply = evm
    .filterLogs(runtime, {
      filterQuery: {
        fromBlock: blockNumber(chain.deploymentBlock),
        addresses: [hexToBase64(chain.executor)],
        topics: [{ topic: TOPICS.map((t) => hexToBase64(t)) }],
      },
    })
    .result();
  const events: PlanEvent[] = [];
  for (const log of reply.logs) {
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

interface SimArgs {
  url: string;
  from: Hex;
  to: Hex;
  data: Hex;
}

const simulateFetch = (sender: HTTPSendRequester, a: SimArgs): Simulated => {
  const rpc = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_simulateV1',
    params: [{ blockStateCalls: [{ calls: [{ from: a.from, to: a.to, data: a.data }] }], validation: false }, 'latest'],
  };
  const resp = sender
    .sendRequest({
      url: a.url,
      method: 'POST' as const,
      body: Buffer.from(JSON.stringify(rpc)).toString('base64'),
      headers: { 'Content-Type': 'application/json' },
    })
    .result();
  if (!ok(resp)) return { status: 'http', gasUsed: 0, logs: [] };
  const json = JSON.parse(new TextDecoder().decode(resp.body));
  if (json.error) return { status: 'rpc', gasUsed: 0, logs: [] };
  const call = json.result[0].calls[0];
  // Only what every node sees alike, or consensus would fail for no reason.
  return {
    status: call.status,
    gasUsed: parseInt(call.gasUsed, 16),
    logs: call.logs.map((l: { address: string; topics: string[] }) => ({ address: l.address, topics: l.topics })),
  };
};

const onCron = (runtime: Runtime<Config>): string => {
  const { config } = runtime;
  const now = BigInt(Math.floor(runtime.now().getTime() / 1000));
  const chains = config.chains.map((chain) => ({ chain, plans: plansFrom(readEvents(runtime, chain)) }));
  const due = pickDue(chains, now, config.maxSimulationsPerRun);
  runtime.log(`plans: ${chains.map((c) => c.plans.length).join('/')}; due now: ${due.length}`);
  if (due.length === 0) return JSON.stringify({ due: 0 });

  const key = runtime.getSecret({ id: 'SIMULATION_API_KEY' }).result().value;
  const metadata = metadataOf(config.workflow);
  const results = due.map(({ plan, slot, chain }) => {
    const report = reportOf(plan.redeem);
    const sim = new HTTPClient()
      .sendRequest(
        runtime,
        simulateFetch,
        consensusIdenticalAggregation<Simulated>(),
      )({
        url: chain.simulationUrl + key,
        from: chain.forwarder,
        to: chain.executor,
        data: onReportCall(metadata, report),
      })
      .result();
    runtime.log(`plan ${plan.id} slot ${slot}: simulated ${sim.status}, gas ${sim.gasUsed}`);
    if (!simulationPaid(sim, chain.executor)) return { id: plan.id, slot: slot.toString(), skipped: sim.status };

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
    return { id: plan.id, slot: slot.toString(), tx: bytesToHex(written.txHash ?? new Uint8Array(32)) };
  });
  return JSON.stringify({ due: due.length, results });
};

export const initWorkflow = (config: Config) => [
  handler(new CronCapability().trigger({ schedule: config.schedule }), onCron),
];

export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
