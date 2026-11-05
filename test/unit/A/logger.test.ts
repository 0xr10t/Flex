// Lane A unit tests: §18 logging — allowlist serializer, never-logged values, pino JSON lines, level info,
// rotation at 10 MB × 5 files.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../../src/contracts/catalog.js';
import { STEP_ORDER } from '../../../src/contracts/step.js';
import { QUESTION_CODES } from '../../../src/contracts/types.js';
import { LOG_ALLOWED_FIELDS, type LogFields } from '../../../src/contracts/io.js';
import { DEFAULT_LOG_FILE, createLogger, sanitizeLogFields } from '../../../src/util/logger.js';
import { LOG_MAX_BYTES, LOG_MAX_FILES, RotatingFileStream } from '../../../src/util/rotating-file.js';
import { tempDir } from './helpers.js';

function capture(): { lines: () => Array<Record<string, unknown>>; log: ReturnType<typeof createLogger> } {
  const chunks: string[] = [];
  const log = createLogger({
    destination: { write: (c: string) => chunks.push(c) },
    now: () => new Date('2026-11-05T10:00:00.000Z'),
  });
  return {
    log,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe('§18 allowlist serializer', () => {
  it('C-429 / C-453: drops every field that is not allowlisted', () => {
    const out = sanitizeLogFields({
      event: 'x',
      request_id: 'req_aaaaaaaaaaaa',
      text: 'send 50 usdc to aradhya',
      amount: '50',
      address: '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
      name: 'Aradhya',
      ens_name: 'riya.eth',
      tx_hash: '0xabc',
      url: 'https://example.com',
      prompt: 'p',
      output: { a: 1 },
      msg: 'free text',
      err: new Error('boom'),
    });
    expect(out).toEqual({ event: 'x', request_id: 'req_aaaaaaaaaaaa' });
  });

  it('C-429: keeps every allowlisted field with a well-shaped value', () => {
    const all: LogFields = {
      session_id: 'ses_aaaaaaaaaaaa',
      request_id: 'req_aaaaaaaaaaaa',
      step: 's3',
      state: 'AMOUNTS_MASKED',
      event: 'step_done',
      error_code: 'LIMIT_DAILY',
      question_code: 'Q_TOKEN',
      attempt: 2,
      llm_call: 'amounts',
      llm_retry: true,
      duration_ms: 12,
      n_amounts: 1,
      n_payees: 2,
      n_intents: 3,
      rule_id: 'V-15',
      chain_ids_unavailable: [84532],
      http_status: 503,
    };
    expect(sanitizeLogFields(all)).toEqual(all);
    // §18 lists exactly these fields (plus ts and level written by the logger).
    expect(LOG_ALLOWED_FIELDS).toEqual(['ts', 'level', ...Object.keys(all)]);
  });

  it('C-430: free text cannot ride in an allowed field (values must be code-shaped / typed)', () => {
    expect(
      sanitizeLogFields({
        event: 'send 50 usdc to aradhya',
        rule_id: 'a'.repeat(65),
        state: 'x y',
        attempt: '2',
        llm_call: 'chat',
        llm_retry: 'yes',
        chain_ids_unavailable: ['0x3fA9'],
        http_status: Number.NaN,
      }),
    ).toEqual({});
  });

  const CHECKSUMMED = '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E';
  const LOWER = '0x3fa94b8e2d1c7a6f5e4d3c2b1a0f9e8d7c6bc21e';
  const DROPPED: Array<[string, string]> = [
    ...['rule_id', 'event'].flatMap((f): Array<[string, string]> => [
      [f, CHECKSUMMED],
      [f, LOWER],
      [f, LOWER.slice(2)],
      [f, 'abcdef0123456789abcdef0123456789abcdef01'],
      [f, 'alice.eth'],
      [f, '12.5'],
      [f, '40'],
      [f, '50usdc'],
      [f, 'a'.repeat(65)],
    ]),
    ['state', '12.5'],
    ['state', 'Aradhya'],
    ['question_code', '40'],
    ['error_code', 'alice.eth'],
    ['step', 'Aradhya'],
    ['step', 's13'],
    ['session_id', 'hunter2'],
    ['session_id', `ses_${'a'.repeat(11)}`],
    ['request_id', `req_${'AB'.repeat(6)}`],
  ];
  for (const [field, value] of DROPPED) {
    it(`C-430 §18: ${field} = "${value}" is dropped`, () => {
      const out = sanitizeLogFields({ [field]: value } as unknown as LogFields);
      expect(out).not.toHaveProperty(field);
      expect(JSON.stringify(out)).not.toContain(value);
      expect(out).toEqual({});
    });
  }

  const STATES = [
    'RECEIVED',
    'BALANCES_REFRESHED',
    'GUARDED',
    'SCANNED',
    'AMOUNTS_MASKED',
    'TYPED',
    'SPANS_TAGGED',
    'RECIPIENTS_RESOLVED',
    'RECIPIENTS_MASKED',
    'PAIRED',
    'PLANNED',
    'VALIDATED',
    'AWAITING_CONFIRMATION',
    'HANDED_OFF',
    'HANDOFF_FAILED',
    'ANSWERED',
    'DISCARDED',
    'FAILED',
  ];
  it('C-429 §18: every §8.0 state, s0..s12, every question code and every error code is kept', () => {
    expect(STEP_ORDER).toHaveLength(13);
    for (const state of STATES) expect(sanitizeLogFields({ state })).toEqual({ state });
    for (const step of STEP_ORDER) expect(sanitizeLogFields({ step })).toEqual({ step });
    for (const question_code of QUESTION_CODES) {
      expect(sanitizeLogFields({ question_code } as LogFields)).toEqual({ question_code });
    }
    for (const error_code of Object.keys(ERROR_MESSAGE)) {
      expect(sanitizeLogFields({ error_code } as LogFields)).toEqual({ error_code });
    }
  });

  it('C-429 §18: the known rule ids, event labels and ids are kept', () => {
    for (const rule_id of [
      'V-15',
      'HANDOFF_INVALID',
      'cancel:no_active_request',
      's11:continue',
      'handoff_failed:message',
    ]) {
      expect(sanitizeLogFields({ rule_id })).toEqual({ rule_id });
      expect(sanitizeLogFields({ event: rule_id })).toEqual({ event: rule_id });
    }
    const ids = { session_id: 'ses_0123456789ab', request_id: 'req_abcdef012345' };
    expect(sanitizeLogFields(ids)).toEqual(ids);
  });

  it('C-428 §18: a destination whose write throws does not make log.info throw', () => {
    const log = createLogger({
      destination: {
        write: () => {
          throw new Error('disk full');
        },
      },
    });
    expect(() => log.info({ event: 'e' })).not.toThrow();
    expect(() => log.warn({ event: 'e' })).not.toThrow();
    expect(() => log.error({ event: 'e' })).not.toThrow();
  });

  it('C-429: caller-supplied ts/level are dropped (the logger writes its own); non-objects yield nothing', () => {
    expect(sanitizeLogFields({ ts: 'fake', level: 'debug', event: 'e' })).toEqual({ event: 'e' });
    expect(sanitizeLogFields(null)).toEqual({});
    expect(sanitizeLogFields('text')).toEqual({});
  });
});

describe('§18 logger output', () => {
  it('C-428: pino JSON lines with ts and level, level info', () => {
    const { log, lines } = capture();
    log.info({ event: 'request_final', state: 'HANDED_OFF' });
    log.warn({ event: 'unsupported_state', rule_id: 'x' });
    log.error({ event: 'http_error', http_status: 500 });
    expect(lines()).toEqual([
      { level: 'info', ts: '2026-11-05T10:00:00.000Z', event: 'request_final', state: 'HANDED_OFF' },
      { level: 'warn', ts: '2026-11-05T10:00:00.000Z', event: 'unsupported_state', rule_id: 'x' },
      { level: 'error', ts: '2026-11-05T10:00:00.000Z', event: 'http_error', http_status: 500 },
    ]);
  });

  it('C-430: a line written with secret-looking extras contains none of them (no pid, hostname, msg)', () => {
    const { log, lines } = capture();
    log.info({ event: 'e', ...({ text: 'seed words here', amount: '50', name: 'Aradhya' } as object) } as LogFields);
    const raw = JSON.stringify(lines());
    for (const s of ['seed words', '"50"', 'Aradhya', 'pid', 'hostname', 'msg']) expect(raw).not.toContain(s);
  });

  it('C-429: there is no debug level or option to relax the allowlist', () => {
    const { log } = capture();
    expect((log as unknown as Record<string, unknown>).debug).toBeUndefined();
    expect(Object.keys(log).sort()).toEqual(['close', 'error', 'info', 'warn']);
  });

  it('C-428: default file is ~/.agent-layer/logs/agent.log; rotation defaults 10 MB × 5', () => {
    expect(DEFAULT_LOG_FILE).toBe('~/.agent-layer/logs/agent.log');
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(LOG_MAX_FILES).toBe(5);
  });

  it('C-428: a file logger writes JSON lines to the given file (mode 0600)', () => {
    const file = join(tempDir(), 'logs', 'agent.log');
    const log = createLogger({ file });
    log.info({ event: 'startup_done' });
    log.close();
    const line = JSON.parse(readFileSync(file, 'utf8').trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'info', event: 'startup_done' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe('§18 rotation', () => {
  it('C-428: rotates when the next write would exceed maxBytes; keeps at most maxFiles files', () => {
    const file = join(tempDir(), 'agent.log');
    const s = new RotatingFileStream(file, 100, 3);
    for (let i = 0; i < 10; i++) s.write(`${String(i).repeat(59)}\n`); // 60 bytes each: one line per file
    s.close();
    expect(readFileSync(file, 'utf8')).toBe(`${'9'.repeat(59)}\n`);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(`${'8'.repeat(59)}\n`);
    expect(readFileSync(`${file}.2`, 'utf8')).toBe(`${'7'.repeat(59)}\n`);
    expect(existsSync(`${file}.3`)).toBe(false);
  });

  it('C-428: lines are appended until the limit; a reopened stream continues the existing size', () => {
    const file = join(tempDir(), 'agent.log');
    const s = new RotatingFileStream(file, 100, 5);
    s.write('a'.repeat(40));
    s.write('b'.repeat(40));
    s.close();
    const s2 = new RotatingFileStream(file, 100, 5);
    s2.write('c'.repeat(40)); // 120 > 100 → rotate first
    s2.close();
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('a'.repeat(40) + 'b'.repeat(40));
    expect(readFileSync(file, 'utf8')).toBe('c'.repeat(40));
  });

  it('C-428: a single oversized line is still written (never dropped)', () => {
    const file = join(tempDir(), 'agent.log');
    const s = new RotatingFileStream(file, 10, 2);
    s.write('x'.repeat(50));
    s.close();
    expect(readFileSync(file, 'utf8')).toBe('x'.repeat(50));
  });

  it('C-428: invalid rotation settings are refused', () => {
    expect(() => new RotatingFileStream(join(tempDir(), 'a.log'), 0, 5)).toThrow();
    expect(() => new RotatingFileStream(join(tempDir(), 'a.log'), 10, 0)).toThrow();
  });
  it('C-428: if a rename fails during rotate() the file is reopened and later writes still land in <path>', () => {
    const file = join(tempDir(), 'agent.log');
    const s = new RotatingFileStream(file, 100, 2);
    s.write('a'.repeat(60));
    // <path>.1 is a non-empty directory, so renaming <path> onto it fails.
    mkdirSync(`${file}.1`);
    writeFileSync(join(`${file}.1`, 'keep'), 'x');
    expect(() => s.write('b'.repeat(60))).toThrow();
    expect(() => s.write('c'.repeat(10))).not.toThrow();
    s.close();
    const content = readFileSync(file, 'utf8');
    expect(content.endsWith('c'.repeat(10))).toBe(true);
    expect(content.startsWith('a'.repeat(60))).toBe(true);
  });
});
