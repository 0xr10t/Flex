// Implements: §5 DB key storage (OS keychain via @napi-rs/keyring, service `agent-layer`, account `db-key`;
// 32 random bytes hex, generated on first run), §7.3 rule 1 randomness, NFR-05.
// Owner: Lane A. Tests inject a fake KeyStore; the real keychain is never touched by unit tests.

import { randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import { DB_KEY_RE } from './database.js';

export const KEYCHAIN_SERVICE = 'agent-layer';
export const KEYCHAIN_ACCOUNT = 'db-key';

/** Minimal keychain interface (one secret). */
export interface KeyStore {
  get(): string | null;
  set(value: string): void;
}

/** The OS keychain entry `agent-layer` / `db-key`. */
export function createOsKeyStore(): KeyStore {
  const entry = new Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  return {
    get: () => entry.getPassword(),
    set: (value) => entry.setPassword(value),
  };
}

export class DbKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DbKeyError';
  }
}

/** Returns the DB key from the keychain, generating and storing 32 random bytes (hex) on first run. */
export function getOrCreateDbKey(store: KeyStore): string {
  const existing = store.get();
  if (existing !== null) {
    if (!DB_KEY_RE.test(existing)) throw new DbKeyError('keychain db-key is not 32 bytes of lowercase hex');
    return existing;
  }
  const key = randomBytes(32).toString('hex');
  store.set(key);
  return key;
}
