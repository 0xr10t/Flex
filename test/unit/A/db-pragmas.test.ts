// Lane A unit test: §7 "On open, run" the five pragmas in the listed order, then migrations (driver mocked so the
// exact statements can be observed).
import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];

vi.mock('better-sqlite3-multiple-ciphers', () => {
  class FakeDb {
    pragma(s: string, opts?: { simple: boolean }): unknown {
      calls.push(`pragma ${s}`);
      return opts?.simple === true ? 1 : [];
    }
    exec(s: string): void {
      calls.push(`exec ${s.length}`);
    }
    transaction(fn: () => void): () => void {
      return fn;
    }
    close(): void {
      calls.push('close');
    }
  }
  return { default: FakeDb };
});

const { openDatabase } = await import('../../../src/db/open.js');

describe('§7 pragmas', () => {
  it('C-023: cipher, key, secure_delete, foreign_keys, journal_mode=WAL — in this order, before any other statement', () => {
    calls.length = 0;
    openDatabase(':memory:', 'ab'.repeat(32));
    expect(calls.slice(0, 5)).toEqual([
      "pragma cipher = 'sqlcipher'",
      `pragma key = '${'ab'.repeat(32)}'`,
      'pragma secure_delete = ON',
      'pragma foreign_keys = ON',
      'pragma journal_mode = WAL',
    ]);
    // migrate() reads user_version next (mock returns 1 = already migrated).
    expect(calls[5]).toBe('pragma user_version');
  });
});
