// The parts of IntentExecutorV3 and DelegationManager the wallet uses. Viem-only, so this also works inside CRE.

import { parseAbi } from 'viem';

export const EXECUTOR_ABI = parseAbi([
  'function register(uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, bytes redeem) returns (bytes32)',
  'function cancel(bytes32 id)',
  'function onReport(bytes metadata, bytes report)',
  'function getForwarderAddress() view returns (address)',
  'function getExpectedAuthor() view returns (address)',
  'function getExpectedWorkflowId() view returns (bytes32)',
  'function getExpectedWorkflowName() view returns (bytes10)',
  'function plans(bytes32 id) view returns (address delegator, uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, uint64 paid, int64 lastSlot, bool cancelled)',
  'event Registered(bytes32 indexed intentId, address indexed delegator, uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, bytes redeem)',
  'event Executed(bytes32 indexed intentId, uint64 slot, uint64 paid)',
  'event Cancelled(bytes32 indexed intentId, address indexed delegator)',
]);

const DELEGATION =
  '(address delegate, address delegator, bytes32 authority, (address enforcer, bytes terms, bytes args)[] caveats, uint256 salt, bytes signature)';

export const DELEGATION_MANAGER_ABI = parseAbi([
  `function disableDelegation(${DELEGATION} delegation)`,
  'function disabledDelegations(bytes32 hash) view returns (bool)',
  'function redeemDelegations(bytes[] contexts, bytes32[] modes, bytes[] executions)',
  `event DisabledDelegation(bytes32 indexed delegationHash, address indexed delegator, address indexed delegate, ${DELEGATION} delegation)`,
]);
