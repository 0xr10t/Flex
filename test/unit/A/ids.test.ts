// Lane A unit tests: §7.3 placeholder and ID generation (formats, randomness source, not counters, not derived).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { newId, newPlaceholder } from '../../../src/util/ids.js';

describe('§7.3 ids and placeholders', () => {
  it('C-042: amount_/address_/group_ + 8 lowercase hex', () => {
    expect(newPlaceholder('amount')).toMatch(/^amount_[0-9a-f]{8}$/);
    expect(newPlaceholder('address')).toMatch(/^address_[0-9a-f]{8}$/);
    expect(newPlaceholder('group')).toMatch(/^group_[0-9a-f]{8}$/);
  });

  it('C-042: req_/ap_/ses_/q_ + 12 lowercase hex', () => {
    expect(newId('request')).toMatch(/^req_[0-9a-f]{12}$/);
    expect(newId('autopay')).toMatch(/^ap_[0-9a-f]{12}$/);
    expect(newId('session')).toMatch(/^ses_[0-9a-f]{12}$/);
    expect(newId('question')).toMatch(/^q_[0-9a-f]{12}$/);
  });

  it('C-041: the random source is node:crypto randomBytes (4 bytes for placeholders, 6 for ids)', async () => {
    vi.resetModules();
    const sizes: number[] = [];
    vi.doMock('node:crypto', async (orig) => {
      const real = await orig<typeof import('node:crypto')>();
      return {
        ...real,
        randomBytes: (n: number) => {
          sizes.push(n);
          return Buffer.alloc(n, 0xab);
        },
      };
    });
    const ids = await import('../../../src/util/ids.js');
    expect(ids.newPlaceholder('amount')).toBe('amount_abababab');
    expect(ids.newId('request')).toBe('req_abababababab');
    expect(sizes).toEqual([4, 6]);
    vi.doUnmock('node:crypto');
    vi.resetModules();
  });

  it('C-041: no Math.random anywhere in Lane A code paths that mint ids, tokens or keys', () => {
    for (const f of ['src/util/ids.ts', 'src/config/tokens.ts', 'src/db/keychain.ts', 'src/session/manager.ts']) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/Math\.random/);
    }
  });

  it('C-047 / C-044: values are not counters and not derived from anything (1000 draws, all distinct, unordered)', () => {
    const draws = Array.from({ length: 1000 }, () => newPlaceholder('amount'));
    expect(new Set(draws).size).toBe(1000);
    const sorted = [...draws].sort();
    expect(draws).not.toEqual(sorted);
  });
});
