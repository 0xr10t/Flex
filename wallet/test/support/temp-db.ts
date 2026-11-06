// Encrypted SQLite needs a file, so each test gets one in a temporary folder.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { openDatabase } from '../../src/store/store.js';
import { DB_KEY } from './envelopes.js';

const root = mkdtempSync(join(tmpdir(), 'flex-wallet-'));
let count = 0;
const opened: ReturnType<typeof openDatabase>[] = [];

afterAll(() => {
  for (const db of opened) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});

export const tempDbPath = (): string => join(root, `wallet-${++count}.db`);
export const tempDb = () => {
  const db = openDatabase(tempDbPath(), DB_KEY);
  opened.push(db);
  return db;
};
