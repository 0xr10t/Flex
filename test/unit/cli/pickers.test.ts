// Choosing with the arrow keys: /db's database list, the answers a waiting question offers above the input, and the
// highlighted details in replies.
import { describe, expect, it } from 'vitest';
import { DATA_RESOURCES } from '@flex/protocol';
import { dataPicker } from '../../../src/cli/data.js';
import { highlight } from '../../../src/cli/highlight.js';
import { createFrame, frameLines } from '../../../src/cli/render/frame.js';
import { paintRow, SCENE_PALETTE } from '../../../src/cli/render/paint.js';
import { Repl, type ChoiceMenu, type Line } from '../../../src/cli/repl.js';
import type { KeyEvent } from '../../../src/cli/input.js';

const key = (k: KeyEvent['key'], char?: string): KeyEvent => ({ kind: 'key', key: k, ...(char ? { char } : {}) });
const type = (repl: Repl, s: string) => {
  for (const c of s) repl.handle(key('char', c));
};
const draw = (repl: Repl, cols = 120, rows = 30) => {
  const f = createFrame(cols, rows);
  repl.drawConversation(f, { x: 0, y: 0, w: cols, h: rows - 4 });
  repl.drawInput(f, 0, rows - 2, cols, 0);
  return { f, lines: frameLines(f).map((l) => l.trimEnd()) };
};

describe('/db: choosing a database with the arrow keys', () => {
  const setup = () => {
    const ran: string[][] = [];
    const repl = new Repl({
      commands: [
        { name: 'db', summary: 'databases', run: () => ({ kind: 'panel', panel: dataPicker() }) },
        {
          name: 'get',
          summary: 'records',
          run: (args) => (ran.push(args), [[{ text: `rows of ${args[0]}`, tone: 0 }]]),
        },
      ],
    });
    type(repl, '/db');
    repl.handle(key('enter'));
    return { repl, ran };
  };

  it('lists every database, the first one highlighted', () => {
    const { repl } = setup();
    expect(repl.hasPanel).toBe(true);
    const { lines, f } = draw(repl, 120, 40);
    expect(lines[0]).toContain('Databases');
    for (const s of DATA_RESOURCES.slice(0, 5)) expect(lines.join('\n')).toContain(s.resource);
    expect(lines[2]).toMatch(/^❯ amounts/);
    expect(f.tone[2 * 120 + 5]).toBe(3);
  });

  it('↓ moves the highlight and Enter shows that database, then the list closes', () => {
    const { repl, ran } = setup();
    repl.handle(key('down'));
    repl.handle(key('down'));
    repl.handle(key('enter'));
    expect(repl.hasPanel).toBe(false);
    expect(ran).toEqual([[DATA_RESOURCES[2]!.resource]]);
    const texts = repl.conversation.map((e) => (e.kind === 'user' ? e.text : ''));
    expect(texts).toContain(`/get ${DATA_RESOURCES[2]!.resource}`);
  });

  it('↑ stops at the top, End jumps to the last, Esc closes without reading anything', () => {
    const { repl, ran } = setup();
    repl.handle(key('up'));
    repl.handle(key('end'));
    repl.handle(key('enter'));
    expect(ran).toEqual([[DATA_RESOURCES.at(-1)!.resource]]);
    type(repl, '/db');
    repl.handle(key('enter'));
    repl.handle(key('escape'));
    expect(repl.hasPanel).toBe(false);
    expect(ran).toHaveLength(1);
  });

  it('scrolls when the list is taller than the window', () => {
    const { repl } = setup();
    for (let i = 0; i < DATA_RESOURCES.length - 1; i++) repl.handle(key('down'));
    const { lines } = draw(repl, 120, 14);
    expect(lines.join('\n')).toContain(`❯ ${DATA_RESOURCES.at(-1)!.resource}`);
    expect(lines.join('\n')).toContain(`${DATA_RESOURCES.length} of ${DATA_RESOURCES.length}`);
  });
});

