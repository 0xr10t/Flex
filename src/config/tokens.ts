// Implements: §6.1 token files ("one random 32-byte hex token each, mode 0600; generated on first run if missing"),
// §16.4 bearer tokens from 0600 files; UI and execution-report tokens are different; §7.3 rule 1 randomness.
// Owner: Lane A.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../contracts/types.js';
import { expandHome } from './load.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;

export class TokenFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenFileError';
  }
}

/**
 * Returns the token in `path`, creating the file first (32 random bytes as lowercase hex, mode 0600) when it is
 * missing. An existing file must have mode 0600 (SQ-A-07) and hold one 64-hex token (surrounding whitespace ignored).
 */
export function ensureTokenFile(path: string): string {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    writeFileSync(path, token, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    return token;
  }
  if ((statSync(path).mode & 0o777) !== 0o600) throw new TokenFileError('token file must have mode 0600');
  const token = readFileSync(path, 'utf8').trim();
  if (!TOKEN_RE.test(token)) throw new TokenFileError('token file does not contain a 32-byte hex token');
  return token;
}

export interface Tokens {
  /** UI bearer token (§14.1). */
  ui: string;
  /** Execution-report bearer token (§14.3). */
  report: string;
  /** Agent → execution layer bearer token (§14.2). */
  outbound: string;
}

/** Loads (or creates) the three token files of §6.1 and enforces that UI and report tokens differ (§16.4). */
export function loadTokens(config: Config, home?: string): Tokens {
  const ui = ensureTokenFile(expandHome(config.auth.ui_token_file, home));
  const report = ensureTokenFile(expandHome(config.auth.execution_report_token_file, home));
  const outbound = ensureTokenFile(expandHome(config.execution.outbound_token_file, home));
  if (ui === report) throw new TokenFileError('UI and execution-report tokens must be different');
  return { ui, report, outbound };
}
