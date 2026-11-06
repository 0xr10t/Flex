import { describe, expect, it } from 'vitest';
import { frameLines } from '../../../src/cli/render/frame.js';
import { paintRow, SPLASH_PALETTE, to256 } from '../../../src/cli/render/paint.js';
import { renderScene, renderSceneLayer, SCENE_COLS, SCENE_ROWS } from '../../../src/cli/render/scene.js';
import { stageLayout } from '../../../src/cli/render/stage.js';
import { snap, SNAP_SECONDS } from '../../../src/cli/render/snap.js';
import { SplashAnimation, SPLASH_COLS, SPLASH_ROWS } from '../../../src/cli/render/splash.js';
import { composeOpening, detectColorMode, parseInput, renderStatic } from '../../../src/cli/terminal.js';
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

describe('opening', () => {
  const still = { x: 0, y: 0, on: false };
  const at = (phase: 'intro' | 'snap' | 'splash', snapS = 0): string[] => {
    const layout = stageLayout(160, 50)!;
    const anim = new SplashAnimation();
    anim.frame(0);
    return frameLines(composeOpening(layout, phase, 6, snapS, anim, 6000, still, false));
  };

  it('opens on the whole scene centred in the terminal', () => {
    const lines = at('intro');
    expect(lines).toHaveLength(50);
    expect(lines[5 + 10]).toContain('THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM');
    expect(lines[5 + 17]!.indexOf('+- FLEX GATEWAY')).toBe(20 + 50);
    expect(lines[5 + 35]).toContain('[ AI MODEL ]');
  });

  it('keeps the title and footer while the objects turn to dust', () => {
    const all = at('snap', SNAP_SECONDS + 0.01).join('\n');
    expect(all).toContain('THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM');
    expect(all).toContain('flex.access');
    expect(all).not.toMatch(/FLEX GATEWAY|\[ AI MODEL \]|\[ ETHEREUM \]/);
  });

  it('brings the splash up under the title', () => {
    const lines = at('splash');
    expect(lines[5 + 10]).toContain('THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM');
    const tag = lines.findIndex((l) => l.includes('the access layer between AI and ethereum'));
    expect(tag).toBeGreaterThan(5 + 10);
    expect(lines.findIndex((l) => l.includes('flex $ █'))).toBe(tag + 4);
    expect(lines[5 + 38]).toContain('flex.access');
  });

  it('keeps the stars in the background', () => {
    const layout = stageLayout(160, 50)!;
    const anim = new SplashAnimation();
    const f = composeOpening(layout, 'splash', 6, 0, anim, 0, still, true);
    expect(f.ch.filter((c, i) => (c === '.' || c === '+') && f.tone[i] === 1).length).toBeGreaterThan(100);
  });
});

describe('stage layout', () => {
  it('centres the opening scene when it fits', () => {
    expect(stageLayout(120, 40)).toMatchObject({ scene: { x: 0, y: 0 }, title: { x: 0, y: 0 } });
    expect(stageLayout(200, 60)).toMatchObject({ scene: { x: 40, y: 10 } });
  });

  it('keeps the title without the scene on a mid-sized terminal', () => {
    const l = stageLayout(100, 32)!;
    expect(l.scene).toBeNull();
    expect(l.title).not.toBeNull();
    expect(l.footer).not.toBeNull();
    expect(l.splash.objectX).not.toBeNull();
  });

  it('shows the splash alone, then without its logo, as the terminal shrinks', () => {
    const l = stageLayout(80, 24)!;
    expect(l.title).toBeNull();
    expect(l.splash.objectX).toBeNull();
    expect(stageLayout(95, 20)!.splash.objectX).not.toBeNull();
    expect(stageLayout(95, 16)!.splash.objectX).toBeNull();
    expect(stageLayout(55, 20)).toBeNull();
    expect(stageLayout(60, 13)).toBeNull();
  });

  it('lays out the splash alone when asked', () => {
    expect(stageLayout(200, 60, false)).toMatchObject({ scene: null, title: null, footer: null });
  });
});

describe('painting', () => {
  it('maps colours to the xterm-256 palette', () => {
    expect(to256('#000000')).toBe(16);
    expect(to256('#ffffff')).toBe(231);
    expect(to256('#e1ad66')).toBe(16 + 36 * 4 + 6 * 3 + 1);
  });

  it('paints truecolor rows on the background and resets after', () => {
    const s = paintRow([{ text: 'flex', ink: 'accent' }], 6, SPLASH_PALETTE, 'truecolor');
    expect(s.startsWith(`${ESC}[48;2;27;25;24m${ESC}[38;2;225;173;102mflex`)).toBe(true);
    expect(s.endsWith(`  ${ESC}[0m`)).toBe(true);
  });

  it('prints plain text without colour', () => {
    const out = renderStatic({ view: 'opening', colorMode: 'none' });
    expect(out).not.toContain(ESC);
    expect(out).toContain('THE ACCESS LAYER BETWEEN AI MODELS AND ETHEREUM');
    expect(out).toContain('flex $');
    expect(out.split('\n')).toHaveLength(SCENE_ROWS + 1);
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
    expect(parseInput(`${ESC}[A`)).toEqual([]);
    expect(parseInput(' ')).toEqual([{ kind: 'key', key: 'other' }]);
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
