// Tests: §8.2 step 2 secret detectors (C-061 … C-066, C-442 §20.1 guard/secrets), I-13, I-14.
import { createHash, randomBytes } from 'node:crypto';
import { base58, createBase58check } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  detectSecret,
  hasExtendedKey,
  hasKeystoreJson,
  hasRawPrivateKey,
  hasSeedPhrase,
  hasSolanaSecret,
  hasWifKey,
} from '../../../src/guard/secrets.js';

const b58check = createBase58check((d: Uint8Array) => new Uint8Array(createHash('sha256').update(d).digest()));

function xprv(): string {
  const payload = new Uint8Array(78);
  payload.set([0x04, 0x88, 0xad, 0xe4], 0);
  payload.set(randomBytes(74), 4);
  return b58check.encode(payload);
}
function wif(first = 0x80): string {
  const payload = new Uint8Array(34);
  payload[0] = first;
  payload.set(randomBytes(32), 1);
  payload[33] = 0x01;
  return b58check.encode(payload);
}

const E10 = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('guard/secrets (§8.2 step 2, C-442)', () => {
  it('C-061 raw private key: 64 hex with and without 0x, also tx hashes (I-14)', () => {
    const hex = 'ab'.repeat(32);
    expect(hasRawPrivateKey(`key ${hex} here`)).toBe(true);
    expect(hasRawPrivateKey(`key 0x${hex}`)).toBe(true);
    expect(detectSecret(`tx 0x${'1f'.repeat(32)}`)).toBe('raw_private_key');
  });

  it('C-061 raw private key negatives: 63 or 65 hex, and addresses (40 hex)', () => {
    expect(hasRawPrivateKey('a'.repeat(63))).toBe(false);
    expect(hasRawPrivateKey('a'.repeat(65))).toBe(false);
    expect(hasRawPrivateKey('send to 0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E')).toBe(false);
  });

  it('C-062 extended key: xprv regex + base58check decode', () => {
    const k = xprv();
    expect(k.startsWith('xprv')).toBe(true);
    expect(hasExtendedKey(`my key ${k}`)).toBe(true);
    expect(detectSecret(k)).toBe('extended_key');
  });

  it('C-062 extended key negative: right shape but bad checksum', () => {
    const k = xprv();
    const broken = k.slice(0, -1) + (k.endsWith('1') ? '2' : '1');
    expect(hasExtendedKey(broken)).toBe(false);
  });

  it('C-063 WIF key: base58check decodes and first byte is 0x80', () => {
    const k = wif();
    expect(hasWifKey(`wif ${k}`)).toBe(true);
    expect(detectSecret(k)).toBe('wif_key');
  });

  it('C-063 WIF negative: first byte not 0x80, or bad checksum', () => {
    const other = wif(0x81);
    expect(hasWifKey(other)).toBe(false);
    const k = wif();
    expect(hasWifKey(k.slice(0, -1) + (k.endsWith('1') ? '2' : '1'))).toBe(false);
  });

  it('C-064 Solana-style secret: 86–88 base58 chars decoding to 64 bytes', () => {
    let s = base58.encode(randomBytes(64));
    while (s.length < 86) s = base58.encode(randomBytes(64));
    expect(hasSolanaSecret(`sol ${s}`)).toBe(true);
  });

  it('C-064 Solana negative: base58 of 32 bytes (too short)', () => {
    expect(hasSolanaSecret(base58.encode(randomBytes(32)))).toBe(false);
  });

  it('C-065 seed phrase: 12 consecutive BIP-39 words block (E10)', () => {
    expect(hasSeedPhrase(`my seed is ${E10}, send 5 usdc to mihir`)).toBe(true);
    expect(detectSecret(`my seed is ${E10}`)).toBe('seed_phrase');
  });

  it('C-065 seed phrase: 11 words do not block', () => {
    const eleven = E10.split(' ').slice(0, 11).join(' ');
    expect(hasSeedPhrase(`${eleven} xyzzy`)).toBe(false);
  });

  it('C-065 seed phrase: an invalid-checksum 12-word run still blocks (I-13); case and punctuation ignored', () => {
    const bad = 'Zoo, zoo, zoo, zoo, zoo, zoo, zoo, zoo, zoo, zoo, zoo, zoo';
    expect(hasSeedPhrase(bad)).toBe(true);
  });

  it('C-066 keystore JSON: crypto/Crypto + ciphertext + kdf', () => {
    const ks = JSON.stringify({ version: 3, crypto: { ciphertext: 'aa', kdf: 'scrypt', kdfparams: {} } });
    expect(hasKeystoreJson(ks)).toBe(true);
    expect(hasKeystoreJson(JSON.stringify({ Crypto: { ciphertext: 'aa', kdf: 'pbkdf2' } }))).toBe(true);
    expect(detectSecret(`here: ${ks}`)).toBe('keystore_json');
  });

  it('C-066 keystore negatives: missing kdf, or not JSON', () => {
    expect(hasKeystoreJson(JSON.stringify({ crypto: { ciphertext: 'aa' } }))).toBe(false);
    expect(hasKeystoreJson('crypto ciphertext kdf')).toBe(false);
  });

  it('§8.2 step 2: an ordinary payment prompt is not a secret', () => {
    expect(detectSecret('send 50 usdc to aradhya on base, and 20 usdc to mihir.eth')).toBeNull();
  });
});
