// Browser approvals are persisted in the encrypted step store. No server signing fallback. A recurring plan asks MetaMask
// for one periodic permission (F8); MetaMask's answer is verified before its context is kept.
import { createHash } from 'node:crypto';
import type { SmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import type { Hex } from 'viem';
import { verifyGrant, type PermissionRequest } from '../autopay/permission.js';
import type { Store } from '../store/store.js';

export class SignaturePending extends Error {}
export class SignatureRejected extends Error {}
export interface DelegationRequest {
  id: Hex;
  requestId: string;
  step: number;
  permissionRequest: PermissionRequest;
  /** The verified permission context MetaMask granted. */
  context?: Hex;
  rejected?: boolean;
}

/** Resolves to the granted context once the page has posted a verified grant; until then saves the request and waits. */
export function browserPermissionGranter(store: Store, requestId: string, step: number) {
  return async (permissionRequest: PermissionRequest): Promise<Hex> => {
    const id = `0x${createHash('sha256')
      .update(JSON.stringify([requestId, step, permissionRequest]))
      .digest('hex')}` as Hex;
    const saved = store.stepData<DelegationRequest>(requestId, step);
    if (saved) {
      if (saved.id !== id) throw new Error('DELEGATION_CHANGED');
      if (saved.rejected) throw new SignatureRejected();
      if (saved.context) return saved.context;
    } else store.saveStepData(requestId, step, { id, requestId, step, permissionRequest });
    throw new SignaturePending();
  };
}

export function pendingDelegations(store: Store): DelegationRequest[] {
  return store.unfinishedRequests().flatMap((envelope) =>
    envelope.intents.flatMap((intent) => {
      if (intent.intent_id !== 'k' || store.step(envelope.request_id, intent.step).status !== 'approved') return [];
      const request = store.stepData<DelegationRequest>(envelope.request_id, intent.step);
      return request?.permissionRequest && !request.context && !request.rejected ? [request] : [];
    }),
  );
}

/** Keeps MetaMask's grant only when it is exactly what was asked (throws a PermissionError otherwise), or the rejection. */
export function approveDelegation(
  store: Store,
  envFor: (chainId: number) => SmartAccountsEnvironment,
  id: string,
  response: unknown,
  reject = false,
) {
  const request = pendingDelegations(store).find((item) => item.id === id);
  if (!request) throw new Error('DELEGATION_NOT_PENDING');
  const { permissionRequest } = request;
  store.saveStepData(request.requestId, request.step, {
    ...request,
    ...(reject
      ? { rejected: true }
      : { context: verifyGrant(permissionRequest, response, envFor(Number(permissionRequest.chainId))) }),
  });
}
