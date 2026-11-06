// Checks ENSv2 on its own, with no AI, agent server, wallet service or funds: names -> addresses -> a type `i` intent -> the wallet's
// checks -> `eth_simulateV1`. It uses the agent's real ENS code and the wallet's real checks. It only reads from chains: the key it
// creates is thrown away, and it never signs or sends.
//
//   npm run ens:check                                  real ENS records only
//   npm run ens:check -- --owners-as-addresses         also tests the steps after ENS, using the owners in the file as stand-ins
//   npm run ens:check -- --payer 0x...                 pretend this wallet pays, to see which members get dropped
//   npm run ens:check -- --file path/to/names.json     other names
//
// Set SEPOLIA_RPC, SEPOLIA_RPC_2, BASE_SEPOLIA_RPC or ARBITRUM_SEPOLIA_RPC to use other RPCs.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { getAddress, parseEther, toHex, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ChainId, Config } from '../src/contracts/types.js';
import { createEnsClient } from '../src/recipients/ens-client.js';
import { normalizeEns, resolveOnChain } from '../src/recipients/ens.js';
import { triageMembers, type MemberLookup } from '../src/recipients/group.js';
import { createSubnameSource } from '../src/recipients/subnames.js';
import { createChainGateway, SimulationUnavailableError } from '../wallet/src/chain/gateway.js';
import { runCheck, type Check } from '../wallet/src/guard/check.js';
import { checkEnvelope } from '@flex/protocol/mapping/check';
import { paymentHandler } from '../wallet/src/payments/payment-i.js';
import type { PaymentI } from '@flex/protocol/schemas/envelope';

const SEPOLIA = 11155111;
const CHAINS = [
  {
    chain_id: SEPOLIA,
    name: 'Sepolia',
    is_l2: false,
    rpc: process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com',
  },
  {
    chain_id: 84532,
    name: 'Base Sepolia',
    is_l2: true,
    rpc: process.env.BASE_SEPOLIA_RPC ?? 'https://sepolia.base.org',
  },
  {
    chain_id: 421614,
    name: 'Arbitrum Sepolia',
    is_l2: true,
    rpc: process.env.ARBITRUM_SEPOLIA_RPC ?? 'https://sepolia-rollup.arbitrum.io/rpc',
  },
];
const SECOND_RPC = process.env.SEPOLIA_RPC_2 ?? 'https://sepolia.gateway.tenderly.co';

interface Member {
  name: string;
  owner: Hex;
  eth: string;
}
interface Names {
  parent: string;
  members: Member[];
}

const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const useOwners = args.includes('--owners-as-addresses');
const names = JSON.parse(
  readFileSync(flagValue('--file') ?? resolvePath(import.meta.dirname, 'ens-check.iitr.json'), 'utf8'),
) as Names;
const throwaway = privateKeyToAccount(generatePrivateKey());
const payerArg = flagValue('--payer');
const payer = (payerArg ? getAddress(payerArg) : throwaway.address) as Hex;

const configWith = (sepoliaRpc: string) =>
  ({
    wallet: { address: payer },
    chains: CHAINS.map((c) => ({ ...c, rpc_url: c.chain_id === SEPOLIA ? sepoliaRpc : c.rpc })),
    ens: {
      rpc_chain_id: SEPOLIA,
      universal_resolver_address: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
      indexer_url: process.env.ENS_INDEXER_URL ?? 'https://api.v2-sepolia.ensnode.io/api/omnigraph',
      indexer_kind: 'ensnode-omnigraph',
    },
  }) as unknown as Config;

const config = configWith(CHAINS[0]!.rpc);
const ens = createEnsClient(config);

// ─── Reporting ──────────────────────────────────────────────────────────────

type Outcome = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIP';
const counts: Record<Outcome, number> = { PASS: 0, FAIL: 0, BLOCKED: 0, SKIP: 0 };

