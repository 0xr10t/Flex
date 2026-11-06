import { describe, expect, it } from 'vitest';
import { frameLines } from '../../../src/cli/render/frame.js';
import { place } from '../../../src/cli/render/layout.js';
import { paintRow, SPLASH_PALETTE, to256 } from '../../../src/cli/render/paint.js';
import { renderScene, SCENE_COLS, SCENE_ROWS } from '../../../src/cli/render/scene.js';
import { snap, SNAP_SECONDS } from '../../../src/cli/render/snap.js';
import { SplashAnimation, SPLASH_COLS, SPLASH_ROWS } from '../../../src/cli/render/splash.js';
import { detectColorMode, parseInput, renderStatic } from '../../../src/cli/terminal.js';
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
  const scene = renderScene(5.5, { starfield: false });
  const glyphs = (f: { ch: string[] }): number => f.ch.filter((c) => c !== ' ').length;

  it('starts from the scene exactly as it stood', () => {
    const f = snap(scene, 0);
    expect(f.ch).toEqual(scene.ch);
    expect(f.clear!.every((c) => c === 0)).toBe(true);
  });

  it('takes the right side first', () => {
    const f = snap(scene, 0.9);
    const standing = (from: number, to: number): number => {
      let n = 0;
      for (let y = 0; y < f.rows; y++)
        for (let x = from; x < to; x++)
          if (scene.ch[y * f.cols + x] !== ' ' && f.ch[y * f.cols + x] === scene.ch[y * f.cols + x]) n++;
      return n;
    };
    const half = f.cols / 2;
    const left =
      standing(0, half) / Math.max(1, scene.ch.slice(0).filter((c, i) => c !== ' ' && i % f.cols < half).length);
    const right =
      standing(half, f.cols) / Math.max(1, scene.ch.filter((c, i) => c !== ' ' && i % f.cols >= half).length);
    expect(left).toBeGreaterThan(right);
  });

  it('turns cells into drifting dust and flakes the backdrop away', () => {
    const f = snap(scene, 1.2);
    expect(f.ch.some((c, i) => '%#*+=-:.'.includes(c) && scene.ch[i] === ' ')).toBe(true);
    const cleared = f.clear!.reduce((n, c) => n + c, 0);
    expect(cleared).toBeGreaterThan(0);
    expect(cleared).toBeLessThan(f.clear!.length);
  });

  it('leaves nothing once it is over', () => {
    const f = snap(scene, SNAP_SECONDS + 0.01);
    expect(glyphs(f)).toBe(0);
    expect(f.clear!.every((c) => c === 1)).toBe(true);
  });
});

describe('painting and layout', () => {
  it('maps colours to the xterm-256 palette', () => {
    expect(to256('#000000')).toBe(16);
    expect(to256('#ffffff')).toBe(231);
    expect(to256('#e1ad66')).toBe(16 + 36 * 4 + 6 * 3 + 1);
  });

  it('drops the panel background for cleared cells', () => {
    const s = paintRow(
      [
        { text: 'a', ink: 'fg' },
        { text: '  ', ink: 'fg', clear: true },
        { text: 'b', ink: 'fg' },
      ],
      4,
      SPLASH_PALETTE,
      'truecolor',
    );
    expect(s).toContain(`a${ESC}[49m  ${ESC}[48;2;27;25;24mb`);
  });

  it('paints truecolor rows with the panel background and resets after', () => {
    const s = paintRow([{ text: 'flex', ink: 'accent' }], 6, SPLASH_PALETTE, 'truecolor');
    expect(s.startsWith(`${ESC}[48;2;27;25;24m${ESC}[38;2;225;173;102mflex`)).toBe(true);
    expect(s.endsWith(`  ${ESC}[0m`)).toBe(true);
  });

  it('prints plain text without colour', () => {
    const out = renderStatic({ view: 'splash', colorMode: 'none' });
    expect(out).not.toContain(ESC);
    expect(out).toContain('flex — splash');
    expect(out).toContain('96 × 24');
    expect(out).not.toMatch(/terminal splash|steer the layer/);
  });

  it('frames the splash with chrome when it fits and bare when it only just fits', () => {
    expect(place('splash', 120, 40)).toMatchObject({ chrome: true, width: 100, height: 28, left: 11, top: 7 });
    expect(place('splash', 96, 24)).toMatchObject({ chrome: false, left: 1, top: 1 });
    expect(place('splash', 95, 24)).toBeNull();
    expect(place('scene', 124, 42)).toMatchObject({ chrome: true });
    expect(place('scene', 100, 50)).toBeNull();
  });
});

describe('terminal input', () => {
  it('parses SGR mouse reports and keys', () => {
    expect(parseInput(`${ESC}[<35;12;7M${ESC}[<35;13;8mq`)).toEqual([
      { kind: 'mouse', col: 12, row: 7 },
      { kind: 'mouse', col: 13, row: 8 },
      { kind: 'key', key: 'quit' },
    ]);
    expect(parseInput('\r')).toEqual([{ kind: 'key', key: 'enter' }]);
    expect(parseInput('\u0003')).toEqual([{ kind: 'key', key: 'interrupt' }]);
    expect(parseInput(ESC)).toEqual([{ kind: 'key', key: 'quit' }]);
    expect(parseInput(`${ESC}[A`)).toEqual([{ kind: 'key', key: 'other' }]);
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
  it('defaults to the opening, then the cube splash', () => {
    expect(parseCliArgs([])).toMatchObject({
      view: 'splash',
      intro: true,
      shape: 'cube',
      speed: 1,
      starfield: true,
      help: false,
    });
    expect(parseCliArgs(['splash'])).toMatchObject({ view: 'splash', intro: false });
    expect(parseCliArgs(['scene'])).toMatchObject({ view: 'scene', intro: false });
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
