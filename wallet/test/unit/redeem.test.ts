// Guards the A.5 rules that redeem.v2.ts exists for: USDC is `transfer` (B1), the fee is in the batch (B8), and the
// redeem always uses batch mode (B10). Calldata is decoded back rather than compared with fixed bytes.
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbiParameters,
  parseUnits,
  type Hex,
} from 'viem';
import { describe, expect, it } from 'vitest';
import { DELEGATION, DELEGATION_MANAGER_ABI } from '../../src/autopay/abi.js';
import { delegationFromRedeem } from '../../src/autopay/delegation.js';
import { executionsOf, permissionRedeem, redeemCalldata, redeemIdentity } from '../../src/chain/redeem.v2.js';
import { decodeRedeemBatch } from '../../src/guard/decode.js';
import { IntentSchema, USDC, type Intent } from '@flex/protocol/schemas/intent.v2';

const ME = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ALICE = '0x000000000000000000000000000000000000a11c' as Hex;
const FEE = '0x000000000000000000000000000000000000fee0' as Hex;
const TOKEN = USDC[84532];

const autopay = (asset: Intent['asset'], amount: string, fee: string): Intent =>
  IntentSchema.parse({
    intentId: '7c2e9b1a-4d3f-4a8e-b6c5-1d2e3f4a5b6c',
    version: 1,
    chainId: 84532,
    from: ME,
    asset,
    recipients: [{ to: ALICE, amount }],
    atomic: true,
    schedule: {
      type: 'recurring',
      startAt: new Date(Date.now() + 3600e3).toISOString(),
      interval: 86400,
      maxRuns: 2,
      endAt: null,
      lateWindow: 3600,
    },
    execution: { mode: 'automated', executor: 'chainlink-cre', fee: { to: FEE, amount: fee } },
    limits: { maxPerRun: '100', maxTotal: '200' },
  });

const usdcAutopay = autopay({ type: 'erc20', token: TOKEN, decimals: 6 }, '10', '0.05');
const decodeTransfer = (data: Hex) => decodeFunctionData({ abi: erc20Abi, data });

describe('executionsOf', () => {
  it('USDC: payment then fee, both `transfer` on the token with no value (B1, B8)', () => {
    const [pay, fee] = executionsOf(usdcAutopay);
    expect(pay).toMatchObject({ target: TOKEN, value: 0n });
    expect(decodeTransfer(pay!.callData)).toMatchObject({
      functionName: 'transfer',
      args: [getAddress(ALICE), parseUnits('10', 6)],
    });
    expect(fee).toMatchObject({ target: TOKEN, value: 0n });
    expect(decodeTransfer(fee!.callData)).toMatchObject({
      functionName: 'transfer',
      args: [getAddress(FEE), parseUnits('0.05', 6)],
    });
  });

  it('ETH: native value with empty data, no memo (§14.2 rule 1)', () => {
    const ethAutopay = autopay({ type: 'native', token: null, decimals: 18 }, '0.01', '0.00002');
    expect(executionsOf(ethAutopay)).toEqual([
      { target: ALICE, value: parseUnits('0.01', 18), callData: '0x' },
      { target: FEE, value: parseUnits('0.00002', 18), callData: '0x' },
    ]);
  });
});

describe('redeemCalldata', () => {
  it('uses batch mode and carries the same executions (B10)', () => {
    const delegation = {
      delegate: FEE,
      delegator: ME as Hex,
      authority: `0x${'ff'.repeat(32)}` as Hex,
      caveats: [],
      salt: '1',
      signature: '0x' as Hex,
    };
    const redeem = redeemCalldata(usdcAutopay, delegation);
    expect(redeem.slice(0, 10)).toBe('0xcef6d209'); // the selector IntentExecutorV4 requires

    const { args } = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'redeemDelegations',
          stateMutability: 'nonpayable',
          inputs: [{ type: 'bytes[]' }, { type: 'bytes32[]' }, { type: 'bytes[]' }],
          outputs: [],
        },
      ],
      data: redeem,
    });
    const [contexts, modes, execs] = args;
    expect(contexts).toHaveLength(1);
    expect(modes).toEqual(['0x0100000000000000000000000000000000000000000000000000000000000000']);
    const [decoded] = decodeAbiParameters(
      [
        {
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      execs[0]!,
    );
    expect(decoded).toHaveLength(2);
    expect(decoded[0]!.callData).toBe(executionsOf(usdcAutopay)[0]!.callData);
    expect(decoded[1]!.callData).toBe(executionsOf(usdcAutopay)[1]!.callData);
  });
});

describe('permissionRedeem (F8)', () => {
  const contextOf = (delegate: Hex) =>
    encodeAbiParameters(parseAbiParameters(`${DELEGATION}[]`), [
      [
        {
          delegate,
          delegator: ME as Hex,
          authority: `0x${'ff'.repeat(32)}`,
          caveats: [],
          salt: 1n,
          signature: '0x',
        },
      ],
    ]);
  const context = contextOf(FEE);
  const SINGLE = `0x${'00'.repeat(32)}`;

  it('runs each payment as its own single execution, all under the one context', () => {
    const redeem = permissionRedeem(usdcAutopay, context);
    const { args } = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: redeem });
    const [contexts, modes] = args as unknown as [Hex[], Hex[]];
    expect(contexts).toEqual([context, context]);
    expect(modes).toEqual([SINGLE, SINGLE]);
    expect(decodeRedeemBatch(redeem)).toEqual(
      executionsOf(usdcAutopay).map((e) => ({ ...e, target: e.target.toLowerCase() })),
    );
    expect(redeemIdentity(redeem)).toEqual({ delegator: getAddress(ME), delegate: getAddress(FEE) });
    expect(delegationFromRedeem(redeem)?.delegate).toBe(getAddress(FEE));
  });

  it('ETH payments carry the value and no calldata', () => {
    const eth = autopay({ type: 'native', token: null, decimals: 18 }, '0.01', '0.0001');
    expect(decodeRedeemBatch(permissionRedeem(eth, context))).toEqual([
      { target: ALICE, value: parseUnits('0.01', 18), callData: '0x' },
      { target: FEE, value: parseUnits('0.0001', 18), callData: '0x' },
    ]);
  });

  it('refuses entries that mix contexts or modes', () => {
    const { args } = decodeFunctionData({ abi: DELEGATION_MANAGER_ABI, data: permissionRedeem(usdcAutopay, context) });
    const [, modes, executions] = args as unknown as [Hex[], Hex[], Hex[]];
    const redeem = (contexts: Hex[], m: Hex[]) =>
      encodeFunctionData({
        abi: DELEGATION_MANAGER_ABI,
        functionName: 'redeemDelegations',
        args: [contexts, m, executions],
      });
    const mixed = redeem([context, contextOf(ALICE)], modes);
    expect(() => redeemIdentity(mixed)).toThrow('INVALID_REDEEM');
    expect(decodeRedeemBatch(mixed)).toBeNull();
    expect(delegationFromRedeem(mixed)).toBeNull();
    expect(decodeRedeemBatch(redeem([context, context], [SINGLE as Hex, `0x01${'00'.repeat(31)}`]))).toBeNull();
  });
});
