// Phase 3 audit (§3.2): logger allowlist and static search of every log call site. Run with:
//   npx vitest run test/audit --dir .   (test/audit is not in vitest.config.ts `include`)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sanitizeLogFields } from '../../src/util/logger.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));
const code = (t: string): string =>
  t
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

describe('logger serializer (§18)', () => {
  it('drops every non-allowlisted key, whatever its value', () => {
    const out = sanitizeLogFields({
      event: 'ok_event',
      text: 'send 50 usdc to Aradhya',
      amount: '50',
      address: '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
      name: 'Aradhya',
      ens: 'riya.eth',
      message: 'hello',
      err: new Error('boom'),
      ts: 'forged',
      level: 'forged',
    });
    expect(out).toEqual({ event: 'ok_event' });
  });

  it('drops values of the wrong shape in allowed fields (address, amount, ens name, long label, free text)', () => {
    for (const bad of [
      '0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E',
      '50.5',
      'riya.eth',
      'send 50 usdc',
      'a'.repeat(65),
      'aaaaaaaaaaaaaaaa0123456789abcdef',
    ]) {
      expect(sanitizeLogFields({ event: bad, rule_id: bad }), bad).toEqual({});
    }
    expect(sanitizeLogFields({ session_id: 'Aradhya', request_id: '0xabc', step: 'aradhya', state: 'x' })).toEqual({});
    expect(sanitizeLogFields({ error_code: 'ARADHYA', question_code: 'Q_ARADHYA', llm_call: 'p' })).toEqual({});
  });

  it('OBS: a bare word (e.g. a first name) is a valid event/rule_id label', () => {
    // Characterisation of the logger.ts comment "a bare word such as a name still fits". Safe only because every
    // call site passes a constant (see the static tests below).
    expect(sanitizeLogFields({ event: 'Aradhya', rule_id: 'Mihir' })).toEqual({ event: 'Aradhya', rule_id: 'Mihir' });
  });
});

describe('log call sites (static search)', () => {
  const callRe = /\b(?:log|logger)\??\.(info|warn|error)\(/g;

  it('every log call passes an object literal (no variable carrying values)', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      if (f.path === 'util/logger.ts') continue;
      const t = code(f.text);
      for (const m of t.matchAll(callRe)) {
        seen++;
        const rest = t.slice(m.index + m[0].length);
        if (!/^\s*\{/.test(rest)) bad.push(`${f.path}: ${rest.slice(0, 40)}`);
      }
    }
    expect(seen).toBeGreaterThan(40);
    expect(bad).toEqual([]);
  });

  it('no console.* / stdout writes in src; stderr only the fixed startup-failed line', () => {
    const hits: string[] = [];
    for (const f of files)
      for (const l of code(f.text).split('\n'))
        if (/console\.|process\.std(out|err)/.test(l)) hits.push(`${f.path}: ${l.trim()}`);
    expect(hits).toEqual(["index.ts: process.stderr.write('agent-layer: startup failed\\n');"]);
  });

  it('every `event:` is a string literal (single exception: the two-literal ternary in index.ts)', () => {
    const nonLiteral: string[] = [];
    for (const f of files) {
      if (f.path === 'util/logger.ts' || f.path === 'contracts/io.ts') continue;
      for (const l of code(f.text).split('\n')) {
        const m = /\bevent:\s*(.*)$/.exec(l);
        if (m && !/^'[A-Za-z][A-Za-z0-9_-]*'/.test(m[1] ?? '')) nonLiteral.push(`${f.path}: ${l.trim()}`);
      }
    }
    expect(nonLiteral).toEqual([
      "index.ts: log.info({ event: ollama ? 'startup_model_ok' : 'startup_model_unavailable' });",
    ]);
  });

  it('OBS: computed rule_id values (template literals) are limited to the session manager and use closed StepName values', () => {
    // rule_id reaches the logger through helper parameters (unsupported / internalError / logUnsupported). Every
    // caller passes a literal except the template strings below, whose interpolated value is a StepName.
    const calls = /\b(?:this\.)?(?:unsupported|internalError|logUnsupported)\(([^;]*)\)/g;
    const computed: string[] = [];
    for (const f of files) {
      for (const m of code(f.text).matchAll(calls)) {
        const args = m[1] ?? '';
        if (args.includes('`')) computed.push(`${f.path}: ${args.trim()}`);
      }
    }
    expect(computed).toEqual([
      'session/manager.ts: s, a, `${paused.step}:no_answer_handler`',
      'session/manager.ts: s, a, `${step}:summary`',
      'session/manager.ts: s, a, `${step}:continue`',
      'session/manager.ts: s, a, `${step}:unknown_result`',
    ]);
  });

  it('log call objects contain only allowlisted keys', () => {
    const allowed = new Set([
      'event',
      'session_id',
      'request_id',
      'step',
      'state',
      'error_code',
      'question_code',
      'attempt',
      'llm_call',
      'llm_retry',
      'duration_ms',
      'n_amounts',
      'n_payees',
      'n_intents',
      'rule_id',
      'chain_ids_unavailable',
      'http_status',
    ]);
    const bad: string[] = [];
    for (const f of files) {
      if (f.path === 'util/logger.ts') continue;
      const t = code(f.text);
      for (const m of t.matchAll(callRe)) {
        const start = m.index + m[0].length;
        let depth = 0;
        let end = start;
        for (; end < t.length; end++) {
          if (t[end] === '{') depth++;
          if (t[end] === '}' && --depth === 0) break;
        }
        for (const k of t.slice(start, end + 1).matchAll(/(?:^|[{,]\s*)(\.\.\.)?([a-z_]+)\s*(?::|,|\})/g)) {
          if (k[1]) continue;
          if (!allowed.has(k[2] ?? '')) bad.push(`${f.path}: ${k[2]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
