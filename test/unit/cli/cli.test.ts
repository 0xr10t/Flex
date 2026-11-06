import { describe, expect, it } from 'vitest';
import { frameLines } from '../../../src/cli/render/frame.js';
import { paintRow, SCENE_PALETTE, SPLASH_PALETTE, to256 } from '../../../src/cli/render/paint.js';
import { renderScene, renderSceneLayer, SCENE_COLS, SCENE_ROWS } from '../../../src/cli/render/scene.js';
import { stageLayout } from '../../../src/cli/render/stage.js';
import { snap, SNAP_SECONDS } from '../../../src/cli/render/snap.js';
import { SplashAnimation, SPLASH_COLS, SPLASH_ROWS } from '../../../src/cli/render/splash.js';
import { composeOpening, detectColorMode, renderStatic, type Phase } from '../../../src/cli/terminal.js';
import { parseInput, type KeyEvent } from '../../../src/cli/input.js';
import { Repl } from '../../../src/cli/repl.js';
import { parseCliArgs, UsageError } from '../../../src/cli/main.js';

const ESC = '\u001b';

describe('splash renderer', () => {
  it('settles into the FLEXX wordmark, tagline, rule and prompt beside the logo', () => {
    const anim = new SplashAnimation();
    anim.frame(0);
    const lines = frameLines(anim.frame(6000));
    expect(lines).toHaveLength(SPLASH_ROWS);
    expect(lines.every((l) => l.length === SPLASH_COLS)).toBe(true);
    // F, L, E, X, X: the top row of each letter
    expect(lines[5]!.slice(38)).toMatch(/^██████████ ██ {9}██████████ ██ {6}██ ██ {6}██ *$/);
    expect(lines[13]).toContain('the access layer between AI and ethereum');
    expect(lines[15]!.slice(38, 92)).toBe('─'.repeat(54));
    expect(lines[17]).toContain('flex $ █');
    // the logo sits left of the text
    expect(lines[11]!.slice(0, 36)).toMatch(/[#+=:-]/);
  });

  it('no longer shows the status rows', () => {
    const anim = new SplashAnimation();
    anim.frame(0);
    const all = frameLines(anim.frame(9000)).join('\n');
    expect(all).not.toMatch(/ai model|> ethereum|> layer|connected|block #/);
  });

  it('centres the logo and text as one group', () => {
    const anim = new SplashAnimation();
    anim.frame(0);
    const lines = frameLines(anim.frame(6000));
    const used = lines.filter((l) => l.trim() !== '');
    const left = Math.min(...used.map((l) => l.search(/\S/)));
    const right = Math.max(...used.map((l) => l.trimEnd().length));
    expect(Math.abs(left - (SPLASH_COLS - right))).toBeLessThanOrEqual(4);
    const rows = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    expect(Math.abs(rows[0]! - (SPLASH_ROWS - 1 - rows.at(-1)!))).toBeLessThanOrEqual(2);
  });

  it('shows none of the text before the reveal starts', () => {
    const lines = frameLines(new SplashAnimation().frame(0));
    expect(lines.join('')).not.toContain('█');
    expect(lines[17]).not.toContain('flex $');
  });

  it('eases into steering while the pointer is over it', () => {
    const anim = new SplashAnimation({ shape: 'diamond' });
    for (let now = 0; now <= 3000; now += 33) anim.frame(now, { x: 0.5, y: 0.2, on: true });
    expect(anim.steering).toBe(true);
  });
});

describe('scene renderer', () => {
  it('draws the gateway, labels and footer', () => {
    const lines = frameLines(renderScene(6, { starfield: false }));
    expect(lines).toHaveLength(SCENE_ROWS);
    expect(lines.every((l) => l.length === SCENE_COLS)).toBe(true);
    expect(lines[10]).toContain('THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM');
    expect(lines[17]).toContain('+- FLEX GATEWAY ----+');
    expect(lines[35]).toContain('[ AI MODEL ]');
    expect(lines[35]).toContain('[ ETHEREUM ]');
    expect(lines[38]).toContain('block #21,004,204');
  });

  it('is a pure function of time', () => {
    expect(frameLines(renderScene(3.3))).toEqual(frameLines(renderScene(3.3)));
  });
});

describe('snap', () => {
  const objects = renderSceneLayer(5.5, 'objects');
  const glyphs = (f: { ch: string[] }): number => f.ch.filter((c) => c !== ' ').length;

  it('starts from the objects exactly as they stood', () => {
    const f = snap(objects, 0);
    expect(f.ch).toEqual(objects.ch);
    expect(f.written).toEqual(objects.written);
  });

  it('takes the right side first', () => {
    const f = snap(objects, 0.9);
    const share = (left: boolean): number => {
      let total = 0;
      let kept = 0;
      for (let i = 0; i < f.ch.length; i++) {
        if (objects.ch[i] === ' ' || i % f.cols < f.cols / 2 !== left) continue;
        total++;
        if (f.ch[i] === objects.ch[i]) kept++;
      }
      return kept / total;
    };
    expect(share(true)).toBeGreaterThan(share(false));
  });

  it('turns cells into drifting dust', () => {
    const f = snap(objects, 1.2);
    expect(f.ch.some((c, i) => '%#*+=-:.'.includes(c) && !objects.written[i])).toBe(true);
  });

  it('leaves nothing once it is over', () => {
    const f = snap(objects, SNAP_SECONDS + 0.01);
    expect(glyphs(f)).toBe(0);
    expect(f.written.every((w) => w === 0)).toBe(true);
  });
});

const still = { x: 0, y: 0, on: false };

describe('opening', () => {
  // 160 × 50: the 38-row opening starts on row 6, FLEXX on row 7, the objects' first row (scene row 14) on row 19
  const top = 6;
  const sceneY = top + 13 - 14;
  const at = (phase: Phase, opts: { snapS?: number; shrinkP?: number; repl?: Repl } = {}): string[] => {
    const layout = stageLayout(160, 50)!;
    const header = new SplashAnimation();
    header.frame(0);
    const pointer = { x: 0, y: 0, on: false };
    const state = {
      phase,
      sceneT: 6,
      snapS: opts.snapS ?? 0,
      shrinkP: opts.shrinkP ?? 0,
      nowMs: 6000,
      pointer,
      starfield: false,
    };
    return frameLines(composeOpening(layout, state, header, opts.repl ?? new Repl())).map((l) => l.trimEnd());
  };
  const header = (lines: string[]): string[] => lines.slice(top, top + 12);

  it('opens with FLEXX alone, no cube, above the globe, gateway and diamond', () => {
    const lines = at('intro');
    expect(lines).toHaveLength(50);
    const wx = Math.floor((160 - 54) / 2);
    expect(lines[top + 1]!.slice(wx)).toMatch(/^██████████ ██ {9}██████████ ██ {6}██ ██ {6}██$/);
    expect(lines[top + 1]!.slice(0, wx).trim()).toBe('');
    expect(lines[top + 9]).toContain('the access layer between AI and ethereum');
    expect(lines.slice(0, top + 12).join('\n')).not.toMatch(/[#+=:-]{3}/);
    expect(lines[sceneY + 17]!.indexOf('+- FLEX GATEWAY')).toBe(20 + 50);
    expect(lines[sceneY + 35]).toContain('[ AI MODEL ]');
    expect(lines[sceneY + 38]).toContain('flex.access');
  });

  it('turns only the globe, gateway and diamond to dust', () => {
    const lines = at('snap', { snapS: SNAP_SECONDS + 0.01 });
    expect(header(lines)).toEqual(header(at('intro')));
    expect(lines.join('\n')).not.toMatch(/FLEX GATEWAY|\[ AI MODEL \]|\[ ETHEREUM \]/);
    expect(lines.join('\n')).toContain('flex.access');
  });

  it('shrinks FLEXX into the bar while the small cube grows in', () => {
    expect(at('shrink', { shrinkP: 0.3 }).slice(0, 8).join('')).not.toMatch(/[#+]/);
    const late = at('shrink', { shrinkP: 0.8 });
    expect(late.join('\n')).toMatch(/[▀▄]/);
    expect(late.slice(0, 8).some((l) => /[#+]/.test(l.slice(0, 16)))).toBe(true);
    expect(late.join('\n')).not.toContain('╭');
  });

  it('ends with the small cube and FLEXX sitting on the top edge of the box, the input under it', () => {
    const lines = at('box');
    // the top edge runs into the logo's left side and out of its right, with no title
    expect(lines[3]!.slice(0, 3)).toBe(' ╭─');
    expect(lines[3]!.slice(49)).toMatch(/^─+╮$/);
    expect(lines[3]).not.toContain('flex');
    // the small cube on the left of the edge, FLEXX from column 18 straddling it, the tagline inside under FLEXX
    expect(lines.slice(0, 7).some((l) => /[#+]/.test(l.slice(2, 17)))).toBe(true);
    expect(lines[1]!.slice(18, 47)).toBe('█▀▀▀▀ █     █▀▀▀▀ █   █ █   █');
    expect(lines[6]!.slice(18)).toMatch(/^the access layer between AI and ethereum +│$/);
    // the conversation under the logo, then the box's bottom, then the input between its rules
    expect(lines[8]).toMatch(/^ │ type help to see the commands +│$/);
    expect(lines[44]).toMatch(/^ ╰─+╯$/);
    expect(lines[46]).toMatch(/^ ─+$/);
    expect(lines[47]).toMatch(/^ {2}❯ █ry "help"$/);
    expect(lines[48]).toMatch(/^ ─+$/);
    expect(lines[49]).toContain('flex.access');
  });

  it('marks your messages and the replies like the Claude CLI', () => {
    const repl = new Repl();
    for (const c of 'help') repl.handle({ kind: 'key', key: 'char', char: c });
    repl.handle({ kind: 'key', key: 'enter' });
    for (const c of 'pay') repl.handle({ kind: 'key', key: 'char', char: c });
    const layout = stageLayout(160, 50)!;
    const header = new SplashAnimation();
    const state = {
      phase: 'box' as const,
      sceneT: 6,
      snapS: 0,
      shrinkP: 1,
      nowMs: 6000,
      pointer: still,
      starfield: false,
    };
    const f = composeOpening(layout, state, header, repl);
    const lines = frameLines(f).map((l) => l.trimEnd());
    expect(lines[10]!.slice(3)).toMatch(/^❯ help +│$/);
    // the whole conversation width of your message is on the bar
    for (let x = 3; x < 3 + 154; x++) expect(f.tone[10 * 160 + x]).toBe(3);
    expect(f.tone[10 * 160 + 2]).not.toBe(3);
    expect(lines[12]!.slice(3)).toMatch(/^● help +list the commands/);
    expect(lines[13]!.slice(3)).toMatch(/^ {2}clear +clear the conversation/);
    expect(lines[14]!.slice(3)).toMatch(/^ {2}exit +leave flexx/);
    expect(lines[47]).toMatch(/^ {2}❯ pay█ *$/);
  });
});

describe('stage layout', () => {
  it('centres the full opening when it fits', () => {
    expect(stageLayout(120, 38)).toMatchObject({
      scene: { x: 0, y: -1 },
      final: {
        frame: { x: 1, y: 3, w: 118, h: 30 },
        gap: { from: 3, to: 48 },
        conversation: { x: 3, y: 8, w: 114, h: 24 },
        input: { x: 1, y: 35, w: 118 },
      },
    });
    expect(stageLayout(200, 60)).toMatchObject({ scene: { x: 40, y: 10 } });
  });

  it('plays FLEXX alone below 120 × 38, then the same box', () => {
    const l = stageLayout(100, 30)!;
    expect(l.scene).toBeNull();
    expect(l.footer).toBeNull();
    expect(l.header).toMatchObject({ objectX: null });
    expect(l.final.frame).toEqual({ x: 1, y: 3, w: 98, h: 22 });
    expect(l.final.footer).not.toBeNull();
    expect(l.final.logo?.tagline).not.toBeNull();
    expect(stageLayout(55, 30)!.final.logo).toMatchObject({ tagline: null });
  });

  it('leaves the logo out when the box is too small for it', () => {
    const bare = stageLayout(60, 14)!;
    expect(bare.header).toBeNull();
    expect(bare.final).toMatchObject({
      logo: null,
      gap: null,
      frame: { y: 0 },
      conversation: { y: 1 },
      input: { y: 12 },
    });
    expect(stageLayout(41, 20)).toBeNull();
    expect(stageLayout(60, 8)).toBeNull();
  });
});

describe('command box', () => {
  const type = (repl: Repl, s: string): void => {
    for (const ev of parseInput(s)) if (ev.kind === 'key') repl.handle(ev as KeyEvent);
  };
  const said = (repl: Repl): string[] =>
    repl.rows(80).map((l) =>
      l
        .map((s) => s.text)
        .join('')
        .trimEnd(),
    );

  it('runs help, marking the message and the reply', () => {
    const repl = new Repl();
    type(repl, 'help\r');
    expect(repl.conversation.at(-2)).toEqual({ kind: 'user', text: 'help' });
    expect(said(repl)).toContain('❯ help');
    expect(said(repl).some((l) => /^● help +list the commands$/.test(l))).toBe(true);
    expect(said(repl).some((l) => /^ {2}clear +clear the conversation$/.test(l))).toBe(true);
  });

  it('reports unknown commands', () => {
    const repl = new Repl();
    type(repl, 'pay 5 usdc\r');
    expect(said(repl).slice(-3)).toEqual(['❯ pay 5 usdc', '', '● unknown command: pay · type help']);
  });

  it('wraps long lines under their mark', () => {
    const repl = new Repl();
    type(repl, 'abcdefghij klmnop\r');
    const rows = repl.rows(10);
    const at = rows.findIndex((r) => r[0]?.text === '❯ ');
    expect(rows.slice(at, at + 3)).toEqual([
      [
        { text: '❯ ', tone: 3 },
        { text: 'abcdefgh', tone: 3 },
      ],
      [
        { text: '  ', tone: 3 },
        { text: 'ij klmno', tone: 3 },
      ],
      [
        { text: '  ', tone: 3 },
        { text: 'p', tone: 3 },
        { text: '       ', tone: 3 },
      ],
    ]);
  });

  it('edits the line with the cursor keys', () => {
    const repl = new Repl();
    type(repl, `hlp${ESC}[D${ESC}[De${ESC}[F!`);
    expect(repl.input).toBe('help!');
    type(repl, '\u007f');
    expect(repl.input).toBe('help');
    type(repl, `${ESC}[H${ESC}[3~`);
    expect(repl.input).toBe('elp');
  });

  it('recalls earlier lines with Up and Down', () => {
    const repl = new Repl();
    type(repl, 'one\rtwo\rdraft');
    type(repl, `${ESC}[A`);
    expect(repl.input).toBe('two');
    type(repl, `${ESC}[A${ESC}[A`);
    expect(repl.input).toBe('one');
    type(repl, `${ESC}[B${ESC}[B`);
    expect(repl.input).toBe('draft');
  });

  it('clears, and leaves on exit or Ctrl-C on an empty line', () => {
    const repl = new Repl();
    type(repl, 'help\rclear\r');
    expect(repl.conversation).toHaveLength(0);
    expect(repl.handle({ kind: 'key', key: 'interrupt' })).toBe('quit');
    type(repl, 'abc');
    expect(repl.handle({ kind: 'key', key: 'interrupt' })).toBeUndefined();
    expect(repl.input).toBe('');
    type(repl, 'exit');
    expect(repl.handle({ kind: 'key', key: 'enter' })).toBe('quit');
  });
});

describe('painting', () => {
  it('maps colours to the xterm-256 palette', () => {
    expect(to256('#000000')).toBe(16);
    expect(to256('#ffffff')).toBe(231);
    expect(to256('#e1ad66')).toBe(16 + 36 * 4 + 6 * 3 + 1);
  });

  it('paints a marked bar on its own background and returns to the page after it', () => {
    const s = paintRow(
      [
        { text: 'a', ink: 'fg' },
        { text: '❯ hi ', ink: 'mark' },
        { text: 'b', ink: 'fg' },
      ],
      7,
      SCENE_PALETTE,
      'truecolor',
    );
    expect(s).toContain(
      `a${ESC}[48;2;232;230;223m${ESC}[38;2;11;12;10m❯ hi ${ESC}[48;2;11;12;10m${ESC}[38;2;217;214;204mb`,
    );
  });

  it('paints truecolor rows on the background and resets after', () => {
    const s = paintRow([{ text: 'flex', ink: 'accent' }], 6, SPLASH_PALETTE, 'truecolor');
    expect(s.startsWith(`${ESC}[48;2;27;25;24m${ESC}[38;2;225;173;102mflex`)).toBe(true);
    expect(s.endsWith(`  ${ESC}[0m`)).toBe(true);
  });

  it('prints plain text without colour', () => {
    const out = renderStatic({ view: 'opening', colorMode: 'none' });
    expect(out).not.toContain(ESC);
    expect(out).toContain('the access layer between AI');
    expect(out).toContain('❯ █ry "help"');
    expect(out).toContain('flex.access');
    expect(out.split('\n')).toHaveLength(43 + 1);
  });
});

describe('terminal input', () => {
  it('parses SGR mouse reports, editing keys and characters', () => {
    expect(parseInput(`${ESC}[<35;12;7M${ESC}[<35;13;8mq`)).toEqual([
      { kind: 'mouse', col: 12, row: 7 },
      { kind: 'mouse', col: 13, row: 8 },
      { kind: 'key', key: 'char', char: 'q' },
    ]);
    expect(parseInput('\r\n')).toEqual([{ kind: 'key', key: 'enter' }]);
    expect(parseInput('\u0003\u0004\u000c\u007f')).toEqual([
      { kind: 'key', key: 'interrupt' },
      { kind: 'key', key: 'eof' },
      { kind: 'key', key: 'clear' },
      { kind: 'key', key: 'backspace' },
    ]);
    expect(parseInput(ESC)).toEqual([{ kind: 'key', key: 'escape' }]);
    expect(parseInput(`${ESC}[A${ESC}[1;5C${ESC}OH${ESC}[4~${ESC}[3~`)).toEqual([
      { kind: 'key', key: 'up' },
      { kind: 'key', key: 'right' },
      { kind: 'key', key: 'home' },
      { kind: 'key', key: 'end' },
      { kind: 'key', key: 'delete' },
    ]);
    expect(parseInput(`${ESC}[I`)).toEqual([]);
    expect(parseInput('é✓')).toEqual([
      { kind: 'key', key: 'char', char: 'é' },
      { kind: 'key', key: 'char', char: '✓' },
    ]);
  });

  it('picks the colour mode from the environment', () => {
    const tty = { isTTY: true, getColorDepth: () => 8 };
    expect(detectColorMode(tty, { NO_COLOR: '1', COLORTERM: 'truecolor' })).toBe('none');
    expect(detectColorMode(tty, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(detectColorMode(tty, {})).toBe('256');
    expect(detectColorMode({ isTTY: false }, {})).toBe('none');
  });
});

describe('arguments', () => {
  it('defaults to the opening with the cube splash', () => {
    expect(parseCliArgs([])).toMatchObject({ view: 'opening', shape: 'cube', speed: 1, starfield: true, help: false });
    expect(parseCliArgs(['splash'])).toMatchObject({ view: 'splash' });
    expect(parseCliArgs(['scene'])).toMatchObject({ view: 'scene' });
  });

  it('accepts the design options', () => {
    expect(
      parseCliArgs(['scene', '--speed', '2.5', '--accent', '#7fd1b9', '--no-starfield', '--static']),
    ).toMatchObject({ view: 'scene', speed: 2.5, accent: '#7fd1b9', starfield: false, staticFrame: true });
  });

  it('rejects values outside the design ranges', () => {
    expect(() => parseCliArgs(['--speed', '5'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--shape', 'sphere'])).toThrow(UsageError);
    expect(() => parseCliArgs(['--accent', 'gold'])).toThrow(UsageError);
    expect(() => parseCliArgs(['pay'])).toThrow(UsageError);
  });
});
