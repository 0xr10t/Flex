import { randomBytes } from 'node:crypto';
import { formatUnits, parseUnits, type Hex } from 'viem';
import { UPGRADED_CODE } from '../chain/addresses.js';
import type { ChainGateway } from '../chain/gateway.js';
import { checkEnvelope } from '@flex/protocol/mapping/check';
import { placeholderHashes } from '@flex/protocol/mapping/to-plan';
import { validateEnvelope, type ChainId, type HandoffEnvelope } from '@flex/protocol/schemas/envelope';
import { USDC } from '@flex/protocol/schemas/intent.v2';
import type { Store } from '../store/store.js';
import type { WalletBatchPayload } from './types.js';

export class BrowserWalletError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class BrowserWalletController {
  constructor(
    private readonly deps: {
      store: Store;
      walletAddress: Hex;
      chainIds: readonly number[];
      feeMaxEth: string;
      gatewayFor: (chain: number) => ChainGateway;
      kick: () => void;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  state() {
    return {
      wallet: this.deps.walletAddress,
      chainIds: this.deps.chainIds,
      feeMaxEth: this.deps.feeMaxEth,
      batches: this.deps.store.walletBatches().map((batch) => {
        const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
        const step = this.deps.store.step(batch.request_id, batch.step);
        const data = this.deps.store.stepData<Record<string, unknown>>(batch.request_id, batch.step);
        return {
          id: batch.batch_id,
          walletId: payload.providerBatchId ?? batch.batch_id,
          requestId: batch.request_id,
          chainId: batch.chain_id,
          status: batch.status,
          stepStatus: step.status,
          errorCode: step.error_code,
          txHash: step.tx_hash,
          createdMs: batch.created_ms,
          expired: this.now() > batch.created_ms + 60_000,
          summary: payload.summary,
          tracking: data?.tracking_status,
          delayed: data?.delayed,
          message: data?.message,
          destinationTxHash: data?.destination_tx_hash ?? data?.observed_destination_tx_hash,
          feeWei: data?.fee_wei,
          intent: this.deps.store.envelope(batch.request_id)?.intents.find((i) => i.step === batch.step),
        };
      }),
      requests: this.deps.store.recentRequests().map((e) => ({
        id: e.request_id,
        steps: this.deps.store
          .stepsOf(e.request_id)
          .map((s) => ({ step: s.step, status: s.status, error: s.error_code })),
      })),
    };
  }

  /** Typed form data enters the same schema and runner as the agent's requests. Prepares only. */
  createBridge(input: unknown): string {
    if (!input || typeof input !== 'object') throw new BrowserWalletError('INVALID_BRIDGE');
    const x = input as Record<string, unknown>;
    const source = x.sourceChainId as ChainId,
      dest = x.destChainId as ChainId;
    if (
      !this.deps.chainIds.includes(source) ||
      !this.deps.chainIds.includes(dest) ||
      source === dest ||
      typeof x.amount !== 'string' ||
      !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(x.amount) ||
      x.amount.length > 60
    )
      throw new BrowserWalletError('INVALID_BRIDGE');
    const amount = parseUnits(x.amount, 6);
    if (amount <= 0n) throw new BrowserWalletError('INVALID_BRIDGE');
    const envelope: HandoffEnvelope = {
      version: '2',
      request_id: `req_${randomBytes(6).toString('hex')}`,
      wallet_address: this.deps.walletAddress,
      created_at: new Date(this.now()).toISOString(),
      intents: [
        {
          intent_id: 'j',
          step: 0,
          token: 'USDC',
          source_token_address: USDC[source],
          dest_token_address: USDC[dest],
          source_chain_id: source,
          dest_chain_id: dest,
          amount: { value: formatUnits(amount, 6), base_units: amount.toString(), decimals: 6 },
          receiver: 'self',
          fee_max_eth: this.deps.feeMaxEth,
          funds_steps: [],
        },
      ],
    };
    if (
      !validateEnvelope(envelope).ok ||
      !checkEnvelope(envelope, { delegationHashes: placeholderHashes(envelope) }).ok
    )
      throw new BrowserWalletError('INVALID_BRIDGE');
    this.deps.store.insertRequest(envelope, envelope.created_at);
    this.deps.kick();
    return envelope.request_id;
  }

  claim(id: string) {
    const batch = this.deps.store.walletBatchById(id);
    if (!batch || !this.deps.store.claimWalletBatch(id, this.now()))
      throw new BrowserWalletError('REFRESH_OR_RECOVER_BATCH');
    return (JSON.parse(batch.payload_json) as WalletBatchPayload).calls;
  }

  refresh(id: string) {
    if (!this.deps.store.deleteDraftWalletBatch(id)) throw new BrowserWalletError('BATCH_ALREADY_DISPATCHED');
    this.deps.kick();
  }

  reject(id: string) {
    if (!this.deps.store.rejectWalletBatch(id)) throw new BrowserWalletError('BATCH_ALREADY_RECEIVED');
    this.deps.kick();
  }

  rememberWalletId(id: string, providerId: unknown) {
    if (
      typeof providerId !== 'string' ||
      !/^0x[0-9a-fA-F]{1,512}$/.test(providerId) ||
      !this.deps.store.rememberWalletBatchId(id, providerId)
    )
      throw new BrowserWalletError('WALLET_ID_UNVERIFIED');
  }

  async recover(id: string, hash: unknown) {
    const batch = this.deps.store.walletBatchById(id);
    if (!batch) throw new BrowserWalletError('BATCH_NOT_DISPATCHED');
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    // The exact atomic calldata is independently verified by receive; a pasted hash never authorizes another send.
    return this.receive(id, {
      id: payload.providerBatchId ?? id,
      chainId: payload.calls.chainId,
      atomic: true,
      receipts: [{ transactionHash: hash }],
    });
  }

  /** Browser status is only a hint: inspect the actual chain transaction, not client-supplied logs. */
  async receive(id: string, input: unknown) {
    const batch = this.deps.store.walletBatchById(id);
    if (!batch || !['dispatched', 'received'].includes(batch.status))
      throw new BrowserWalletError('BATCH_NOT_DISPATCHED');
    const status = input as {
      id?: unknown;
      chainId?: unknown;
      atomic?: unknown;
      receipts?: { transactionHash?: unknown }[];
    } | null;
    const payload = JSON.parse(batch.payload_json) as WalletBatchPayload;
    if (
      !status ||
      status.id !== (payload.providerBatchId ?? id) ||
      status.chainId !== payload.calls.chainId ||
      status.atomic !== true ||
      !Array.isArray(status.receipts) ||
      status.receipts.length !== 1 ||
      typeof status.receipts[0]?.transactionHash !== 'string' ||
      !/^0x[0-9a-fA-F]{64}$/.test(status.receipts[0].transactionHash)
    )
      throw new BrowserWalletError('WALLET_RESULT_UNVERIFIED');
    const hash = status.receipts[0].transactionHash as Hex;
    const gateway = this.deps.gatewayFor(batch.chain_id);
    const tx = await gateway.getTransaction(hash);
    const receipt = await gateway.getReceipt(hash);
    if (!tx || !receipt) throw new BrowserWalletError('TRANSACTION_NOT_MINED');
    if (
      tx.from.toLowerCase() !== this.deps.walletAddress.toLowerCase() ||
      tx.to.toLowerCase() !== payload.expectedTx.to.toLowerCase() ||
      tx.data.toLowerCase() !== payload.expectedTx.data.toLowerCase() ||
      tx.value !== 0n ||
      tx.nonce < payload.minNonce ||
      tx.blockNumber === null ||
      tx.blockNumber <= payload.sourceBlock ||
      receipt.blockNumber !== tx.blockNumber ||
      (await gateway.getCode(this.deps.walletAddress))?.toLowerCase() !== UPGRADED_CODE
    )
      throw new BrowserWalletError('TRANSACTION_DOES_NOT_MATCH');
    if (!this.deps.store.receiveWalletBatch(id, hash)) throw new BrowserWalletError('BATCH_ALREADY_RECEIVED');
    this.deps.kick();
  }
}
