import { expect, it } from 'vitest';
import * as input from '../../../src/cli/input.js';
import { Repl } from '../../../src/cli/repl.js';
import { createFrame } from '../../../src/cli/render/frame.js';
const type = (r: Repl, s: string) => {
  for (const char of s) r.handle({ kind: 'key', key: 'char', char });
};
it('extends an input selection with Shift+Arrow and copies it without arming exit', async () => {
  const copied: string[] = [];
  const r = new Repl({
    copy: async (s) => {
      copied.push(s);
      return true;
    },
  });
  type(r, 'hello world');
  for (let i = 0; i < 5; i++) r.handle({ kind: 'key', key: 'left', shift: true });
  r.handle({ kind: 'key', key: 'interrupt' });
  await r.idle();
  expect(copied).toEqual(['world']);
  expect(r.input).toBe('hello world');
  expect(r.exitArmed).toBe(false);
});
it('replaces a selection with pasted text, strips controls and never submits', () => {
  const r = new Repl();
  type(r, 'hello');
  r.handle({ kind: 'key', key: 'home', shift: true });
  r.handle({ kind: 'key', key: 'paste', char: 'new\nline\u001b\u0003' });
  expect(r.input).toBe('new line');
  expect(r.conversation.filter((x) => x.kind === 'user')).toHaveLength(0);
});
it('cuts only selected input and supports clipboard paste', async () => {
  const copied: string[] = [];
  const r = new Repl({
    copy: async (s) => {
      copied.push(s);
      return true;
    },
    paste: async () => 'PASTED\nTEXT',
  });
  type(r, 'hello world');
  for (let i = 0; i < 5; i++) r.handle({ kind: 'key', key: 'left', shift: true });
  r.handle({ kind: 'key', key: 'cut' });
  await r.idle();
  expect(r.input).toBe('hello ');
  expect(copied).toEqual(['world']);
  r.handle({ kind: 'key', key: 'clipboard-paste' });
  await r.idle();
  expect(r.input).toBe('hello PASTED TEXT');
});
it('selects transcript text by dragging without copying borders or moving input', async () => {
  const copied: string[] = [];
  const r = new Repl({
    copy: async (s) => {
      copied.push(s);
      return true;
    },
  });
  r.notify([[{ text: 'Hello wallet', tone: 0 }]]);
  const f = createFrame(60, 20);
  r.drawConversation(f, { x: 2, y: 2, w: 30, h: 10 });
  const at = f.ch.join('').indexOf('Hello wallet');
  const col = (at % f.cols) + 1,
    row = Math.floor(at / f.cols) + 1;
  r.mouse({ kind: 'mouse', col, row, action: 'down', button: 0 });
  r.mouse({ kind: 'mouse', col: col + 5, row, action: 'move', button: 0 });
  r.mouse({ kind: 'mouse', col: col + 5, row, action: 'up', button: 0 });
  r.handle({ kind: 'key', key: 'interrupt' });
  await r.idle();
  expect(copied).toEqual(['Hello']);
});
it('preserves paste and UTF-8 across raw input chunks until the end marker', () => {
  expect(input.InputDecoder).toBeTypeOf('function');
  const d = new input.InputDecoder();
  expect(d.feed(Buffer.from('\u001b[20'))).toEqual([]);
  expect(d.feed(Buffer.from('0~send\n'))).toEqual([]);
  const utf8 = Buffer.from('é');
  expect(d.feed(utf8.subarray(0, 1))).toEqual([]);
  expect(d.feed(utf8.subarray(1))).toEqual([]);
  expect(d.feed(Buffer.from('\u001b[201~'))).toEqual([{ kind: 'key', key: 'paste', char: 'send\né' }]);
});

it('keeps an incomplete paste marker buffered after an Escape timeout', () => {
  const d = new input.InputDecoder();
  expect(d.feed('\u001b[20')).toEqual([]);
  expect(d.flush()).toEqual([]);
  expect(d.feed('0~send\nyes\u001b[201~')).toEqual([{ kind: 'key', key: 'paste', char: 'send\nyes' }]);
});
it('removes a selection with readline deletion and keeps failed cuts intact', async () => {
  const r = new Repl({ copy: async () => false });
  type(r, 'abc def');
  r.handle({ kind: 'key', key: 'left', shift: true });
  r.handle({ kind: 'key', key: 'cut' });
  await r.idle();
  expect(r.input).toBe('abc def');
  r.handle({ kind: 'key', key: 'kill-start' });
  expect(r.input).toBe('abc de');
});
it('copies soft-wrapped transcript text as original text after scrolling and resizing', async () => {
  const copied: string[] = [];
  const r = new Repl({
    copy: async (s) => {
      copied.push(s);
      return true;
    },
  });
  const address = '0x1234567890123456789012345678901234567890';
  r.notify([[{ text: address, tone: 0 }]]);
  const f = createFrame(80, 30);
  r.drawConversation(f, { x: 2, y: 2, w: 20, h: 15 });
  const at = f.ch.join('').indexOf('0x1234567890123456');
  const col = (at % f.cols) + 1,
    row = Math.floor(at / f.cols) + 1;
  r.mouse({ kind: 'mouse', col, row, action: 'down', button: 0 });
  r.mouse({ kind: 'mouse', col: col + 6, row: row + 2, action: 'up', button: 0 });
  r.drawConversation(f, { x: 2, y: 2, w: 40, h: 15 });
  r.handle({ kind: 'key', key: 'interrupt' });
  await r.idle();
  expect(copied).toEqual([address]);
});
it('allows normal input deletion after a click with no selected range', () => {
  const r = new Repl();
  type(r, 'hello');
  r.drawInput(createFrame(80, 20), 2, 10, 60, 0);
  r.mouse({ kind: 'mouse', col: 11, row: 11, action: 'down', button: 0 });
  r.mouse({ kind: 'mouse', col: 11, row: 11, action: 'up', button: 0 });
  r.handle({ kind: 'key', key: 'backspace' });
  expect(r.input.length).toBe(4);
});
it('recognizes modified Home and End terminal encodings for selection', () => {
  expect(input.parseInput('\u001b[1;2~\u001b[4;2~')).toEqual([
    { kind: 'key', key: 'home', shift: true },
    { kind: 'key', key: 'end', shift: true },
  ]);
});
it('deletes normally after Shift+Arrow collapses the selection', () => {
  const r = new Repl();
  type(r, 'abc');
  r.handle({ kind: 'key', key: 'left', shift: true });
  r.handle({ kind: 'key', key: 'right', shift: true });
  r.handle({ kind: 'key', key: 'backspace' });
  expect(r.input).toBe('ab');
});
it('keeps the last copyable reply after selection-only commands', async () => {
  const { Chat } = await import('../../../src/cli/chat.js');
  const copied: string[] = [];
  const chat = new Chat({
    connect: async () => {
      throw new Error('offline');
    },
    timezone: 'UTC',
    openPage: () => false,
    copy: async (text) => {
      copied.push(text);
      return true;
    },
  });
  const r = new Repl({ commands: chat.commands() });
  r.notify([[{ text: 'Earlier full reply', tone: 0 }]]);
  type(r, '/select clear');
  r.handle({ kind: 'key', key: 'enter' });
  await r.idle();
  type(r, '/copy');
  r.handle({ kind: 'key', key: 'enter' });
  await r.idle();
  expect(copied).toEqual(['Earlier full reply']);
});
