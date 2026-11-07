import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { copyText, readClipboard } from '../../../src/cli/open.js';
it('copies exact text through stdin without shell interpolation', async () => {
  let copied = '';
  const fake = ((_cmd: string, _args: string[], options: object) => {
    expect(options).not.toHaveProperty('shell');
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), kill: () => true });
    child.stdin.on('data', (chunk) => {
      copied += String(chunk);
    });
    child.stdin.on('finish', () => child.emit('close', 0));
    return child;
  }) as unknown as typeof spawn;
  expect(await copyText('literal `danger` $(command)\naddress', fake)).toBe(true);
  expect(copied).toBe('literal `danger` $(command)\naddress');
});
it('returns unavailable when the clipboard process fails instead of altering input', async () => {
  const fake = (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    queueMicrotask(() => child.emit('error', new Error('missing')));
    return child;
  }) as unknown as typeof spawn;
  expect(await readClipboard(fake)).toBeUndefined();
});
it('rejects oversized clipboard data', async () => {
  const fake = (() => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: () => true });
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.alloc(1_000_001));
      child.emit('close', 0);
    });
    return child;
  }) as unknown as typeof spawn;
  expect(await readClipboard(fake)).toBeUndefined();
});
