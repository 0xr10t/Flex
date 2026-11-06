// Pays an ENS organisation for real on Sepolia, with no AI, agent server or MetaMask. The names and amounts come from a file, and it
// stands in for the AI by writing one type `i` intent. Nothing is signed until you type yes. Run it in your own terminal.
//
//   npm run ens:pay -- --import-key    store the signing key in the OS keychain; it's typed hidden, and never passed as an argument
//   npm run ens:pay                    look up the names, run every check, and stop before signing
//   npm run ens:pay -- --send          the same, then ask, then sign and send
//
// This is a stand-in until the MetaMask signer exists. Use a wallet that only holds testnet funds.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { BaseError, createPublicClient, formatEther, getAddress, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EnsUnavailable } from '../src/contracts/io.js';
import type { ChainId, Config } from '../src/contracts/types.js';
import { createEnsClient } from '../src/recipients/ens-client.js';
import { resolveOnChain } from '../src/recipients/ens.js';
import { accountProblem } from '../wallet/src/chain/account.js';
import { ChainUnavailableError, createChainGateway, type ChainGateway } from '../wallet/src/chain/gateway.js';
import { runCheck } from '../wallet/src/guard/check.js';
import { checkEnvelope } from '@flex/protocol/mapping/check';
import { paymentHandler } from '../wallet/src/payments/payment-i.js';
import type { PaymentI } from '@flex/protocol/schemas/envelope';

const { Entry } = createRequire(resolvePath(import.meta.dirname, '../wallet/package.json'))('@napi-rs/keyring') as {
  Entry: new (
    service: string,
    account: string,
  ) => {
    getPassword(): string | null;
    setPassword(value: string): void;
  };
};

const SEPOLIA = 11155111;
const RPC = process.env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const SECOND_RPC = process.env.SEPOLIA_RPC_2 ?? 'https://sepolia.gateway.tenderly.co';
const WAIT_MS = 180_000;

const args = process.argv.slice(2);
const flagValue = (flag: string) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};
const keyAccount = flagValue('--key-account') ?? 'signing-key';
const names = JSON.parse(
  readFileSync(flagValue('--file') ?? resolvePath(import.meta.dirname, 'ens-check.iitr.json'), 'utf8'),
) as { parent: string; payer: Hex; members: Array<{ name: string; eth: string }> };
const payer = getAddress(names.payer) as Hex;
const keyEntry = new Entry('flex-wallet', keyAccount);
const pendingFile = join(homedir(), '.flex-wallet', `ens-pay-pending-${keyAccount}.json`);

class Stop extends Error {}
/** What a sudden failure means for the money, so an error can never leave the user guessing. */
let moneyState = 'Nothing was signed or sent.';
const say = (line = '') => console.log(line);

