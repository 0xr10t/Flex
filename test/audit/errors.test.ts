// Phase 3 audit (§3.2 item 5): §15 "Messages never contain amounts, addresses or names beyond what the user typed".
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
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
    const createdIn = new Set<string>();
    const messageSources = new Set<string>();
    const reusedIn = new Set<string>();
    const field = (object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
      for (const property of object.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText().replace(/^['"]|['"]$/g, '') === name)
          return property.initializer;
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
      }
      return undefined;
    };
    const method = (node: ts.Node): string => {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (ts.isMethodDeclaration(parent)) return parent.name.getText();
      return '<outside method>';
    };
    const catalogCall = (node: ts.Expression): boolean =>
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText() === 'ERROR_MESSAGE') ||
        (ts.isElementAccessExpression(node.expression) && node.expression.expression.getText() === 'ERROR_MESSAGE'));
    const responseError = (node: ts.Expression, owner: string): boolean => {
      if (ts.isObjectLiteralExpression(node))
        return field(node, 'code') !== undefined && field(node, 'message') !== undefined;
      if (node.getText() === 'a.lastError') return owner === 'fail' || owner === 'chatReply';
      if (node.getText() === 'extra.error') return owner === 'respond';
      return (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        node.left.getText() === 'a.lastError' &&
        owner === 'chatReply' &&
        responseError(node.right, owner)
      );
    };

    for (const source of files.filter((f) => !f.path.startsWith('contracts/'))) {
      const tree = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const code = field(node, 'code');
          const message = field(node, 'message');
          if (code && message) {
            expect(source.path, node.getText()).toBe('session/manager.ts');
            const owner = method(node);
            createdIn.add(owner);
            if (catalogCall(message)) {
              // Literal catalog entries must correspond to the exposed error code.
              expect(ts.isStringLiteralLike(code), node.getText()).toBe(true);
              expect(message.getText()).toBe(`ERROR_MESSAGE.${(code as ts.StringLiteral).text}({})`);
            } else {
              // fail() shares the catalog-built message through lastError; it never rebuilds one from chat.
              expect({ owner, code: code.getText(), message: message.getText() }).toEqual({
                owner: 'fail',
                code: 'errCode',
                message: 'message',
              });
            }
          }
        }
        if (source.path === 'session/manager.ts') {
          const owner = method(node);
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            if (node.left.getText() === 'message' && owner === 'fail') {
              expect(catalogCall(node.right), node.getText()).toBe(true);
              messageSources.add(node.right.getText());
            }
            if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'lastError') {
              expect(owner).toBe('fail');
              expect(
                ts.isObjectLiteralExpression(node.right) && field(node.right, 'message')?.getText() === 'message',
              ).toBe(true);
            }
            if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'error') {
              expect(responseError(node.right, owner), node.getText()).toBe(true);
              reusedIn.add(owner);
            }
          }
          if (ts.isPropertyAssignment(node) && node.name.getText() === 'error') {
            expect(responseError(node.initializer, owner), node.getText()).toBe(true);
            reusedIn.add(owner);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    // Named paths make this non-vacuous without pinning object count, layout, or source line numbers.
    expect([...createdIn].sort()).toEqual(['chatReply', 'fail', 'unsupportedReply']);
    expect([...reusedIn].sort()).toEqual(['chatReply', 'fail', 'respond', 'unsupportedReply']);
    expect([...messageSources].sort()).toEqual([
      'ERROR_MESSAGE.INTERNAL_ERROR({})',
      'ERROR_MESSAGE[code](params ?? {})',
    ]);
  });

  it('steps return {kind:"error", code, params}; params are the only free text, listed by step', () => {
    const paramSites = files
      .flatMap((f) =>
        f.text
          .split('\n')
          .map((l) => ({ l, path: f.path }))
          .filter(({ l }) => /kind: 'error'.*params: \{/.test(l) && !/^\s*(\/\/|\*)/.test(l)),
      )
      .filter(({ l }) => /params: \{[^}]*(message|text|raw|typed|prompt)[^}]*\}/.test(l))
      .map(({ l, path }) => ({ path, code: l.trim() }));
    // The only param whose value is external, free-form text is the execution layer's `message`.
    expect(paramSites).toEqual([
      {
        path: 'pipeline/s12-handoff.ts',
        code: "return { kind: 'error', code: 'EXECUTION_REJECTED', params: { message: rejectMessage(result.message) } };",
      },
    ]);
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
    // eslint-disable-next-line no-control-regex
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
