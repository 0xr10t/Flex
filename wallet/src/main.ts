// Starts the wallet. The database key and signing key come from the OS keychain, never from config or the environment.
// OQ-01 says the wallet holds the key on the user's device. How it gets there (create or import) is not built yet, so a
// missing key stops the start with a clear message.

import { randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { loadConfig, readToken } from './config.js';
import { stderrLogger } from './log.js';
import { createService } from './service.js';

const KEYCHAIN_SERVICE = 'flex-wallet';

function dbKey(): string {
  const entry = new Entry(KEYCHAIN_SERVICE, 'db-key');
  const existing = entry.getPassword();
  if (existing) return existing;
  const created = randomBytes(32).toString('hex');
  entry.setPassword(created);
  return created;
}

function signingKey(): Hex {
  const key = new Entry(KEYCHAIN_SERVICE, 'signing-key').getPassword();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`no signing key in the OS keychain (service "${KEYCHAIN_SERVICE}", account "signing-key")`);
  }
  return key as Hex;
}

const configPath = process.argv[2];
if (!configPath) throw new Error('usage: main <path to wallet config>');

const config = loadConfig(configPath);
const service = createService(
  config,
  {
    account: privateKeyToAccount(signingKey()),
    dbKeyHex: dbKey(),
    inboundToken: readToken(config.auth.inbound_token_file),
    reportToken: readToken(config.auth.report_token_file),
  },
  stderrLogger,
);

const shutdown = () => {
  void service.stop().then(() => process.exit(0));
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await service.start();
stderrLogger('wallet_started', {});
