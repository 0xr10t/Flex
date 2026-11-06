// Implements: Appendix A.1. MetaMask's contracts are at the same addresses on all three testnets.

import { concat, type Hex } from 'viem';

export const EIP7702_DELEGATOR: Hex = '0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B';

/** What an account's code must be once it is delegated to the DeleGator. */
export const UPGRADED_CODE = concat(['0xef0100', EIP7702_DELEGATOR]).toLowerCase();
