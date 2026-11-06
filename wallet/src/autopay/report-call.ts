// The call the CRE forwarder would make to pay a run. Simulating it shows whether a run would really pay. It passes the metadata
// the executor expects, so the check still works once `setExpectedWorkflowId` is set.

import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodePacked, type Hex } from 'viem';
import type { ChainGateway, SimCall } from '../chain/gateway.js';
import { EXECUTOR_ABI } from './abi.js';

export async function reportCall(gateway: ChainGateway, executor: Hex, redeem: Hex): Promise<SimCall> {
  const read = (
    functionName: 'getForwarderAddress' | 'getExpectedAuthor' | 'getExpectedWorkflowId' | 'getExpectedWorkflowName',
  ) => gateway.call(executor, encodeFunctionData({ abi: EXECUTOR_ABI, functionName }));
  const [fromData, ownerData, idData, nameData] = await Promise.all([
    read('getForwarderAddress'),
    read('getExpectedAuthor'),
    read('getExpectedWorkflowId'),
    read('getExpectedWorkflowName'),
  ]);
  const from = decodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'getForwarderAddress', data: fromData });
  const owner = decodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'getExpectedAuthor', data: ownerData });
  const id = decodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'getExpectedWorkflowId', data: idData });
  const name = decodeFunctionResult({ abi: EXECUTOR_ABI, functionName: 'getExpectedWorkflowName', data: nameData });
  const metadata = encodePacked(['bytes32', 'bytes10', 'address'], [id, name, owner]);
  const report = encodeAbiParameters([{ type: 'bytes' }], [redeem]);
  return {
    from,
    to: executor,
    data: encodeFunctionData({ abi: EXECUTOR_ABI, functionName: 'onReport', args: [metadata, report] }),
  };
}
