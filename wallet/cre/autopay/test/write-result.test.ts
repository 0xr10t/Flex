import { TxStatus } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';
import { describe, expect, it } from 'vitest';
import { successfulWriteHash } from '../lib/write-result.js';

const success = {
  txStatus: TxStatus.SUCCESS,
  receiverContractExecutionStatus: EVM_PB.ReceiverContractExecutionStatus.SUCCESS,
  txHash: new Uint8Array(32).fill(0xab),
};

describe('CRE report delivery result', () => {
  it('returns the confirmed transaction hash without fabricating a fallback', () => {
    expect(successfulWriteHash(success)).toBe(`0x${'ab'.repeat(32)}`);
  });
  it.each([
    { txStatus: TxStatus.FATAL },
    { txStatus: TxStatus.REVERTED },
    { receiverContractExecutionStatus: EVM_PB.ReceiverContractExecutionStatus.REVERTED },
    { receiverContractExecutionStatus: undefined },
    { txHash: undefined },
    { txHash: new Uint8Array(31).fill(1) },
    { txHash: new Uint8Array(32) },
  ])('rejects an unconfirmed, reverted or malformed delivery (%#)', (change) => {
    expect(() => successfulWriteHash({ ...success, ...change })).toThrow('CRE report delivery not confirmed');
  });
});
