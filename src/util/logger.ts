// Implements: §18 logging — pino JSON lines to ~/.agent-layer/logs/agent.log, rotated at 10 MB × 5 files, level
// info; allowlisted fields only (a custom serializer drops every other field; no debug mode relaxes this);
// never-logged values (each allowed field also has its own value shape: closed lists and exact id formats where the
// values are known, a label shape for `event` and `rule_id`, so amounts, addresses, ENS names and free text cannot
// ride in an allowed field); NFR-04. Owner: Lane A.

import { pino } from 'pino';
import { ERROR_MESSAGE } from '../contracts/catalog.js';
import { LOG_ALLOWED_FIELDS, type AllowlistLogger, type LogFields } from '../contracts/io.js';
import { STEP_ORDER } from '../contracts/step.js';
import { QUESTION_CODES } from '../contracts/types.js';
import { expandHome } from '../config/load.js';
import { REQUEST_STATES } from '../session/request.js';
import { LOG_MAX_BYTES, LOG_MAX_FILES, RotatingFileStream } from './rotating-file.js';

/** §18 default log file. */
export const DEFAULT_LOG_FILE = '~/.agent-layer/logs/agent.log';

/**
 * `event` and `rule_id` (open sets, every lane adds its own): starts with a letter, no dots, optional `:` parts. Refuses
 * amounts, addresses and ENS names. A bare word such as a name still fits; callers pass only constants here.
 */
const LABEL_RE = /^[A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)*$/;
const LONG_HEX_RE = /[0-9a-fA-F]{16}/;
const SESSION_ID_RE = /^ses_[0-9a-f]{12}$/;
const REQUEST_ID_RE = /^req_[0-9a-f]{12}$/;
const LLM_CALLS = new Set([
  'amounts',
  'request_type',
  'spans',
  'payments',
  'quarantine',
  'conversation',
  'chat_route',
  'chat',
]);

type Check = (v: unknown) => boolean;
const matches =
  (re: RegExp): Check =>
  (v) =>
    typeof v === 'string' && re.test(v);
const oneOf = (values: Iterable<string>): Check => {
  const set = new Set(values);
  return (v) => typeof v === 'string' && set.has(v);
};
const isLabel: Check = (v) => typeof v === 'string' && v.length <= 64 && LABEL_RE.test(v) && !LONG_HEX_RE.test(v);
const isNum: Check = (v) => typeof v === 'number' && Number.isFinite(v);

/** Value shape per allowlisted field. `ts` and `level` are written by the logger itself. */
const FIELD_CHECKS: Readonly<Record<string, Check>> = {
  session_id: matches(SESSION_ID_RE),
  request_id: matches(REQUEST_ID_RE),
  step: oneOf(STEP_ORDER),
  state: oneOf(REQUEST_STATES),
  event: isLabel,
  error_code: oneOf(Object.keys(ERROR_MESSAGE)),
  question_code: oneOf(QUESTION_CODES),
  attempt: isNum,
  llm_call: oneOf(LLM_CALLS),
  llm_retry: (v) => typeof v === 'boolean',
  duration_ms: isNum,
  n_amounts: isNum,
  n_payees: isNum,
  n_intents: isNum,
  rule_id: isLabel,
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
      },
    },
    { write: (s: string) => void dest.write(s) },
  );
  const emit = (level: 'info' | 'warn' | 'error', fields: LogFields): void => {
    try {
      p[level](sanitizeLogFields(fields));
    } catch {
      // A full disk or a failed rotation must not fail the request being logged; the line is lost.
    }
  };
  return {
    info: (f) => emit('info', f),
    warn: (f) => emit('warn', f),
    error: (f) => emit('error', f),
    close: () => fileStream?.close(),
  };
}
