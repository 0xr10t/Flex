// Implements: §18 logging — pino JSON lines to ~/.agent-layer/logs/agent.log, rotated at 10 MB × 5 files, level
// info; allowlisted fields only (a custom serializer drops every other field; no debug mode relaxes this);
// never-logged values (each allowed field also has a fixed value shape, so free text cannot ride in an allowed
// field); NFR-04. Owner: Lane A.

import { pino } from 'pino';
import { LOG_ALLOWED_FIELDS, type AllowlistLogger, type LogFields } from '../contracts/io.js';
import { expandHome } from '../config/load.js';
import { LOG_MAX_BYTES, LOG_MAX_FILES, RotatingFileStream } from './rotating-file.js';

/** §18 default log file. */
export const DEFAULT_LOG_FILE = '~/.agent-layer/logs/agent.log';

/** Identifier/code-shaped strings only (ids, step names, states, codes, event names). */
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const LLM_CALLS = new Set(['amounts', 'request_type', 'spans', 'payments', 'quarantine']);

type Check = (v: unknown) => boolean;
const isCode: Check = (v) => typeof v === 'string' && CODE_RE.test(v);
const isNum: Check = (v) => typeof v === 'number' && Number.isFinite(v);

/** Value shape per allowlisted field. `ts` and `level` are written by the logger itself. */
const FIELD_CHECKS: Readonly<Record<string, Check>> = {
  session_id: isCode,
  request_id: isCode,
  step: isCode,
  state: isCode,
  event: isCode,
  error_code: isCode,
  question_code: isCode,
  attempt: isNum,
  llm_call: (v) => typeof v === 'string' && LLM_CALLS.has(v),
  llm_retry: (v) => typeof v === 'boolean',
  duration_ms: isNum,
  n_amounts: isNum,
  n_payees: isNum,
  n_intents: isNum,
  rule_id: isCode,
  chain_ids_unavailable: (v) => Array.isArray(v) && v.every((x) => Number.isInteger(x)),
  http_status: isNum,
};

/**
 * The §18 allowlist serializer: keeps only allowlisted fields whose value has the expected shape; drops
 * everything else (including caller-supplied `ts`/`level`).
 */
export function sanitizeLogFields(fields: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof fields !== 'object' || fields === null) return out;
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (!LOG_ALLOWED_FIELDS.includes(key)) continue;
    const check = FIELD_CHECKS[key];
    if (check === undefined || !check(value)) continue;
    out[key] = Array.isArray(value) ? [...(value as number[])] : value;
  }
  return out;
}

export interface LogDestination {
  write(chunk: string): unknown;
}

export interface LoggerOptions {
  /** Log file path (default ~/.agent-layer/logs/agent.log). Ignored when `destination` is given. */
  file?: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Custom destination (tests). */
  destination?: LogDestination;
  /** Clock for `ts` (tests). */
  now?: () => Date;
}

export interface Logger extends AllowlistLogger {
  /** Closes the log file (no-op for a custom destination). */
  close(): void;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  let fileStream: RotatingFileStream | null = null;
  let dest: LogDestination;
  if (opts.destination !== undefined) {
    dest = opts.destination;
  } else {
    fileStream = new RotatingFileStream(
      expandHome(opts.file ?? DEFAULT_LOG_FILE),
      opts.maxBytes ?? LOG_MAX_BYTES,
      opts.maxFiles ?? LOG_MAX_FILES,
    );
    dest = fileStream;
  }
  const now = opts.now ?? (() => new Date());
  const p = pino(
    {
      level: 'info',
      base: undefined,
      timestamp: () => `,"ts":"${now().toISOString()}"`,
      formatters: {
        level: (label: string) => ({ level: label }),
        bindings: () => ({}),
        log: (obj: Record<string, unknown>) => sanitizeLogFields(obj),
      },
    },
    { write: (s: string) => void dest.write(s) },
  );
  const emit = (level: 'info' | 'warn' | 'error', fields: LogFields): void => {
    p[level](sanitizeLogFields(fields));
  };
  return {
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
    close: () => fileStream?.close(),
  };
}