const configFor = (rpc: string) =>
  ({
    chains: [{ chain_id: SEPOLIA, is_l2: false, rpc_url: rpc }],
    ens: { rpc_chain_id: SEPOLIA, universal_resolver_address: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe' },
  }) as unknown as Config;

// ─── Key ────────────────────────────────────────────────────────────────────

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const { stdin } = process;
  if (!stdin.isTTY) {
    const rl = createInterface({ input: stdin });
    for await (const line of rl) return line.trim();
    return '';
  }
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((done) => {
    let typed = '';
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\u0003') process.exit(130);
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return done(typed.trim());
        }
        typed = ch === '\u007f' ? typed.slice(0, -1) : typed + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function importKey() {
  const typed = await readHidden(`Private key for ${payer} (hidden): `);
  const key = (typed.startsWith('0x') ? typed : `0x${typed}`) as Hex;
  let address: string;
  try {
    address = privateKeyToAccount(key).address;
  } catch {
    throw new Stop('That is not a valid private key. Nothing was stored.');
  }
  if (address.toLowerCase() !== payer.toLowerCase()) {
    throw new Stop(`That key belongs to ${address}, not ${payer}. Nothing was stored.`);
  }
  keyEntry.setPassword(key);
  say(`Stored in the OS keychain for ${payer}.`);
}

// ─── Finish a payment that was already signed ───────────────────────────────

async function waitAndFinish(gateway: ChainGateway, raw: Hex, hash: Hex, nonce: number): Promise<boolean> {
  await gateway.broadcast(raw);
  say(`Sent: https://sepolia.etherscan.io/tx/${hash}`);
  const receipt = await waitForReceipt(gateway, hash, nonce);
  if (receipt === 'unknown') {
    // The wallet moved past this nonce with no receipt to show for it. That may be a replacement or a lagging RPC, so this can't
    // claim either outcome, and the saved transaction stays, so that no new payment can start until someone has looked.
    throw new Stop(
      `This wallet moved past the nonce, but no receipt was found. Check the link above before paying again. Then delete ${pendingFile}.`,
    );
  }
  if (receipt === null) {
    throw new Stop(
      `Not mined after ${WAIT_MS / 1000}s. It's saved, so running this again resumes the same transaction and can't pay twice.`,
    );
  }
  rmSync(pendingFile, { force: true });
  say(`Mined in block ${receipt.blockNumber}: ${receipt.status}`);
  return receipt.status === 'success';
}

async function waitForReceipt(gateway: ChainGateway, hash: Hex, nonce: number) {
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    // The nonce is read before the receipt. Otherwise a transaction mined between the two reads would look like it never ran.
    const mined = await gateway.minedNonce().catch(() => 0);
    const receipt = await gateway.getReceipt(hash).catch(() => null);
    if (receipt) return receipt;
    if (mined > nonce) {
      for (let tries = 0; tries < 5; tries += 1) {
        await pause(3000);
        const late = await gateway.getReceipt(hash).catch(() => null);
        if (late) return late;
      }
      return 'unknown' as const;
    }
    await pause(3000);
  }
  return null;
}

// ─── Pay ────────────────────────────────────────────────────────────────────

async function resolveAll() {
  const first = createEnsClient(configFor(RPC));
  const secondConfig = configFor(SECOND_RPC);
  const second = createEnsClient(secondConfig);
  const out: Array<{ name: string; address: Hex; eth: string }> = [];
  for (const member of names.members) {
    const here = await resolveOnChain(first, configFor(RPC), member.name, SEPOLIA as ChainId);
    const there = await resolveOnChain(second, secondConfig, member.name, SEPOLIA as ChainId);
    if (here === null) throw new Stop(`${member.name} has no address on Sepolia, so nothing was paid.`);
    if (there === null || here.toLowerCase() !== there.toLowerCase()) {
      throw new Stop(`The two RPCs disagree about ${member.name}, so nothing was paid.`);
    }
    out.push({ name: member.name, address: here as Hex, eth: member.eth });
  }
  const seen = new Set<string>([payer.toLowerCase()]);
  for (const { name, address } of out) {
    if (seen.has(address.toLowerCase()))
      throw new Stop(`${name} repeats an address or points at the payer, so nothing was paid.`);
    seen.add(address.toLowerCase());
  }
  return out;
}

async function pay(send: boolean) {
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId();
  if (chainId !== SEPOLIA) throw new Stop(`The RPC is on chain ${chainId}. This command only runs on Sepolia.`);

  const stored = keyEntry.getPassword() as Hex | null;
  if (send && !stored) throw new Stop('No key stored yet. Run: npm run ens:pay -- --import-key');
  const account = privateKeyToAccount(stored ?? (`0x${randomBytes(32).toString('hex')}` as Hex));
  if (stored && account.address.toLowerCase() !== payer.toLowerCase()) {
    throw new Stop(`The stored key belongs to ${account.address}, not ${payer}.`);
  }
  const gateway = createChainGateway(SEPOLIA, RPC, account);

  if (existsSync(pendingFile)) {
    const saved = JSON.parse(readFileSync(pendingFile, 'utf8')) as { raw: Hex; hash: Hex; nonce: number };
    say(`Finishing the payment saved earlier, instead of starting a new one.`);
    if (!send) throw new Stop('Run again with --send to finish it.');
    moneyState = `A signed payment is saved. Run this again with --send to finish that same payment. It can't pay twice. Hash: ${saved.hash}`;
    if (!(await waitAndFinish(gateway, saved.raw, saved.hash, saved.nonce)))
      throw new Stop('The transaction reverted, so nobody was paid.');
    return;
  }

  const problem = await accountProblem(gateway, payer);
  const code = await gateway.getCode(payer);
  if (problem || !code || code === '0x')
    throw new Stop(`The paying wallet isn't upgraded for batches here (${problem ?? 'no code'}).`);

  say(`Looking up ${names.members.length} names on two RPCs…`);
  const people = await resolveAll();
  const total = people.reduce((sum, p) => sum + parseEther(p.eth), 0n);
  const balance = await pub.getBalance({ address: payer });

  const intent = {
    intent_id: 'i',
    step: 0,
    depends_on: [],
    token: 'ETH',
    token_address: null,
    chain_id: SEPOLIA,
    recipients: people.map((p) => ({
      recipient: p.address,
      amount: { value: p.eth, base_units: parseEther(p.eth).toString(), decimals: 18 },
    })),
  } as unknown as PaymentI;
  const envelope = {
    version: '2',
    request_id: `req_${randomBytes(6).toString('hex')}`,
    wallet_address: payer,
    created_at: new Date().toISOString(),
    intents: [intent],
  };
  const accepted = checkEnvelope(envelope);
  if (!accepted.ok) throw new Stop(`The wallet refused the intent at the ${accepted.stage} stage.`);

  const planned = await paymentHandler.plan!({ walletAddress: payer } as never, intent);
  if (planned.kind !== 'check') throw new Stop('The payment produced no check.');
  const failure = await runCheck(gateway, planned.check, payer);
  if (failure) throw new Stop(`The check before signing failed: ${failure}. Nothing was signed.`);
  say('Decoder and eth_simulateV1 agree with the intent.\n');

  say(`From  ${payer}  on Sepolia`);
  for (const p of people) say(`  ${p.eth.padEnd(7)} ETH  ${p.name.padEnd(18)} ${p.address}`);
  say(`Total ${formatEther(total)} ETH, plus gas. Wallet holds ${formatEther(balance)} ETH.\n`);

  if (!send) return say('Dry run: nothing signed. Add --send to pay.');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type yes to sign and send: ');
  rl.close();
  if (answer.trim() !== 'yes') return say('Stopped. Nothing signed.');

  const before = await Promise.all(people.map((p) => pub.getBalance({ address: p.address })));
  const prepared = await paymentHandler.prepare({ walletAddress: payer } as never, intent);
  if (prepared.kind !== 'tx') throw new Stop('The payment produced no transaction.');
  const signed = await gateway.prepareAndSign(prepared.tx);
  // Saved before it reaches the network, so a crash here resumes this exact transaction instead of signing a second one.
  mkdirSync(join(homedir(), '.flex-wallet'), { recursive: true, mode: 0o700 });
  writeFileSync(pendingFile, JSON.stringify(signed), { mode: 0o600 });
  moneyState = `A signed payment is saved. Run this again with --send to finish that same payment. It can't pay twice. Hash: ${signed.hash}`;

  const ok = await waitAndFinish(gateway, signed.raw, signed.hash, signed.nonce);
  if (!ok) throw new Stop('The transaction reverted, so nobody was paid.');
  moneyState = `The payment went through, but the balances couldn't be read afterwards. Don't pay again. Check: https://sepolia.etherscan.io/tx/${signed.hash}`;

  say('\nBalance changes:');
  let allMoved = true;
  for (const [i, p] of people.entries()) {
    const gained = (await pub.getBalance({ address: p.address })) - (before[i] as bigint);
    const moved = gained >= parseEther(p.eth);
    allMoved &&= moved;
    say(`  ${moved ? 'OK     ' : 'WRONG  '} ${p.name.padEnd(18)} +${formatEther(gained)} ETH`);
  }
  if (!allMoved) throw new Stop('Someone did not receive the expected amount.');
}

try {
  if (args.includes('--import-key')) await importKey();
  else await pay(args.includes('--send'));
} catch (e) {
  if (e instanceof Stop) console.error(`\nStopped: ${e.message}`);
  else if (e instanceof EnsUnavailable) console.error(`\nStopped: an ENS lookup failed on the RPC. ${moneyState}`);
  else if (e instanceof BaseError || e instanceof ChainUnavailableError)
    console.error(`\nStopped: the network failed. ${moneyState}`);
  else throw e;
  process.exitCode = 1;
}
