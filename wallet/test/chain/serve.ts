// The real service in its own process, so a test can kill it with SIGKILL. Run by real-crash.test.ts.
import { readFileSync } from 'node:fs';
import { parseConfig } from '../../src/config.js';
import { silentLogger } from '../../src/log.js';
import { createService } from '../../src/service.js';
import { DB_KEY } from '../support/envelopes.js';
import { userAccount } from './harness.js';

const config = parseConfig(JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as unknown);
const service = createService(
  config,
  { account: userAccount, dbKeyHex: DB_KEY, inboundToken: 'in', reportToken: 'report' },
  silentLogger,
  { pollMs: 50 },
);
await service.start();
process.stdout.write('ready\n');
