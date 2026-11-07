// CRE CLI simulation forwarders, verified against the official directory and supported-chains.
// These are testnet mocks: they do not authenticate DON consensus. User-signed delegations and
// IntentExecutorV4's registration, schedule, cancellation and replay checks remain mandatory.
// https://docs.chain.link/cre/guides/workflow/using-evm-client/forwarder-directory-ts
import type { Hex } from 'viem';

export const SIMULATION_FORWARDERS: Readonly<Record<number, Hex>> = {
  11155111: '0x15fC6ae953E024d975e77382eEeC56A9101f9F88',
  84532: '0x82300bd7c3958625581cc2f77bc6464dcecdf3e5',
  421614: '0xd41263567ddfead91504199b8c6c87371e83ca5d',
};
