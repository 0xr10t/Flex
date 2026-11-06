import { toAccount } from 'viem/accounts';
import type { Hex } from 'viem';

/** Public-address adapter for read clients. Every signing operation is deliberately unavailable. */
export function browserAccount(address: Hex) {
  const unavailable = async (): Promise<never> => {
    throw new Error('sign through the browser wallet');
  };
  return toAccount({ address, signMessage: unavailable, signTransaction: unavailable, signTypedData: unavailable });
}
