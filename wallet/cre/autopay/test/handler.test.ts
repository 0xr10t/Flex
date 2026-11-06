import { EVMClient, HTTPClient, TxStatus, type EVMLog, type Runtime } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { encodeAbiParameters, encodeEventTopics, hexToBytes, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onCron, type Config } from '../main.js';
import { EVENTS, type Simulated } from '../lib/due.js';

const id = `0x${'ab'.repeat(32)}` as Hex;
const address = '0x000000000000000000000000000000000000a11c';
const chain: Config['chains'][number] = {
  chainId: 84532,
  selector: '10344971235874465080',
  executor: address,
  forwarder: '0x000000000000000000000000000000000000f00d',
  deploymentBlock: '1',
  simulation: { urlsSecret: 'SIM_URLS', quorum: 2 },
};
const config: Config = {
  schedule: '0 * * * * *',
  maxSimulationsPerRun: 2,
  workflow: { id, name: '0x00000000000000000001', owner: address },
  chains: [chain],
};
const registered = (): EVMLog =>
  ({
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'Registered', args: { intentId: id, delegator: address } }).map(
      (t) => hexToBytes(t as Hex),
    ),
    data: hexToBytes(
      encodeAbiParameters(
        [{ type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'bytes' }],
        [1000n, 60n, 30n, 3n, '0x1234'],
      ),
    ),
  }) as EVMLog;
const executed = (slot = 0n): EVMLog =>
  ({
    topics: encodeEventTopics({ abi: EVENTS, eventName: 'Executed', args: { intentId: id } }).map((t) =>
      hexToBytes(t as Hex),
    ),
    data: hexToBytes(encodeAbiParameters([{ type: 'uint64' }, { type: 'uint64' }], [slot, 1n])),
  }) as EVMLog;
const paid = (): Simulated => {
  const log = executed();
  return {
    status: '0x1',
    gasUsed: 100_000,
    logs: [
      {
        address,
        topics: log.topics.map((t) => `0x${Array.from(t, (b) => b.toString(16).padStart(2, '0')).join('')}`),
        data: `0x${Array.from(log.data, (b) => b.toString(16).padStart(2, '0')).join('')}`,
      },
    ],
  };
};

function harness(logs: EVMLog[] = [], simulation: Simulated = paid()) {
  const order: string[] = [];
  const getSecrets = vi.fn(() => {
    order.push('start secrets');
    return {
      result() {
        order.push('resolve secrets');
        return { SIM_URLS: { value: '["https://a.example","https://b.example","https://c.example"]' } };
      },
    };
  });
  const report = vi.fn(() => ({ result: () => ({}) }));
  const runtime = {
    config,
    now: () => new Date(1_000_000),
    log: vi.fn(),
    getSecrets,
    report,
  } as unknown as Runtime<Config>;
  const filter = vi.spyOn(EVMClient.prototype, 'filterLogs').mockImplementation(() => {
    order.push('start logs');
    return {
      result: () => {
        order.push('resolve logs');
        return { logs };
      },
    } as ReturnType<EVMClient['filterLogs']>;
  });
  vi.spyOn(EVMClient.prototype, 'headerByNumber').mockImplementation(() => {
    order.push('start header');
    return {
      result: () => {
        order.push('resolve header');
        return {
          header: {
            blockNumber: { absVal: new Uint8Array([100]), sign: 1 },
            hash: new Uint8Array(32).fill(1),
            timestamp: 999n,
          },
        };
      },
    } as unknown as ReturnType<EVMClient['headerByNumber']>;
  });
  const simulate = vi
    .spyOn(HTTPClient.prototype, 'sendRequest')
    .mockImplementation((() => () => ({ result: () => simulation })) as unknown as HTTPClient['sendRequest']);
  const write = vi.spyOn(EVMClient.prototype, 'writeReport').mockReturnValue({
    result: () => ({
      txStatus: TxStatus.SUCCESS,
      receiverContractExecutionStatus: EVM_PB.ReceiverContractExecutionStatus.SUCCESS,
      txHash: new Uint8Array(32).fill(0xcd),
    }),
  } as ReturnType<EVMClient['writeReport']>);
  return { runtime, getSecrets, report, filter, simulate, write, order };
}

afterEach(() => vi.restoreAllMocks());

describe('actual CRE cron handler with capability boundaries mocked', () => {
  it('starts every independent chain log request before resolving one, and reads no secrets without due plans', () => {
    const h = harness();
    h.runtime.config = {
      ...config,
      chains: [chain, { ...chain, selector: '16015286601757825753', chainId: 11155111 }],
    };
    expect(JSON.parse(onCron(h.runtime))).toEqual({ due: 0 });
    expect(h.order).toEqual(['start logs', 'start logs', 'resolve logs', 'resolve logs']);
    expect(h.getSecrets).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('batches secrets, starts headers before resolving secrets, and submits a due payment only after simulation', () => {
    const h = harness([registered()]);
    expect(JSON.parse(onCron(h.runtime))).toEqual({ due: 1, results: [{ id, slot: '0', tx: `0x${'cd'.repeat(32)}` }] });
    expect(h.getSecrets).toHaveBeenCalledExactlyOnceWith([{ id: 'SIM_URLS' }]);
    expect(h.order.slice(2)).toEqual(['start secrets', 'start header', 'resolve secrets', 'resolve header']);
    expect(h.simulate).toHaveBeenCalledTimes(1);
    expect(h.report).toHaveBeenCalledTimes(1);
    expect(h.write).toHaveBeenCalledTimes(1);
  });
  it('submits no report when the simulation quorum is unavailable', () => {
    const h = harness([registered()], { status: 'unavailable', gasUsed: 0, logs: [] });
    expect(JSON.parse(onCron(h.runtime))).toEqual({ due: 1, results: [{ id, slot: '0', skipped: 'unavailable' }] });
    expect(h.report).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('does not repeat an already executed slot', () => {
    const h = harness([registered(), executed()]);
    expect(JSON.parse(onCron(h.runtime))).toEqual({ due: 0 });
    expect(h.simulate).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('does not simulate or submit a cancelled plan', () => {
    const cancelled = {
      topics: encodeEventTopics({
        abi: EVENTS,
        eventName: 'Cancelled',
        args: { intentId: id, delegator: address },
      }).map((t) => hexToBytes(t as Hex)),
      data: new Uint8Array(),
    } as EVMLog;
    const h = harness([registered(), cancelled]);
    expect(JSON.parse(onCron(h.runtime))).toEqual({ due: 0 });
    expect(h.simulate).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
  it('propagates failed report delivery instead of returning a fabricated transaction hash', () => {
    const h = harness([registered()]);
    h.write.mockReturnValue({ result: () => ({ txStatus: TxStatus.REVERTED }) } as ReturnType<
      EVMClient['writeReport']
    >);
    expect(() => onCron(h.runtime)).toThrow('CRE report delivery not confirmed');
    expect(h.write).toHaveBeenCalledTimes(1);
  });
});