describe('answering a question with the arrow keys', () => {
  const menu = (over: Partial<ChoiceMenu> = {}): ChoiceMenu => ({
    key: 'q1',
    title: 'Is 0.001 in USDC or ETH?',
    items: [
      { label: 'USDC', value: '1' },
      { label: 'ETH', value: '2' },
    ],
    ...over,
  });
  const setup = (current: () => ChoiceMenu | undefined) => {
    const sent: string[] = [];
    const repl = new Repl({
      choices: current,
      onMessage: async (text) => (sent.push(text), [[{ text: 'ok', tone: 0 }]]),
    });
    return { repl, sent };
  };

  it('shows the answers above the empty input and sends the one Enter picks', async () => {
    const { repl, sent } = setup(() => menu());
    const { lines } = draw(repl);
    const shown = lines.join('\n');
    expect(shown).toContain('Is 0.001 in USDC or ETH?');
    expect(shown).toMatch(/❯ USDC/);
    expect(shown).toContain('or type an answer');
    repl.handle(key('down'));
    repl.handle(key('enter'));
    await repl.idle();
    expect(sent).toEqual(['2']);
  });

  it('wraps around and skips answers that cannot be picked', async () => {
    const m = menu({
      items: [
        { label: 'A', value: '1' },
        { label: 'B', value: '2', disabled: true },
        { label: 'C', value: '3' },
      ],
    });
    const { repl, sent } = setup(() => m);
    repl.handle(key('down'));
    repl.handle(key('enter'));
    await repl.idle();
    expect(sent).toEqual(['3']);
  });

  it('typing hides the menu and sends your own words; ↑ then recalls history again after Esc', async () => {
    const { repl, sent } = setup(() => menu());
    type(repl, 'usdc please');
    expect(repl.choiceMenu).toBeUndefined();
    repl.handle(key('enter'));
    await repl.idle();
    expect(sent).toEqual(['usdc please']);
    repl.handle(key('escape'));
    expect(repl.choiceMenu).toBeUndefined();
    repl.handle(key('up'));
    expect(repl.input).toBe('usdc please');
  });

  it('a list of people: everyone starts ticked, Space unticks, Enter sends the rest', async () => {
    const people = menu({
      key: 'members',
      multi: true,
      items: ['alpha', 'beta', 'gamma'].map((n, i) => ({
        label: `${n}.iitr.eth`,
        value: String(i + 1),
        selected: true,
      })),
    });
    const { repl, sent } = setup(() => people);
    repl.handle(key('down'));
    repl.handle(key('char', ' '));
    expect(draw(repl).lines.join('\n')).toMatch(/\[ \] beta\.iitr\.eth/);
    repl.handle(key('enter'));
    await repl.idle();
    expect(sent).toEqual(['1,3']);
  });

  it('a new question gets a fresh menu after the last was answered', async () => {
    let current = menu();
    const { repl, sent } = setup(() => current);
    repl.handle(key('enter'));
    await repl.idle();
    expect(repl.choiceMenu).toBeUndefined();
    current = menu({
      key: 'q2',
      title: 'Confirm?',
      items: [
        { label: 'Yes', value: 'y' },
        { label: 'No', value: 'n' },
      ],
    });
    repl.handle(key('down'));
    repl.handle(key('enter'));
    await repl.idle();
    expect(sent).toEqual(['1', 'n']);
  });
});

describe('highlighted details in replies', () => {
  const tones = (l: Line) => l.map((s) => [s.text, s.tone]);

  it('marks amounts and addresses, ENS names, hashes and request ids, each in its own highlight', () => {
    const out = highlight([
      {
        text: 'Send 1 USDC to Soham (0x141A…ac78) on Arbitrum Sepolia, 0.001 ETH to alpha.iitr.eth and $5 back. req_0632d4584c2f',
        tone: 0,
      },
    ]);
    expect(tones(out)).toEqual([
      ['Send ', 0],
      ['1 USDC', 8],
      [' to Soham (', 0],
      ['0x141A…ac78', 7],
      [') on Arbitrum Sepolia, ', 0],
      ['0.001 ETH', 8],
      [' to ', 0],
      ['alpha.iitr.eth', 7],
      [' and ', 0],
      ['$5', 8],
      [' back. ', 0],
      ['req_0632d4584c2f', 7],
    ]);
  });

  it('keeps links whole, and leaves accent and status text alone', () => {
    const url = `https://sepolia.basescan.org/tx/0x${'ab'.repeat(32)}`;
    expect(tones(highlight([{ text: `View ${url}`, tone: 1 }]))).toEqual([[`View ${url}`, 1]]);
    expect(tones(highlight([{ text: '1 USDC', tone: 2 }]))).toEqual([['1 USDC', 2]]);
    expect(tones(highlight([{ text: 'Spent today: 2 of 300 USDC.', tone: 1 }]))).toEqual([
      ['Spent today: 2 of ', 1],
      ['300 USDC', 8],
      ['.', 1],
    ]);
  });

  it('paints highlights in colour on a pale mint background, which stops at their edges', () => {
    const s = paintRow(
      [
        { text: 'to ', ink: 'fg' },
        { text: '1 USDC', ink: 'amount' },
        { text: ' and ', ink: 'fg' },
        { text: 'bob.eth', ink: 'detail' },
      ],
      30,
      SCENE_PALETTE,
      'truecolor',
    );
    expect(s).toContain('\u001b[48;2;230;255;224m\u001b[38;2;176;36;90m1 USDC'); // mint, crimson
    expect(s).toContain('\u001b[48;2;230;255;224m\u001b[38;2;27;94;140mbob.eth'); // mint, blue
    expect(s).not.toContain('\u001b[1m');
    // back on the page background between them
    expect(s.indexOf('\u001b[48;2;11;12;10m', s.indexOf('1 USDC'))).toBeLessThan(s.indexOf(' and '));
  });

  it('replies show highlighted; your own message on the bar does not', () => {
    const repl = new Repl({ onMessage: async () => [[{ text: 'Send 1 USDC to bob.eth', tone: 0 }]] });
    type(repl, 'send 1 usdc to bob.eth');
    repl.handle(key('enter'));
    return repl.idle().then(() => {
      const rows = repl.rows(80);
      const mine = rows.find((r) => r.some((s) => s.text.includes('send 1 usdc')))!;
      expect(mine.every((s) => s.tone === 3)).toBe(true);
      const reply = rows.find((r) => r[0]?.text === '● ')!;
      expect(reply.map((s) => [s.text, s.tone])).toEqual([
        ['● ', 0],
        ['Send ', 0],
        ['1 USDC', 8],
        [' to ', 0],
        ['bob.eth', 7],
      ]);
    });
  });
});
