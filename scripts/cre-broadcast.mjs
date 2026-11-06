// Local testnet orchestration. Signing stays inside the native CRE CLI; this module only reads chain state.
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { EXECUTOR_ABI } from '../wallet/dist/src/autopay/abi.js';
import { SIMULATION_FORWARDERS } from '../wallet/dist/src/autopay/local-cre.js';
import { redeemIdentity } from '../wallet/dist/src/chain/redeem.v2.js';

const permissions = parseAbi([
  'function owner() view returns (address)',
  'function delegationManager() view returns (address)',
  'function getForwarderAddress() view returns (address)',
  'function getExpectedAuthor() view returns (address)',
  'function getExpectedWorkflowName() view returns (bytes10)',
  'function getExpectedWorkflowId() view returns (bytes32)',
]);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const keyOf = (chain, id, slot) => `${chain.chainId}:${chain.executor.toLowerCase()}:${id.toLowerCase()}:${slot}`;
const call = async (rpc, address, abi, functionName, args = []) =>
  decodeFunctionResult({
    abi,
    functionName,
    data: await rpc('eth_call', [{ to: address, data: encodeFunctionData({ abi, functionName, args }) }, 'latest']),
  });

export function candidatePlans(chain, walletAddress, now) {
  const due = [];
  for (const plan of chain.snapshot.plans) {
    try {
      const identity = redeemIdentity(plan.redeem);
      if (!same(identity.delegator, walletAddress) || !same(identity.delegate, chain.executor) || plan.cancelled)
        continue;
      const start = BigInt(plan.startAt),
        interval = BigInt(plan.interval);
      if (now < start || interval <= 0n) continue;
      const slot = (now - start) / interval;
      const closes = start + slot * interval + BigInt(plan.lateWindow);
      if (slot >= BigInt(plan.maxRuns) || slot <= BigInt(plan.lastSlot) || now > closes) continue;
      due.push({ plan, slot: String(slot), closes });
    } catch {
      /* A malformed or unrelated registration never spends this transmitter's gas. */
    }
  }
  return due.sort((a, b) => (a.closes < b.closes ? -1 : a.closes > b.closes ? 1 : a.plan.id.localeCompare(b.plan.id)));
}

export async function checkReceiver(chain, walletAddress, rpc, expectedOwner) {
  if (!same(chain.forwarder, SIMULATION_FORWARDERS[chain.chainId])) throw new Error('SIMULATION_FORWARDER_REQUIRED');
  const [chainId, code, forwarderCode, ...values] = await Promise.all([
    rpc('eth_chainId', []),
    rpc('eth_getCode', [chain.executor, 'latest']),
    rpc('eth_getCode', [chain.forwarder, 'latest']),
    ...[
      'owner',
      'delegationManager',
      'getForwarderAddress',
      'getExpectedAuthor',
      'getExpectedWorkflowName',
      'getExpectedWorkflowId',
    ].map((name) => call(rpc, chain.executor, permissions, name)),
  ]);
  const [owner, manager, forwarder, ...identity] = values;
  if (
    BigInt(chainId) !== BigInt(chain.chainId) ||
    code === '0x' ||
    forwarderCode === '0x' ||
    (expectedOwner !== undefined && !same(owner, expectedOwner)) ||
    !same(forwarder, chain.forwarder) ||
    identity.some((value) => !/^0x0+$/.test(value)) ||
    /^0x0+$/.test(manager) ||
    (await rpc('eth_getCode', [manager, 'latest'])) === '0x'
  )
    throw new Error('EXECUTOR_CONFIG_MISMATCH');
}

/** A CLI return/receipt is not a payment. Require this executor's event for the exact plan and slot. */
export function receiptOutcome(receipt, chain, entry) {
  if (!receipt) return 'pending';
  if (
    !same(receipt.transactionHash, entry.tx) ||
    !same(receipt.from, entry.transmitter) ||
    !same(receipt.to, chain.forwarder)
  )
    throw new Error('SUBMISSION_RECEIPT_MISMATCH');
  if (receipt.status !== '0x1') return 'failed';
  for (const log of receipt.logs ?? []) {
    if (!same(log.address, chain.executor) || log.removed) continue;
    try {
      const event = decodeEventLog({ abi: EXECUTOR_ABI, data: log.data, topics: log.topics });
      if (
        event.eventName === 'Executed' &&
        same(event.args.intentId, entry.id) &&
        String(event.args.slot) === entry.slot &&
        event.args.paid > 0n
      )
        return 'mined';
    } catch {
      /* Ignore other logs in the receipt. */
    }
  }
  return 'receiver_failed';
}

