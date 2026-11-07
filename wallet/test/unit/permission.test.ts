// F8: MetaMask builds a permission's caveats itself, so its answer is checked against MetaMask's own caveat code
// (test/support/grant.ts) and refused on any difference that would change what the executor may spend.
import { getSmartAccountsEnvironment } from '@metamask/smart-accounts-kit';
import { createAllowedCalldataTerms, createRedeemerTerms } from '@metamask/delegation-core';
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { permissionRequestFor, verifyGrant, type PermissionRequest } from '../../src/autopay/permission.js';
import { ALEX, BOB, WALLET, autopay, eth } from '../support/envelopes.js';
import { DELEGATION } from '../../src/autopay/abi.js';
import { metamaskGrant, type Caveat, type GrantOptions } from '../support/grant.js';

const env = getSmartAccountsEnvironment(84532);
const EXECUTOR: Hex = '0x00000000000000000000000000000000000e0ec0';
const START = 2_000_000_000;
const k = autopay(0, START, [
  [ALEX, '10'],
  [BOB, '2.5'],
]);
const ethK = {
  ...k,
  token: 'ETH' as const,
  token_address: null,
  recipients: [{ recipient: ALEX, amount: eth('0.01') }],
  fee: { ...k.fee, amount: eth('0.0001') },
};
const signer = privateKeyToAccount(generatePrivateKey());
const sign = (typed: unknown) => signer.signTypedData(typed as never);
const usdcRequest = permissionRequestFor(k, WALLET, EXECUTOR);
const grant = (o?: GrantOptions, request = usdcRequest) => metamaskGrant(request, env, sign, o);
const verify = async (o?: GrantOptions, request = usdcRequest) => {
  try {
    return verifyGrant(request, await grant(o, request), env);
  } catch (e) {
    return (e as Error).message;
  }
};
const e = env.caveatEnforcers as Record<string, Hex>;
const DELEGATIONS = parseAbiParameters(`${DELEGATION}[]`);

describe('permissionRequestFor', () => {
  it('caps each period at one run, from the first run, expiring one second after the last window', () => {
    expect(usdcRequest).toEqual({
      chainId: '0x14a34',
      from: WALLET,
      to: EXECUTOR,
      permission: {
        type: 'erc20-token-periodic',
        isAdjustmentAllowed: false,
        data: {
          tokenAddress: k.token_address,
          periodAmount: '0xbf7f70', // 10 + 2.5 + 0.05 fee = 12.55 USDC
          periodDuration: 86400,
          startTime: START,
          justification: expect.stringContaining(k.autopay_id),
        },
      },
      rules: [{ type: 'expiry', data: { timestamp: k.schedule.end_at + 1 } }],
    });
    const native = permissionRequestFor(ethK, WALLET, EXECUTOR).permission;
    expect(native.type).toBe('native-token-periodic');
    expect(native.data.tokenAddress).toBeUndefined();
    expect(BigInt(native.data.periodAmount)).toBe(10_100_000_000_000_000n);
  });
});

describe('verifyGrant', () => {
  it('accepts exactly what was asked, for USDC and ETH, and returns the context', async () => {
    const response = await grant();
    expect(verifyGrant(usdcRequest, response, env)).toBe(response.context);
    const ethRequest = permissionRequestFor(ethK, WALLET, EXECUTOR);
    expect(await verify({}, ethRequest)).toMatch(/^0x/);
  });

  it('refuses every changed term', async () => {
    const changed = (
      data: Partial<PermissionRequest['permission']['data']>,
      timestamp?: number,
    ): PermissionRequest => ({
      ...usdcRequest,
      permission: { ...usdcRequest.permission, data: { ...usdcRequest.permission.data, ...data } },
      rules: [{ type: 'expiry', data: { timestamp: timestamp ?? usdcRequest.rules[0].data.timestamp } }],
    });
    for (const granted of [
      changed({ periodAmount: '0xbf7f71' }),
      changed({ periodDuration: 86401 }),
      changed({ startTime: START - 1 }),
      changed({ tokenAddress: ALEX }),
      changed({}, usdcRequest.rules[0].data.timestamp + 1),
    ]) {
      const response = await grant({}, granted);
      expect(() => verifyGrant(usdcRequest, response, env)).toThrow('PERMISSION_MISMATCH');
    }
  });

  it('refuses a missing, extra or repeated caveat', async () => {
    const payee: Caveat = {
      enforcer: e.AllowedCalldataEnforcer!,
      terms: createAllowedCalldataTerms({ startIndex: 4, value: `0x${'00'.repeat(12)}${ALEX.slice(2)}` }),
      args: '0x',
    };
    const redeemer: Caveat = {
      enforcer: e.RedeemerEnforcer!,
      terms: createRedeemerTerms({ redeemers: [EXECUTOR] }),
      args: '0x',
    };
    const without = (name: string) => (c: Caveat[]) => c.filter((x) => x.enforcer !== e[name]);
    for (const caveats of [
      (c: Caveat[]) => [...c, payee],
      (c: Caveat[]) => [...c, redeemer],
      (c: Caveat[]) => [...c, c[c.length - 1]!],
      (c: Caveat[]) => [...c, c[0]!],
      without('TimestampEnforcer'),
      without('NonceEnforcer'),
      without('ValueLteEnforcer'),
    ])
      expect(await verify({ caveats })).toBe('PERMISSION_MISMATCH');
  });

  it('refuses a delegation from or to anyone else, or under another delegation', async () => {
    expect(await verify({ delegation: { delegator: ALEX } })).toBe('PERMISSION_MISMATCH');
    expect(await verify({ delegation: { delegate: ALEX } })).toBe('PERMISSION_MISMATCH');
    expect(await verify({ delegation: { authority: `0x${'11'.repeat(32)}` } })).toBe('PERMISSION_MISMATCH');
    expect(await verify({ response: { chainId: '0xaa36a7' } })).toBe('PERMISSION_MISMATCH');
    expect(await verify({ response: { delegationManager: ALEX } })).toBe('PERMISSION_MISMATCH');
  });

  it('refuses a context holding two delegations, and malformed answers', async () => {
    const one = await grant();
    const [[d]] = decodeAbiParameters(DELEGATIONS, one.context);
    const two = encodeAbiParameters(DELEGATIONS, [[d!, d!]]);
    for (const response of [
      null,
      'x',
      {},
      { ...one, context: '0x1' },
      { ...one, context: '0x1234' },
      { ...one, context: two },
      { ...one, dependencies: undefined },
    ])
      expect(() => verifyGrant(usdcRequest, response, env)).toThrow('PERMISSION_MISMATCH');
  });

  it('refuses an account that must be deployed first', async () => {
    expect(await verify({ response: { dependencies: [{ factory: ALEX, factoryData: '0x' }] } })).toBe(
      'PERMISSION_UNSUPPORTED_ACCOUNT',
    );
  });
});
