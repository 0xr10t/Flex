// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/// IntentExecutorV2 + user-side registration (no HTTP intake, no gateway key).
///  - register(): sent by the user's own wallet. Checks the delegation is FROM msg.sender and TO this contract,
///    stores only the hash + schedule, emits the full redeem calldata (the cron reads its plan list from these events).
///  - reports (CRE cron) can only RUN registered plans; they can no longer create one or choose its schedule.
///  - cancel(): the user stops the plan here; the wallet also calls DelegationManager.disableDelegation in the same batch.
/// V4 (F8): a redeem may hold several entries, all with the same context, because a MetaMask periodic permission allows
/// only single executions: one entry per payee. Modes and executions are left to the DelegationManager and enforcers.
contract IntentExecutorV4 is ReceiverTemplate {
  bytes4 private constant REDEEM = 0xcef6d209; // redeemDelegations(bytes[],bytes32[],bytes[])

  struct Caveat { address enforcer; bytes terms; bytes args; }
  struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }

  struct Plan {
    address delegator;
    uint64 startAt;
    uint64 interval;
    uint64 lateWindow;
    uint64 maxRuns;
    uint64 paid;
    int64 lastSlot; // -1 = none paid yet
    bool cancelled;
  }

  address public immutable delegationManager;
  mapping(bytes32 => Plan) public plans;

  event Registered(bytes32 indexed intentId, address indexed delegator, uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, bytes redeem);
  event Executed(bytes32 indexed intentId, uint64 slot, uint64 paid);
  event Cancelled(bytes32 indexed intentId, address indexed delegator);

  error NotRedeemCall();
  error BadRedeemShape();
  error NotYourDelegation(address delegator, address sender);
  error WrongDelegate(address delegate);
  error AlreadyRegistered(bytes32 intentId);
  error NotRegistered(bytes32 intentId);
  error PlanCancelled(bytes32 intentId);
  error NotStarted(bytes32 intentId, uint64 startAt);
  error Exhausted(bytes32 intentId);
  error OutsideWindow(bytes32 intentId, uint64 slot, uint256 slotTime);
  error SlotAlreadyPaid(bytes32 intentId, uint64 slot);
  error BadPlan();

  constructor(address forwarder, address _delegationManager) ReceiverTemplate(forwarder) {
    delegationManager = _delegationManager;
  }

  function register(uint64 startAt, uint64 interval, uint64 lateWindow, uint64 maxRuns, bytes calldata redeem)
    external returns (bytes32 id)
  {
    if (redeem.length < 4 || bytes4(redeem[:4]) != REDEEM) revert NotRedeemCall();
    if (interval == 0 || maxRuns == 0 || lateWindow == 0 || lateWindow > interval) revert BadPlan();
    (bytes[] memory contexts, bytes32[] memory modes, bytes[] memory execs) = abi.decode(redeem[4:], (bytes[], bytes32[], bytes[]));
    if (contexts.length == 0 || modes.length != contexts.length || execs.length != contexts.length) revert BadRedeemShape();
    bytes32 context = keccak256(contexts[0]);
    for (uint256 i = 1; i < contexts.length; i++) if (keccak256(contexts[i]) != context) revert BadRedeemShape();
    Delegation[] memory chain = abi.decode(contexts[0], (Delegation[]));
    if (chain.length != 1) revert BadRedeemShape();
    if (chain[0].delegator != msg.sender) revert NotYourDelegation(chain[0].delegator, msg.sender);
    if (chain[0].delegate != address(this)) revert WrongDelegate(chain[0].delegate);

    id = keccak256(redeem);
    if (plans[id].maxRuns != 0) revert AlreadyRegistered(id);
    plans[id] = Plan(msg.sender, startAt, interval, lateWindow, maxRuns, 0, -1, false);
    emit Registered(id, msg.sender, startAt, interval, lateWindow, maxRuns, redeem);
  }

  function cancel(bytes32 id) external {
    Plan storage p = plans[id];
    if (p.maxRuns == 0) revert NotRegistered(id);
    if (p.delegator != msg.sender) revert NotYourDelegation(p.delegator, msg.sender);
    p.cancelled = true;
    emit Cancelled(id, msg.sender);
  }

  /// report = abi.encode(bytes redeem)
  function _processReport(bytes calldata report) internal override {
    bytes memory redeem = abi.decode(report, (bytes));
    bytes32 id = keccak256(redeem);
    Plan storage p = plans[id];
    if (p.maxRuns == 0) revert NotRegistered(id);
    if (p.cancelled) revert PlanCancelled(id);

    if (block.timestamp < p.startAt) revert NotStarted(id, p.startAt);
    uint64 slot = uint64((block.timestamp - p.startAt) / p.interval);
    if (slot >= p.maxRuns) revert Exhausted(id);
    uint256 slotTime = uint256(p.startAt) + uint256(slot) * p.interval;
    if (block.timestamp > slotTime + p.lateWindow) revert OutsideWindow(id, slot, slotTime);
    if (int64(slot) <= p.lastSlot) revert SlotAlreadyPaid(id, slot);

    p.lastSlot = int64(slot);
    p.paid++;
    (bool ok, bytes memory ret) = delegationManager.call(redeem);
    if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    emit Executed(id, slot, p.paid);
  }
}
