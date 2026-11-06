// Selected official CCIP 2.0 ABI entries from @chainlink/ccip-sdk 1.16.1 (MIT).
// https://github.com/smartcontractkit/ccip-tools-ts/tree/v1.16.1/packages/ccip-sdk/src/evm/abi
// License: CCIP_ABI_LICENSE.txt
export const CCIP_V2_EVENTS = [
  {
    type: 'event',
    name: 'CCIPMessageSent',
    inputs: [
      {
        name: 'destChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'messageId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'feeToken',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'tokenAmountBeforeTokenPoolFees',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
      {
        name: 'encodedMessage',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
      {
        name: 'receipts',
        type: 'tuple[]',
        indexed: false,
        internalType: 'struct OnRamp.Receipt[]',
        components: [
          {
            name: 'issuer',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'destGasLimit',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'feeTokenAmount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'extraArgs',
            type: 'bytes',
            internalType: 'bytes',
          },
        ],
      },
      {
        name: 'verifierBlobs',
        type: 'bytes[]',
        indexed: false,
        internalType: 'bytes[]',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ExecutionStateChanged',
    inputs: [
      {
        name: 'sourceChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'messageNumber',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'messageId',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'state',
        type: 'uint8',
        indexed: false,
        internalType: 'enum Internal.MessageExecutionState',
      },
      {
        name: 'returnData',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
] as const;
