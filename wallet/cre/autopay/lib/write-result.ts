import { bytesToHex, TxStatus } from '@chainlink/cre-sdk';
import { EVM_PB } from '@chainlink/cre-sdk/pb';

/** A successful submission is not proof of payment; the finalized Executed event supplies that proof. */
export function successfulWriteHash(
  written: Pick<EVM_PB.WriteReportReply, 'txStatus' | 'receiverContractExecutionStatus' | 'txHash'>,
) {
  if (
    written.txStatus !== TxStatus.SUCCESS ||
    written.receiverContractExecutionStatus !== EVM_PB.ReceiverContractExecutionStatus.SUCCESS ||
    written.txHash?.length !== 32 ||
    !written.txHash.some((byte) => byte !== 0)
  )
    throw new Error('CRE report delivery not confirmed');
  return bytesToHex(written.txHash);
}
