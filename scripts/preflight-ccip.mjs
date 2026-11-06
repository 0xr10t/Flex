// Read-only live checks of the same CCIP plan and simulation used by the wallet. No signing keys or sends.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { formatEther, formatUnits, parseUnits } from 'viem';
import { loadConfig } from '../wallet/dist/src/config.js';
import { browserAccount } from '../wallet/dist/src/browser/account.js';
import { createChainGateway } from '../wallet/dist/src/chain/gateway.js';
import { accountProblem } from '../wallet/dist/src/chain/account.js';
import { bridgeHandler } from '../wallet/dist/src/bridge/bridge-j.js';
import { runCheck } from '../wallet/dist/src/guard/check.js';
import { openDatabase, Store } from '../wallet/dist/src/store/store.js';
import { USDC } from '@flex/protocol/schemas/intent.v2';
import { checkEnvelope } from '@flex/protocol/mapping/check';

let stage = 'config';
async function main() {
  const config = loadConfig(process.argv[2] || '.local/wallet.config.json');
  const address = config.approval.wallet_address;
  if (!address) throw new Error('PUBLIC_ADDRESS_REQUIRED');
  const textAmount = process.argv[3] || '0.1';
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(textAmount) || textAmount.length > 60) throw new Error('INVALID_AMOUNT');
  const amount = parseUnits(textAmount, 6);
  if (amount <= 0n) throw new Error('INVALID_AMOUNT');
  stage = 'read clients';
  const account = browserAccount(address);
  const gateways = new Map(
    config.chains.map((c) => [c.chain_id, createChainGateway(c.chain_id, c.rpc_url, account, c.simulation)]),
  );
  stage = 'temporary store';
  // SQLCipher configuration requires a file-backed database on this platform.
  const temp = mkdtempSync(join(tmpdir(), 'flex-ccip-preflight-'));
  const dbPath = join(temp, 'preflight.db');
  const db = openDatabase(dbPath, randomBytes(32).toString('hex'));
  const store = new Store(db);
  let ready = 0;
  stage = 'route checks';
  try {
    for (const source of config.chains)
      for (const dest of config.chains) {
        if (source.chain_id === dest.chain_id) continue;
        const route = `${source.chain_id} -> ${dest.chain_id}`;
        try {
          const intent = {
            intent_id: 'j',
            step: 0,
            token: 'USDC',
            source_chain_id: source.chain_id,
            dest_chain_id: dest.chain_id,
            source_token_address: USDC[source.chain_id],
            dest_token_address: USDC[dest.chain_id],
            receiver: 'self',
            amount: { value: formatUnits(amount, 6), base_units: amount.toString(), decimals: 6 },
            fee_max_eth: config.bridge?.ccip_fee_max_eth || '0.003',
            funds_steps: [],
          };
          const envelope = {
            version: '2',
            request_id: `req_${randomBytes(6).toString('hex')}`,
            wallet_address: address,
            created_at: new Date().toISOString(),
            intents: [intent],
          };
          if (!checkEnvelope(envelope).ok) throw new Error('INVALID_PLAN');
          store.insertRequest(envelope, envelope.created_at);
          const gateway = gateways.get(source.chain_id);
          const problem = await accountProblem(gateway, address);
          if (problem) {
            console.log(`${route}: ${problem}`);
            continue;
          }
          const context = {
            store,
            envelope,
            walletAddress: address,
            gateway,
            gatewayFor: (id) => gateways.get(id),
            deploymentFor: () => null,
            now: () => new Date(),
            bridgeTimeoutMs: 1800000,
            bridgeFeeMaxEth: intent.fee_max_eth,
          };
          const planned = await bridgeHandler.plan(context, intent);
          if (planned.kind === 'finished') {
            console.log(`${route}: ${planned.outcome.error_code || 'UNAVAILABLE'}`);
            continue;
          }
          const failure = await runCheck(gateway, planned.check, address);
          const saved = store.stepData(envelope.request_id, 0);
          console.log(
            `${route}: ${failure || 'PASS'}; amount ${intent.amount.value} USDC; fee ${formatEther(BigInt(saved.fee_wei))} test ETH; simulation quorum ${source.simulation?.quorum || 1}/${source.simulation?.rpc_urls.length || 1}`,
          );
          if (!failure) ready++;
        } catch (e) {
          // Never print provider errors: they may contain authenticated URLs or headers.
          const allowed = ['SimulationUnavailableError', 'ChainUnavailableError', 'WouldFailError'];
          console.log(`${route}: ${allowed.includes(e?.name) ? e.name : 'CHECK_UNAVAILABLE'}`);
        }
      }
  } finally {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(dbPath + suffix)) unlinkSync(dbPath + suffix);
    rmdirSync(temp);
  }
  const count = config.chains.length * (config.chains.length - 1);
  console.log(`${ready}/${count} routes passed read-only preflight. No transactions signed or sent.`);
  process.exitCode = ready === count ? 0 : 2;
}
main().catch(() => {
  console.error(
    `Preflight stopped during ${stage}. Check the protected wallet config, positive USDC amount, and built wallet files.`,
  );
  process.exitCode = 1;
});