const report = (outcome: Outcome, what: string, detail = '') => {
  counts[outcome] += 1;
  console.log(`  ${outcome.padEnd(7)} ${what}${detail ? `  (${detail})` : ''}`);
};
const expectThat = (ok: boolean, what: string, detail = '') => report(ok ? 'PASS' : 'FAIL', what, detail);
const section = (title: string) => console.log(`\n${title}`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ─── 1. Can we reach ENSv2 at all? ──────────────────────────────────────────

async function checkLookupPath(): Promise<boolean> {
  section(`1. The lookup itself, using ${names.parent} as a known good name`);
  try {
    const address = await resolveOnChain(ens, config, names.parent, SEPOLIA);
    expectThat(
      address !== null,
      `${names.parent} resolves through the ENSv2 Universal Resolver`,
      address ?? 'no address',
    );
    return address !== null;
  } catch {
    report('BLOCKED', 'Sepolia RPC could not answer');
    return false;
  }
}

// ─── 2. Names that must never turn into a payment ───────────────────────────

async function checkBadNames() {
  section('2. Names that must not produce an address');
  for (const bad of ['iitr..eth', '', '.iitr.eth']) {
    expectThat(normalizeEns(bad) === null, `refuses malformed name "${bad}"`);
  }
  expectThat(
    normalizeEns(`ALPHA.${names.parent}`) === `alpha.${names.parent}`,
    'treats capital letters as the same name',
  );
  for (const unknown of [`flex-made-up-name.${names.parent}`, 'flex-made-up-parent-xyz.eth']) {
    const address = await resolveOnChain(ens, config, unknown, SEPOLIA).catch(() => null);
    expectThat(address === null, `gives no address for made-up name ${unknown}`, address ?? '');
  }
}

// ─── 3. Listing an organisation ─────────────────────────────────────────────

async function checkListing() {
  section('3. Listing the organisation through the indexer');
  const given = names.members.map((m) => m.name).sort();
  try {
    const found = await createSubnameSource(config).listChildren(names.parent);
    if (found === 'not_found') return report('FAIL', `the indexer doesn't know ${names.parent}`);
    const listed = [...found].sort();
    const missing = given.filter((n) => !listed.includes(n));
    expectThat(
      missing.length === 0,
      `lists all ${given.length} subnames you gave me`,
      missing.length ? `missing ${missing.join(', ')}` : '',
    );
  } catch {
    report(
      'BLOCKED',
      `indexer unavailable at ${config.ens.indexer_url}`,
      'using your list instead; TLS checks stay on',
    );
  }
}

// ─── 4. The real test: subname to address ───────────────────────────────────

type Resolved = Record<number, Record<string, Hex | null>>;

async function checkMembers(): Promise<Resolved> {
  section('4. Each subname to an address, per chain');
  const resolved: Resolved = {};
  for (const chain of CHAINS) {
    const row: Record<string, Hex | null> = {};
    for (const member of names.members) {
      let address: Hex | null = null;
      try {
        address = (await resolveOnChain(ens, config, member.name, chain.chain_id as ChainId)) as Hex | null;
      } catch {
        report('BLOCKED', `${member.name} on ${chain.name}: RPC could not answer`);
        row[member.name] = null;
        continue;
      }
      row[member.name] = address;
      const note =
        address && address.toLowerCase() !== member.owner.toLowerCase()
          ? 'differs from the owner, which is allowed'
          : '';
      expectThat(
        address !== null,
        `${member.name} on ${chain.name}`,
        address ? `${short(address)} ${note}`.trim() : 'no address record',
      );
    }
    resolved[chain.chain_id] = row;
  }
  return resolved;
}

// ─── 5. Do two RPCs agree? ──────────────────────────────────────────────────

async function checkSecondRpc(resolved: Resolved) {
  section('5. A second RPC gives the same answers');
  const other = configWith(SECOND_RPC);
  const otherEns = createEnsClient(other);
  try {
    const all = [names.parent, ...names.members.map((m) => m.name)];
    let same = 0;
    for (const name of all) {
      const here =
        name === names.parent ? await resolveOnChain(ens, config, name, SEPOLIA) : (resolved[SEPOLIA]?.[name] ?? null);
      const there = await resolveOnChain(otherEns, other, name, SEPOLIA);
      if (here?.toLowerCase() === there?.toLowerCase()) same += 1;
      else report('FAIL', `${name} differs between RPCs`, `${here ?? 'none'} vs ${there ?? 'none'}`);
    }
    if (same === all.length) report('PASS', `${SECOND_RPC} agrees on all ${all.length} names`);
  } catch {
    report('BLOCKED', `${SECOND_RPC} could not answer`);
  }
}

// ─── 6. Who actually gets paid? ─────────────────────────────────────────────

const addressesFor = (chainId: number, resolved: Resolved): MemberLookup[] =>
  names.members.map((m) => ({
    subname: m.name,
    address: (useOwners ? m.owner : (resolved[chainId]?.[m.name] ?? null)) as MemberLookup['address'],
  }));

function checkTriage(lookups: MemberLookup[]) {
  section("6. The agent's member rules: drop yourself and repeat addresses");
  const asOwner = useOwners ? ' (stand-in: owners, not ENS records)' : '';
  const { members, self, duplicates } = triageMembers(lookups, payer as never);
  const payable = members.filter((m) => m.address !== null);
  console.log(`  payer ${short(payer)}${payerArg ? '' : ' is a throwaway address'}${asOwner}`);
  console.log(`  pays ${payable.length}: ${payable.map((m) => m.subname).join(', ') || 'nobody'}`);
  if (self.length) console.log(`  dropped as the payer: ${self.join(', ')}`);
  if (duplicates.length) console.log(`  dropped as repeat addresses: ${duplicates.join(', ')}`);
  const unique = new Set(payable.map((m) => m.address?.toLowerCase()));
  expectThat(unique.size === payable.length, 'nobody is paid twice');
  expectThat(!payable.some((m) => m.address?.toLowerCase() === payer.toLowerCase()), 'the payer never pays themselves');
  return payable;
}

// ─── 7. Type `i` intent, standing in for the AI ─────────────────────────────

const amountOf = (eth: string) => ({ value: eth, base_units: parseEther(eth).toString(), decimals: 18 });

function intentFor(chainId: number, payable: MemberLookup[]): PaymentI {
  return {
    intent_id: 'i',
    step: 0,
    depends_on: [],
    token: 'ETH',
    token_address: null,
    chain_id: chainId,
    recipients: payable.map((p) => ({
      recipient: p.address as Hex,
      amount: amountOf(names.members.find((m) => m.name === p.subname)?.eth as string),
    })),
  } as unknown as PaymentI;
}

const envelopeOf = (intent: unknown) => ({
  version: '2',
  request_id: 'req_0123456789ab',
  wallet_address: payer,
  created_at: new Date().toISOString(),
  intents: [intent],
});

function checkIntent(chain: (typeof CHAINS)[number], intent: PaymentI) {
  const accepted = checkEnvelope(envelopeOf(intent));
  expectThat(
    accepted.ok,
    `${chain.name}: wallet accepts an i intent paying ${intent.recipients.length} people different amounts`,
    accepted.ok ? '' : `${accepted.stage}: ${JSON.stringify(accepted).slice(0, 160)}`,
  );
  const first = intent.recipients[0]!;
  const twice = { ...intent, recipients: [first, first] };
  expectThat(!checkEnvelope(envelopeOf(twice)).ok, `${chain.name}: wallet refuses the same person twice`);
  const wrongUnits = { ...intent, recipients: [{ ...first, amount: { ...first.amount, base_units: '1' } }] };
  expectThat(!checkEnvelope(envelopeOf(wrongUnits)).ok, `${chain.name}: wallet refuses an amount that doesn't add up`);
}

// ─── 8. Decoder and eth_simulateV1 ──────────────────────────────────────────

const ctx = { walletAddress: payer };
const planOf = async (intent: PaymentI): Promise<Check> => {
  const planned = await paymentHandler.plan!(ctx as never, intent);
  if (planned.kind !== 'check') throw new Error('a payment should always produce a check');
  return planned.check;
};
const withBalance = (check: Check, wei: bigint): Check => ({
  ...check,
  blocks: check.blocks.map((b) => ({
    ...b,
    stateOverrides: { [payer]: { ...b.stateOverrides?.[payer], balance: toHex(wei) } },
  })),
});

async function checkSimulation(chain: (typeof CHAINS)[number], intent: PaymentI) {
  const gateway = createChainGateway(chain.chain_id, chain.rpc, throwaway);
  const total = intent.recipients.reduce((sum, r) => sum + BigInt(r.amount.base_units), 0n);
  const stranger = '0x000000000000000000000000000000000000dEaD' as Hex;
  const swapped = {
    ...intent,
    recipients: intent.recipients.map((r, i) => (i === 0 ? { ...r, recipient: stranger } : r)),
  } as PaymentI;
  const honest = withBalance(await planOf(intent), total + parseEther('1'));
  const other = withBalance(await planOf(swapped), total + parseEther('1'));

  const cases: Array<[string, Check, string | null]> = [
    ['the correct payment passes', honest, null],
    [
      'bytes paying someone else are caught by the decoder',
      { ...honest, decode: other.decode, blocks: other.blocks },
      'DECODE_MISMATCH',
    ],
    ['a simulation paying someone else is caught', { ...honest, blocks: other.blocks }, 'SIMULATION_MISMATCH'],
    ['a wallet without enough ETH is caught', withBalance(honest, 0n), 'SIMULATION_FAILED'],
  ];
  for (const [what, check, want] of cases) {
    try {
      const got = await runCheck(gateway, check, payer);
      expectThat(got === want, `${chain.name}: ${what}`, got === want ? '' : `got ${got ?? 'pass'}`);
    } catch (e) {
      if (!(e instanceof SimulationUnavailableError)) throw e;
      report('BLOCKED', `${chain.name}: ${what}`, 'simulation unavailable on this RPC');
    }
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`ENSv2 check for ${names.parent}. Reads only: nothing is signed or sent.`);
  await checkLookupPath();
  await checkBadNames();
  await checkListing();
  const resolved = await checkMembers();
  await checkSecondRpc(resolved);

  const payableOnSepolia = checkTriage(addressesFor(SEPOLIA, resolved));

  section('7-8. Type i intent, wallet checks and simulation');
  if (useOwners)
    console.log('  Stand-in run: these addresses come from the file, so this part does not prove ENS resolution.');
  if (payableOnSepolia.length === 0) {
    report(
      'SKIP',
      'nobody can be paid until the subnames have address records',
      'or use --owners-as-addresses to test these steps',
    );
  } else {
    for (const chain of CHAINS) {
      const { members } = triageMembers(addressesFor(chain.chain_id, resolved), payer as never);
      const payable = members.filter((m) => m.address !== null);
      if (payable.length === 0) {
        report('SKIP', `${chain.name}: nobody has an address here`);
        continue;
      }
      const intent = intentFor(chain.chain_id, payable);
      checkIntent(chain, intent);
      await checkSimulation(chain, intent);
    }
  }

  section('Result');
  console.log(`  ${counts.PASS} passed, ${counts.FAIL} failed, ${counts.BLOCKED} blocked, ${counts.SKIP} skipped`);
  const realRecords = Object.values(resolved[SEPOLIA] ?? {}).filter(Boolean).length;
  console.log(`  ${realRecords} of ${names.members.length} subnames resolve from real ENS records on Sepolia`);
  process.exitCode = counts.FAIL + counts.BLOCKED > 0 ? 1 : 0;
}

await main();
