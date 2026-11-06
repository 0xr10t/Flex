// Lane A test helpers: a temp SQLCipher file opened with a test key (the OS keychain is never touched), and a
// controllable clock.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Repos } from '../../../src/contracts/repos.js';
import { openDatabase, type Database } from '../../../src/db/open.js';
import { createRepos, type RepoOptions } from '../../../src/db/repos/index.js';

export const TEST_KEY = '0123456789abcdef'.repeat(4);

export function tempDir(prefix = 'agent-a-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface TempDb {
  path: string;
  db: Database;
  repos: Repos;
  clock: { now: string };
}

/** Opens a fresh encrypted DB in a temp dir; `clock.now` is the repos' current instant. */
export function openTempDb(options: Partial<RepoOptions> = {}): TempDb {
  const path = join(tempDir(), 'agent.db');
  const db = openDatabase(path, TEST_KEY);
  const clock = { now: '2026-11-05T10:00:00.000Z' };
  const repos = createRepos(db, { now: () => clock.now, ...options });
  return { path, db, repos, clock };
}
