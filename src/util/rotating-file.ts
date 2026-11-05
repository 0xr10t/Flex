// Implements: §18 log rotation "rotated at 10 MB × 5 files" (SQ-10: size-based, node:fs only, no extra package).
// Files: `<path>` (current) plus `<path>.1` … `<path>.<maxFiles-1>` (older); five files in total by default.
// Owner: Lane A.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_MAX_FILES = 5;

/** Synchronous append-only file stream with size-based rotation (pino destination). */
export class RotatingFileStream {
  private fd: number;
  private size: number;
  readonly path: string;
  readonly maxBytes: number;
  readonly maxFiles: number;

  constructor(path: string, maxBytes: number = LOG_MAX_BYTES, maxFiles: number = LOG_MAX_FILES) {
    if (maxBytes < 1 || maxFiles < 1) throw new Error('invalid rotation settings');
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.fd = openSync(path, 'a', 0o600);
    this.size = fstatSync(this.fd).size;
  }

  write(chunk: string): boolean {
    const buf = Buffer.from(chunk, 'utf8');
    if (this.size > 0 && this.size + buf.length > this.maxBytes) this.rotate();
    writeSync(this.fd, buf);
    this.size += buf.length;
    return true;
  }

  /** Shifts `<path>.i` → `<path>.(i+1)` (the oldest is overwritten), `<path>` → `<path>.1`, then reopens. */
  rotate(): void {
    closeSync(this.fd);
    if (this.maxFiles === 1) {
      this.fd = openSync(this.path, 'w', 0o600);
      this.size = 0;
      return;
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? this.path : `${this.path}.${i - 1}`;
      if (existsSync(src)) renameSync(src, `${this.path}.${i}`);
    }
    this.fd = openSync(this.path, 'a', 0o600);
    this.size = 0;
  }

  close(): void {
    closeSync(this.fd);
  }
}
