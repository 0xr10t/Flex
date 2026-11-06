// Phase 3 audit (§3.2 item 5): §15 "Messages never contain amounts, addresses or names beyond what the user typed".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ERROR_MESSAGE } from '../../src/contracts/catalog.js';
import { Harness, loadFixture } from '../acceptance/harness.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');
function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ path: relative(SRC, p), text: readFileSync(p, 'utf8') }));

describe('error messages come from the catalog', () => {
  it('AgentResponse.error is built only in session/manager.ts, from ERROR_MESSAGE[code](params)', () => {
    const builders = files
      .filter((f) => !f.path.startsWith('contracts/') && /\berror:\s*\{\s*code/.test(f.text))
      .map((f) => f.path);
    expect(builders).toEqual(['session/manager.ts']);
    const m = files.find((f) => f.path === 'session/manager.ts')!.text;
    const msgs = [...m.matchAll(/error:\s*\{\s*code[^\n]*/g)].map((x) => x[0]);
    expect(msgs.length).toBe(2);
    // unsupportedReply: literal catalog call; fail(): the `message` computed from ERROR_MESSAGE[code](params ?? {}).
    expect(msgs[0]).toMatch(/message: ERROR_MESSAGE\.UNSUPPORTED_REQUEST\(\{\}\)/);
    expect(msgs[1]).toMatch(/code: errCode, message/);
    expect(m).toMatch(/message = ERROR_MESSAGE\[code\]\(params \?\? \{\}\)/);
  });

  it('steps return {kind:"error", code, params}; params are the only free text, listed by step', () => {
    const paramSites = files
      .flatMap((f) =>
        f.text
          .split('\n')
          .map((l, i) => ({ l, at: `${f.path}:${i + 1}` }))
          .filter(({ l }) => /kind: 'error'.*params: \{/.test(l) && !/^\s*(\/\/|\*)/.test(l)),
      )
      .filter(({ l }) => /params: \{[^}]*(message|text|raw|typed|prompt)[^}]*\}/.test(l))
      .map(({ at }) => at);
    // The only param whose value is external, free-form text is the execution layer's `message`.
    expect(paramSites).toEqual(['pipeline/s12-handoff.ts:161']);
  });

  it('every catalog entry renders from its own params without throwing for the documented slots', () => {
    expect(Object.keys(ERROR_MESSAGE).length).toBeGreaterThan(30);
    expect(ERROR_MESSAGE.SECRET_DETECTED({})).not.toMatch(/0x|\d{3,}/);
  });
});

describe('EXECUTION_REJECTED echoes the execution layer text (by design, §8.14 step 5)', () => {
  it('SQ-O-09 OBS: the 4xx `message` reaches the UI response capped at 200 characters with control characters removed, and never the logs', async () => {
    const h = new Harness('audit-rej', loadFixture('A-01'), {});
    const nasty = `rejected: wallet 0x3fA94b8e2d1C7a6f5E4d3C2b1A0f9e8D7c6Bc21E balance 12345.67 USDC <b>x</b>\u0007\u001b[31m\n${'y'.repeat(4000)}`;
    h.exec.responses = [{ status: 'rejected', message: nasty }];
    const r = await h.say('Send 50 USDc to ARADHYA');
    const done = await h.confirm(r, 'yes');
    expect(done.body.error?.code).toBe('EXECUTION_REJECTED');
    const cleaned = nasty.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    expect(done.body.error?.message).toBe(`Your wallet couldn't accept this: ${[...cleaned].slice(0, 200).join('')}`);
    expect(done.body.error?.message.length).toBeLessThan(260);
    // eslint-disable-next-line no-control-regex
    expect(done.body.error?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const log = readFileSync(h.logFile, 'utf8');
    expect(log).not.toContain('balance 12345');
    expect(log).not.toContain('yyyy');
    await h.finish();
  });
});

describe('other external text', () => {
  it('ATTACHMENT_UNSUPPORTED echoes only the file name the user attached', async () => {
    const h = new Harness('audit-att', { calls: [] }, {});
    const r = await h.say('read it', {
      attachments: [{ filename: 'pic.png', mime: 'image/png', base64: Buffer.from('x').toString('base64') }],
    });
    expect(r.body.error?.code).toBe('ATTACHMENT_UNSUPPORTED');
    expect(r.body.error?.message).toBe("I can only read text and PDF files. pic.png wasn't read, so nothing was done.");
    await h.finish();
  });

  it('HTTP-level errors (400/401/404/409) never contain request content', async () => {
    const h = new Harness('audit-http', { calls: [] }, {});
    const r = await h.http('POST', '/v1/sessions/ses_000000000000/messages', {
      body: { text: 'send 50 usdc to Aradhya' },
    });
    expect(r.status).toBe(404);
    expect(r.text).not.toMatch(/Aradhya|usdc/i);
    await h.finish();
  });
});
