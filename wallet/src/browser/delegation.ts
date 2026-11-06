// Browser approvals are persisted in the encrypted step store. No server signing fallback.
import { createHash } from 'node:crypto';
import { verifyTypedData, type Hex } from 'viem';
import type { SignTypedData } from '../autopay/delegation.js';
import type { Store } from '../store/store.js';

export class SignaturePending extends Error {}
export class SignatureRejected extends Error {}
export interface DelegationRequest {
  id: Hex;
  requestId: string;
  step: number;
  typedData: Parameters<SignTypedData>[0];
  signature?: Hex;
  rejected?: boolean;
}
const encode = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export function browserDelegationSigner(store: Store, requestId: string, step: number): SignTypedData {
  return async (typedData) => {
    const id = `0x${createHash('sha256')
      .update(encode([requestId, step, typedData]))
      .digest('hex')}` as Hex;
    const saved = store.stepData<DelegationRequest>(requestId, step);
    if (saved) {
      if (saved.id !== id) throw new Error('DELEGATION_CHANGED');
      if (saved.rejected) throw new SignatureRejected();
      if (saved.signature) return saved.signature;
    } else store.saveStepData(requestId, step, JSON.parse(encode({ id, requestId, step, typedData })));
    throw new SignaturePending();
  };
}

export function pendingDelegations(store: Store): DelegationRequest[] {
  return store.unfinishedRequests().flatMap((envelope) =>
    envelope.intents.flatMap((intent) => {
      if (intent.intent_id !== 'k' || store.step(envelope.request_id, intent.step).status !== 'approved') return [];
      const request = store.stepData<DelegationRequest>(envelope.request_id, intent.step);
      return request?.typedData && !request.signature && !request.rejected ? [request] : [];
    }),
  );
}

export async function approveDelegation(store: Store, wallet: Hex, id: string, signature: unknown, reject = false) {
  const request = pendingDelegations(store).find((item) => item.id === id);
  if (!request) throw new Error('DELEGATION_NOT_PENDING');
  if (
    !reject &&
    (typeof signature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature) ||
      !(await verifyTypedData({ ...request.typedData, address: wallet, signature: signature as Hex } as never)))
  )
    throw new Error('DELEGATION_SIGNATURE_INVALID');
  // Verification awaits: recheck that cancellation or another approval did not win in the meantime.
  if (!pendingDelegations(store).some((item) => item.id === id)) throw new Error('DELEGATION_NOT_PENDING');
  store.saveStepData(request.requestId, request.step, {
    ...request,
    ...(reject ? { rejected: true } : { signature }),
  });
}
