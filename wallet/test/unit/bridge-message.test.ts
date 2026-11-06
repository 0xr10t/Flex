import { describe, expect, it } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  parseAbiParameters,
  size,
  toHex,
  type Hex,
  type Log,
} from 'viem';
import { trackedMessage } from '../../src/bridge/bridge-j.js';
import { CCIP_V2_EVENTS } from '../../src/bridge/ccip-v2-abi.js';
import { decodeTokenMessage } from '../../src/bridge/message-v1.js';
import { CCIP } from '../../src/schemas/bridge.v2.js';
import { WALLET, bridge } from '../support/envelopes.js';
import { transferLog } from '../support/fake-chain.js';

const intent = bridge(0, '10', []);
const onRamp = CCIP[intent.source_chain_id].router;
const offRamp = CCIP[intent.dest_chain_id].router;
const defaults = {
  source: CCIP[intent.source_chain_id].selector,
  dest: CCIP[intent.dest_chain_id].selector,
  onRamp,
  offRamp,
  sender: WALLET,
  receiver: WALLET,
  amount: BigInt(intent.amount.base_units),
  sourceToken: intent.source_token_address,
  destToken: intent.dest_token_address,
  finality: 0n,
  gas: 0n,
};

const sized = (hex: Hex, n: number) => concat([toHex(size(hex), { size: n }), hex]);
function encoded(change: Partial<typeof defaults> = {}): Hex {
  const m = { ...defaults, ...change };
  const token = concat([
    '0x01',
    toHex(m.amount, { size: 32 }),
    sized(onRamp, 1),
    sized(m.sourceToken, 1),
    sized(m.destToken, 1),
    sized(m.receiver, 1),
    '0x0000',
  ]);
  return concat([
    '0x01',
    toHex(m.source, { size: 8 }),
    toHex(m.dest, { size: 8 }),
    toHex(1, { size: 8 }),
    toHex(500000, { size: 4 }),
    toHex(m.gas, { size: 4 }),
    toHex(m.finality, { size: 4 }),
    toHex(0, { size: 32 }),
    sized(m.onRamp, 1),
    sized(m.offRamp, 1),
    sized(m.sender, 1),
    sized(m.receiver, 1),
    '0x0000',
    sized(token, 2),
    '0x0000',
  ]);
}
function receipt(wire: Hex, id = keccak256(wire), ramp: Hex = onRamp) {
  return {
    status: 'success' as const,
    blockNumber: 1,
    executedAt: '2026-11-06T10:00:00.000Z',
    logs: [
      transferLog(intent.source_token_address, WALLET, onRamp, BigInt(intent.amount.base_units)),
      {
        address: ramp,
        topics: encodeEventTopics({
          abi: CCIP_V2_EVENTS,
          eventName: 'CCIPMessageSent',
          args: { destChainSelector: defaults.dest, sender: WALLET, messageId: id },
        }),
        data: encodeAbiParameters(
          parseAbiParameters('address,uint256,bytes,(address,uint32,uint32,uint256,bytes)[],bytes[]'),
          ['0x0000000000000000000000000000000000000000', defaults.amount, wire, [], []],
        ),
      } as Log,
    ],
  };
}

describe('CCIP source message identity', () => {
  it('reads a full-finality token-only message with empty trailing payloads', () => {
    const wire = encoded();
    expect(decodeTokenMessage(wire)).toMatchObject({ amount: defaults.amount, finality: 0n, data: '0x' });
    expect(trackedMessage(receipt(wire), intent, WALLET, onRamp)).toMatchObject({
      message_id: keccak256(wire),
      message_number: '1',
      source_token: intent.source_token_address.toLowerCase(),
      dest_token: intent.dest_token_address.toLowerCase(),
      amount: intent.amount.base_units,
    });
  });
  it.each([
    { source: 1n },
    { dest: 1n },
    { sender: offRamp },
    { receiver: offRamp },
    { amount: 1n },
    { sourceToken: offRamp },
    { destToken: onRamp },
    { finality: 1n },
    { gas: 100n },
    { onRamp: offRamp },
  ])('rejects a message whose fields do not match the approved transfer (%#)', (change) => {
    expect(trackedMessage(receipt(encoded(change)), intent, WALLET, onRamp)).toBeNull();
  });
  it('rejects an unauthenticated emitter, mismatching message hash and duplicate sends', () => {
    const wire = encoded();
    expect(trackedMessage(receipt(wire, toHex(1, { size: 32 })), intent, WALLET, onRamp)).toBeNull();
    expect(trackedMessage(receipt(wire, keccak256(wire), offRamp), intent, WALLET, onRamp)).toBeNull();
    const duplicate = receipt(wire);
    duplicate.logs.push(duplicate.logs[1]!);
    expect(trackedMessage(duplicate, intent, WALLET, onRamp)).toBeNull();
  });
  it('rejects truncated, trailing and unknown-version encodings', () => {
    const wire = encoded();
    for (const bad of [wire.slice(0, -2), wire + '00', '0x02' + wire.slice(4), '0x'])
      expect(() => decodeTokenMessage(bad as Hex)).toThrow();
  });
});