/** Persist before starting the child process. An uncertain write is never automatically submitted again. */
export async function runTestnetChain({
  config,
  chain,
  rpc,
  transmitter,
  broadcast,
  journal,
  save,
  simulate,
  now = BigInt(Math.floor(Date.now() / 1000)),
}) {
  await checkReceiver(chain, config.walletAddress, rpc);
  const records = Object.values(journal.entries).filter(
    (e) => e.chainId === chain.chainId && same(e.executor, chain.executor),
  );
  let blocked = null;
  for (const entry of records) {
    if (['mined', 'observed', 'failed', 'receiver_failed', 'skipped'].includes(entry.state)) continue;
    if (entry.tx) {
      entry.state = receiptOutcome(await rpc('eth_getTransactionReceipt', [entry.tx]), chain, entry);
      if (entry.state === 'pending') blocked = 'TRANSACTION_PENDING';
    } else {
      const state = await call(rpc, chain.executor, EXECUTOR_ABI, 'plans', [entry.id]);
      if (state[6] >= BigInt(entry.slot)) entry.state = 'observed';
      else blocked = 'SUBMISSION_UNKNOWN';
    }
  }
  save();
  if (blocked) return { chainId: chain.chainId, executor: chain.executor, status: 'blocked', code: blocked };

  for (const { plan, slot } of candidatePlans(chain, config.walletAddress, now)) {
    const key = keyOf(chain, plan.id, slot);
    if (journal.entries[key]) continue;
    // The finalized discovery index can lag a successful submission or a cancellation. Check current state before paying gas.
    const state = await call(rpc, chain.executor, EXECUTOR_ABI, 'plans', [plan.id]);
    if (!same(state[0], config.walletAddress) || state[7] || state[6] >= BigInt(slot)) continue;
    const invocation = {
      mode: 'testnet-dry-run',
      schedule: config.schedule,
      walletAddress: config.walletAddress,
      maxSimulationsPerRun: 1,
      chains: [{ ...chain, snapshot: { ...chain.snapshot, plans: [plan] } }],
    };
    const dry = await simulate(invocation);
    const result = dry.results?.[0];
    const identity = { chainId: chain.chainId, executor: chain.executor, id: plan.id, slot };
    if (!result) return { ...identity, status: 'not_due' };
    if (result.chainId !== chain.chainId || !same(result.id, plan.id) || result.slot !== slot)
      throw new Error('CRE_RESULT_PLAN_MISMATCH');
    if (result.status !== 'would_execute' || !broadcast) return { ...result, executor: chain.executor };
    if (!/^0x[0-9a-fA-F]{40}$/.test(transmitter) || /^0x0+$/.test(transmitter))
      throw new Error('TRANSMITTER_ADDRESS_REQUIRED');
    const [minedNonce, pendingNonce, balance, gasPrice] = await Promise.all([
      rpc('eth_getTransactionCount', [transmitter, 'latest']),
      rpc('eth_getTransactionCount', [transmitter, 'pending']),
      rpc('eth_getBalance', [transmitter, 'latest']),
      rpc('eth_gasPrice', []),
    ]);
    if (BigInt(minedNonce) !== BigInt(pendingNonce))
      return { ...identity, status: 'blocked', code: 'TRANSMITTER_BUSY' };
    if (!/^\d+$/.test(result.gasLimit) || BigInt(result.gasLimit) > 10_000_000n) throw new Error('CRE_GAS_INVALID');
    if (BigInt(balance) < BigInt(gasPrice) * BigInt(result.gasLimit) * 2n)
      return { ...identity, status: 'blocked', code: 'TRANSMITTER_GAS_REQUIRED' };
    // Do not cross a slot boundary between the dry run and the second native invocation.
    const stillDue = candidatePlans(invocation.chains[0], config.walletAddress, BigInt(Math.floor(Date.now() / 1000)));
    if (stillDue[0]?.slot !== slot) return { ...identity, skipped: 'window_closed' };
    const entry = {
      ...identity,
      transmitter,
      nonce: String(BigInt(minedNonce)),
      state: 'started',
      startedAt: new Date().toISOString(),
    };
    journal.entries[key] = entry;
    save();
    try {
      const written = await simulate({ ...invocation, mode: 'testnet-broadcast', expectedRun: { id: plan.id, slot } });
      const sent = written.results?.[0];
      if (sent && (sent.chainId !== chain.chainId || !same(sent.id, plan.id) || sent.slot !== slot))
        throw new Error('CRE_RESULT_PLAN_MISMATCH');
      if (sent?.status === 'submitted') {
        if (!/^0x[0-9a-fA-F]{64}$/.test(sent.tx) || /^0x0+$/.test(sent.tx)) throw new Error('CRE_TX_HASH_REQUIRED');
        entry.tx = sent.tx;
        entry.state = 'submitted';
        save();
        entry.state = receiptOutcome(await rpc('eth_getTransactionReceipt', [entry.tx]), chain, entry);
        save();
        return { ...identity, status: entry.state, tx: entry.tx };
      }
      if (sent?.skipped || written.due === 0) {
        entry.state = 'skipped';
        save();
        return { ...identity, skipped: sent?.skipped ?? 'window_closed' };
      }
      throw new Error('CRE_RESULT_INVALID');
    } catch (error) {
      if (!entry.tx) entry.state = 'unknown';
      save();
      throw error;
    }
  }
  return { chainId: chain.chainId, executor: chain.executor, status: 'idle' };
}
