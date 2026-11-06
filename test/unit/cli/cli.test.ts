import { describe, expect, it } from 'vitest';
import { frameLines } from '../../../src/cli/render/frame.js';
import { place } from '../../../src/cli/render/layout.js';
import { paintRow, SPLASH_PALETTE, to256 } from '../../../src/cli/render/paint.js';
import { renderScene, SCENE_COLS, SCENE_ROWS } from '../../../src/cli/render/scene.js';
import { SplashAnimation, SPLASH_COLS, SPLASH_ROWS } from '../../../src/cli/render/splash.js';
import { detectColorMode, parseInput, renderStatic } from '../../../src/cli/terminal.js';
import { parseCliArgs, UsageError } from '../../../src/cli/main.js';

const ESC = '\u001b';

describe('splash renderer', () => {
  it('settles into the wordmark, tagline, status rows and prompt', () => {
    const anim = new SplashAnimation();
    anim.frame(0);
    const lines = frameLines(anim.frame(6000));
    expect(lines).toHaveLength(SPLASH_ROWS);
    expect(lines.every((l) => l.length === SPLASH_COLS)).toBe(true);
    const all = lines.join('\n');
    expect(all).toContain('██████████');
    expect(lines[11]).toContain('the access layer between AI and ethereum');
    expect(lines[15]).toContain('> ai model   connected');
    expect(lines[17]).toContain('> ethereum   block #21,004,203');
    expect(lines[19]).toContain('> layer      idle');
    expect(lines[21]).toContain('flex $ █');
  });

  it('shows nothing of the text before the reveal starts', () => {
    const lines = frameLines(new SplashAnimation().frame(0));
    expect(lines.slice(0, 13).join('').slice(36)).not.toMatch(/[a-z]{3}/);
    expect(lines[21]).not.toContain('flex $');
  });

  it('reports steering once the pointer has been over it', () => {
    const anim = new SplashAnimation({ shape: 'diamond' });
    const on = { x: 0.5, y: 0.2, on: true };
    let lines: string[] = [];
    for (let now = 0; now <= 6000; now += 33) lines = frameLines(anim.frame(now, on));
    expect(anim.steering).toBe(true);
    expect(lines[19]).toContain('> layer      steering');
  });

  it('uses caller-supplied status values', () => {
    const anim = new SplashAnimation({ status: () => ({ aiModel: 'qwen3:8b', ethereum: 'block #7' }) });
    anim.frame(0);
    const lines = frameLines(anim.frame(6000));
    expect(lines[15]).toContain('qwen3:8b');
    expect(lines[17]).toContain('block #7');
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

describe('painting and layout', () => {
  it('maps colours to the xterm-256 palette', () => {
    expect(to256('#000000')).toBe(16);
    expect(to256('#ffffff')).toBe(231);
    expect(to256('#e1ad66')).toBe(16 + 36 * 4 + 6 * 3 + 1);
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
    expect(out).toContain('80 × 24');
  });

  it('frames the splash with chrome when it fits and bare when it only just fits', () => {
    expect(place('splash', 120, 40)).toMatchObject({ chrome: true, hint: true, width: 84, height: 28 });
    expect(place('splash', 80, 24)).toMatchObject({ chrome: false, hint: false, left: 1, top: 1 });
    expect(place('splash', 79, 24)).toBeNull();
    expect(place('scene', 124, 42)).toMatchObject({ chrome: true, hint: false });
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
  it('defaults to the cube splash', () => {
    expect(parseCliArgs([])).toMatchObject({ view: 'splash', shape: 'cube', speed: 1, starfield: true, help: false });
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
