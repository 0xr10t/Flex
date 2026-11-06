// The conversation: what you type and what comes back, styled like the Claude CLI. Your messages show as `❯ message`
// on a light bar across the width, replies as `● reply` with their further lines indented under it, a blank line
// between exchanges, and `✻ Working…` while a reply is on its way.
//
// The input line sits apart, between two rules, with a `❯` prompt, a dim hint while it is empty and a row of key hints
// on the rule below. Typing `/` opens the command palette (filtered as you type; ↑↓ to choose, Tab to complete, Enter
// to run, Esc to close); `?` on an empty line shows the shortcuts. It edits like a shell line: cursor keys, Home/End
// and Ctrl-A/E, Backspace/Delete, Ctrl-U/K/W, history on ↑↓, bracketed paste, Esc to clear the line, Ctrl-L to clear
// the conversation, Ctrl-C twice (or Ctrl-D twice) to leave. Page Up/Down and the mouse wheel scroll back through the
// conversation. A line starting with `/` runs a command from the table; anything else goes to `onMessage` (the agent).

import { put, text, type Frame, type Rect, type Tone } from './render/frame.js';
import type { KeyEvent } from './input.js';

export interface Segment {
  text: string;
  tone: Tone;
}

/** One line of output, possibly in several tones. */
export type Line = Segment[];

export type CommandResult = Line[] | 'clear' | 'quit';

/** What a command can reach in the box besides its arguments. */
export interface CommandContext {
  commands: readonly Command[];
  /** The text of the latest reply, for /copy. */
  lastReply: string | undefined;
}

export interface Command {
  /** Typed as `/name`. */
  name: string;
  summary: string;
  /** Its arguments, shown as a hint in the palette and while typing them, e.g. `<name> <value>`. */
  args?: string;
  /** Other names it answers to, e.g. `quit` for `exit`. */
  aliases?: string[];
  run(args: string[], ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

/** One turn of the conversation. */
export type Entry = { kind: 'user'; text: string } | { kind: 'reply'; lines: Line[] } | { kind: 'note'; line: Line };

const t = (s: string, tone: Tone = 0): Segment => ({ text: s, tone });

/** The keys, as `/shortcuts` and `?` list them. */
export const SHORTCUTS: ReadonlyArray<[string, string]> = [
  ['/', 'commands (↑↓ choose · tab complete · enter run · esc close)'],
  ['?', 'these shortcuts'],
  ['↑ ↓', 'earlier lines you typed'],
  ['pgup pgdn · wheel', 'scroll the conversation'],
  ['ctrl-a ctrl-e', 'start / end of the line'],
  ['ctrl-u ctrl-k', 'delete to the start / end of the line'],
  ['ctrl-w', 'delete the previous word'],
  ['esc', 'clear the line'],
  ['ctrl-l', 'clear the conversation'],
  ['ctrl-c ctrl-c', 'leave flexx'],
];

function shortcutLines(): Line[] {
  const width = Math.max(...SHORTCUTS.map(([k]) => k.length)) + 3;
  return SHORTCUTS.map(([k, what]) => [t(k.padEnd(width), 2), t(what, 1)]);
}

export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    name: 'help',
    summary: 'list the commands',
    run: (_args, { commands }) => {
      const label = (c: Command) => `/${c.name}${c.args ? ` ${c.args}` : ''}`;
      const width = Math.max(...commands.map((c) => label(c).length)) + 3;
      return [
        [t('Type a request in your own words, e.g. send 10 usdc to aradhya on base. Or:')],
        ...commands.map((c) => [t(label(c).padEnd(width), 2), t(c.summary, 1)]),
        [t('Type ', 1), t('?', 2), t(' for keyboard shortcuts.', 1)],
      ];
    },
  },
  { name: 'shortcuts', summary: 'show the keyboard shortcuts', run: () => shortcutLines() },
  { name: 'clear', summary: 'clear the conversation', run: () => 'clear' },
  { name: 'exit', summary: 'leave flexx', aliases: ['quit'], run: () => 'quit' },
];

const WELCOME: Entry = {
  kind: 'note',
  line: [t('type a request, or ', 1), t('/', 2), t(' for commands and ', 1), t('?', 2), t(' for shortcuts', 1)],
};

const USER_MARK = '❯ ';
const REPLY_MARK = '● ';
const WORK_MARK = '✻ ';
/** The working line's spinner, as in the Claude CLI. */
const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const PLACEHOLDER = 'Try "send 10 usdc to aradhya on base"';
/** Typed without a slash, these still leave. */
const QUIT_WORDS = new Set(['exit', 'quit']);
/** How long a first Ctrl-C (or Ctrl-D) on an empty line waits for the second. */
const EXIT_WINDOW_MS = 2000;
/** Most palette rows shown at once. */
const MENU_ROWS = 8;
/** Rows one wheel notch scrolls. */
const WHEEL_ROWS = 3;

export interface ReplOptions {
  /** Commands typed as `/name`, after the built-in help, shortcuts, clear and exit. */
  commands?: readonly Command[];
  /** Where anything that isn't a command goes; without it such lines are unknown commands. */
  onMessage?: (text: string) => Promise<Line[]>;
  /** Called when an asynchronous command asks to leave. */
  onQuit?: () => void;
  /** The clock for the working line's timer and the Ctrl-C window (milliseconds). */
  now?: () => number;
}
/** Most entries kept. */
const SCROLLBACK = 300;

export class Repl {
  private entries: Entry[] = [WELCOME];
  /** The input line as code points, and the cursor's index into it. */
  private buffer: string[] = [];
  private cursor = 0;
  private readonly history: string[] = [];
  /** Index into `history` while recalling with Up/Down; `history.length` is the line being written. */
  private recall = 0;
  private draft: string[] = [];
  /** Set while a reply is on its way: when it started, for the `✻ Working…` timer. */
  private busySince: number | undefined;
  private readonly commands: readonly Command[];
  /** The palette's highlighted row, and whether Esc closed it for the current line. */
  private menuIndex = 0;
  private menuClosed = false;
  /** The shortcuts panel is open (from `?`). */
  private shortcutsOpen = false;
  /** Until when a second Ctrl-C (or Ctrl-D) leaves. */
  private exitArmedUntil = 0;
  /** Rows scrolled back from the newest, and the conversation's height at the last draw (one page). */
  private scroll = 0;
  private pageRows = 10;
  private pendingWork: Promise<void> | undefined;

  constructor(private readonly opts: ReplOptions = {}) {
    this.commands = [...BUILTIN_COMMANDS, ...(opts.commands ?? [])];
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** True while a reply is on its way; Enter waits until it has arrived. */
  get busy(): boolean {
    return this.busySince !== undefined;
  }

  /** Adds lines that arrived on their own (connection status and the like) as a reply. */
  notify(lines: Line[]): void {
    if (lines.length) this.push({ kind: 'reply', lines });
  }

  /** Resolves once no reply is on its way (for tests and shutdown). */
  idle(): Promise<void> {
    return this.pendingWork ?? Promise.resolve();
  }

  /** The current input line. */
  get input(): string {
    return this.buffer.join('');
  }

  /** The conversation so far, oldest first. */
  get conversation(): readonly Entry[] {
    return this.entries;
  }

  /** True while a first Ctrl-C (or Ctrl-D) waits for the second. */
  get exitArmed(): boolean {
    return this.now() < this.exitArmedUntil;
  }

  /** The commands the palette offers for the current line: those whose name (or an alias) matches what follows `/`. */
  get menu(): Command[] {
    if (this.menuClosed || this.buffer[0] !== '/' || /\s/.test(this.input)) return [];
    const typed = this.input.slice(1).toLowerCase();
    const names = (c: Command) => [c.name, ...(c.aliases ?? [])];
    const starts = this.commands.filter((c) => names(c).some((n) => n.startsWith(typed)));
    const contains = this.commands.filter((c) => !starts.includes(c) && c.name.includes(typed));
    return [...starts, ...contains];
  }

  /** The palette row that Enter or Tab would pick. */
  get selected(): Command | undefined {
    const menu = this.menu;
    return menu.length ? menu[Math.min(this.menuIndex, menu.length - 1)] : undefined;
  }

  /** True while the shortcuts panel is open. */
  get shortcuts(): boolean {
    return this.shortcutsOpen;
  }

  /** Applies one key; returns 'quit' when the session should end. */
  handle(ev: KeyEvent): 'quit' | undefined {
    if (ev.key !== 'interrupt' && ev.key !== 'eof') this.exitArmedUntil = 0;
    // the shortcuts panel: ? or Esc closes it; any other key closes it and does its usual thing
    if (this.shortcutsOpen) {
      this.shortcutsOpen = false;
      if (ev.key === 'escape' || (ev.key === 'char' && ev.char === '?')) return undefined;
    }
    const menu = this.menu;
    if (menu.length) {
      switch (ev.key) {
        case 'up':
        case 'backtab':
          this.menuIndex = (Math.min(this.menuIndex, menu.length - 1) - 1 + menu.length) % menu.length;
          return undefined;
        case 'down':
          this.menuIndex = (Math.min(this.menuIndex, menu.length - 1) + 1) % menu.length;
          return undefined;
        case 'tab': {
          const c = this.selected!;
          this.edit(() => this.setInput([...`/${c.name}${c.args ? ' ' : ''}`]));
          return undefined;
        }
        case 'enter':
          this.setInput([...`/${this.selected!.name}`]);
          return this.submit();
        case 'escape':
          this.menuClosed = true;
          return undefined;
      }
    }

    switch (ev.key) {
      case 'char':
        if (ev.char === '?' && this.buffer.length === 0) {
          this.shortcutsOpen = true;
          break;
        }
        this.edit(() => this.insert([...(ev.char ?? '')]));
        break;
      case 'paste':
        // a pasted newline must never send the line: paste lands as one line of text
        this.edit(() => this.insert([...(ev.char ?? '').replace(/\s+/g, ' ')]));
        break;
      case 'backspace':
        this.edit(() => this.cursor > 0 && this.buffer.splice(--this.cursor, 1));
        break;
      case 'delete':
        this.edit(() => this.buffer.splice(this.cursor, 1));
        break;
      case 'kill-start':
        this.edit(() => {
          this.buffer.splice(0, this.cursor);
          this.cursor = 0;
        });
        break;
      case 'kill-end':
        this.edit(() => this.buffer.splice(this.cursor));
        break;
      case 'kill-word':
        this.edit(() => {
          let from = this.cursor;
          while (from > 0 && /\s/.test(this.buffer[from - 1]!)) from--;
          while (from > 0 && !/\s/.test(this.buffer[from - 1]!)) from--;
          this.buffer.splice(from, this.cursor - from);
          this.cursor = from;
        });
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'right':
        this.cursor = Math.min(this.buffer.length, this.cursor + 1);
        break;
      case 'home':
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = this.buffer.length;
        break;
      case 'up':
        this.step(-1);
        break;
      case 'down':
        this.step(1);
        break;
      case 'page-up':
        this.scrollBy(this.pageRows - 1);
        break;
      case 'page-down':
        this.scrollBy(-(this.pageRows - 1));
        break;
      case 'clear':
        this.entries = [];
        this.scroll = 0;
        break;
      case 'escape':
        this.edit(() => this.setInput([]));
        break;
      case 'interrupt':
        if (this.buffer.length > 0) {
          this.edit(() => this.setInput([]));
          break;
        }
        return this.armExit();
      case 'eof':
        if (this.buffer.length === 0) return this.armExit();
        break;
      case 'enter':
        return this.submit();
      case 'tab':
      case 'backtab':
        break;
    }
    return undefined;
  }

  /** One wheel notch: back through the conversation (-1) or forward (1). */
  wheel(delta: -1 | 1): void {
    this.scrollBy(-delta * WHEEL_ROWS);
  }

  private scrollBy(rows: number): void {
    this.scroll = Math.max(0, this.scroll + rows);
  }

  /** The first Ctrl-C (or Ctrl-D) on an empty line arms leaving; a second one within the window leaves. */
  private armExit(): 'quit' | undefined {
    if (this.exitArmed) {
      this.exitArmedUntil = 0;
      return 'quit';
    }
    this.exitArmedUntil = this.now() + EXIT_WINDOW_MS;
    return undefined;
  }

  /** An edit to the line: it reopens the palette and moves its highlight back to the best match. */
  private edit(change: () => unknown): void {
    change();
    this.menuClosed = false;
    this.menuIndex = 0;
  }

  private insert(chars: string[]): void {
    this.buffer.splice(this.cursor, 0, ...chars);
    this.cursor += chars.length;
  }

  private setInput(chars: string[]): void {
    this.buffer = chars;
    this.cursor = chars.length;
  }

  private step(dir: -1 | 1): void {
    const next = this.recall + dir;
    if (next < 0 || next > this.history.length) return;
    if (this.recall === this.history.length) this.draft = this.buffer;
    this.recall = next;
    this.edit(() => this.setInput(next === this.history.length ? this.draft : [...this.history[next]!]));
  }

  private submit(): 'quit' | undefined {
    // a reply is on its way: keep the line until it has arrived
    if (this.busy) return undefined;
    const line = this.input.trim();
    if (line === '') return undefined;
    this.edit(() => this.setInput([]));
    this.scroll = 0;
    if (this.history.at(-1) !== line) this.history.push(line);
    this.recall = this.history.length;
    if (QUIT_WORDS.has(line.toLowerCase())) return 'quit';
    this.push({ kind: 'user', text: line });

    if (!line.startsWith('/')) {
      if (this.opts.onMessage) this.work(this.opts.onMessage(line));
      else this.push({ kind: 'reply', lines: [unknownCommand(line.split(/\s+/)[0]!)] });
      return undefined;
    }
    const [name, ...args] = line.slice(1).split(/\s+/);
    const typed = name!.toLowerCase();
    const command = this.commands.find((c) => c.name === typed || c.aliases?.includes(typed));
    if (!command) {
      this.push({ kind: 'reply', lines: [unknownCommand('/' + name)] });
      return undefined;
    }
    const result = command.run(args, { commands: this.commands, lastReply: this.lastReply() });
    if (result instanceof Promise) {
      this.work(result);
      return undefined;
    }
    return this.apply(result);
  }

  /** The newest reply as plain text, one line per row. */
  private lastReply(): string | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.kind === 'reply') return e.lines.map((l) => l.map((s) => s.text).join('')).join('\n');
    }
    return undefined;
  }

  private apply(result: CommandResult): 'quit' | undefined {
    if (result === 'quit') return 'quit';
    if (result === 'clear') {
      this.entries = [];
      this.scroll = 0;
    } else this.push({ kind: 'reply', lines: result });
    return undefined;
  }

  /** Shows `✻ Working…` until `reply` arrives, then the reply and how long it took. */
  private work(reply: Promise<CommandResult>): void {
    const started = this.now();
    this.busySince = started;
    this.pendingWork = reply
      .catch((): CommandResult => [[t('Something went wrong.')]])
      .then((result) => {
        this.busySince = undefined;
        if (this.apply(result) === 'quit') return this.opts.onQuit?.();
        const secs = Math.max(1, Math.round((this.now() - started) / 1000));
        this.push({ kind: 'note', line: [t(`${WORK_MARK}Worked for ${secs}s`, 1)] });
      });
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    if (this.entries.length > SCROLLBACK) this.entries.splice(0, this.entries.length - SCROLLBACK);
  }

  /** The conversation as display rows `width` columns wide: marks, wrapping and the blank rows between turns. */
  rows(width: number, nowMs = this.now()): Line[] {
    const out: Line[] = [];
    this.entries.forEach((entry, i) => {
      if (i > 0) out.push([]);
      if (entry.kind === 'note') out.push(...wrap(entry.line, width));
      // your messages sit on a light bar across the whole width
      else if (entry.kind === 'user')
        out.push(...hang(t(USER_MARK, 3), [[t(entry.text, 3)]], width).map((row) => fill(row, width)));
      else out.push(...hang(t(REPLY_MARK), entry.lines, width));
    });
    if (this.busySince !== undefined) {
      if (out.length) out.push([]);
      const secs = Math.floor((nowMs - this.busySince) / 1000);
      const spin = SPINNER[Math.floor(nowMs / 120) % SPINNER.length]!;
      out.push([t(`${spin} `, 2), t(`Working… ${secs}s`, 1)]);
    }
    return out;
  }

  /**
   * Draws the conversation into `r`, from its top; once it is full the oldest rows scroll off, and Page Up or the
   * wheel scrolls back, with a marker on the last row saying how much newer conversation is below.
   */
  drawConversation(f: Frame, r: Rect): void {
    const rows = this.rows(r.w);
    this.pageRows = Math.max(2, r.h);
    const maxScroll = Math.max(0, rows.length - r.h);
    this.scroll = Math.min(this.scroll, maxScroll);
    const end = rows.length - this.scroll;
    rows.slice(Math.max(0, end - r.h), end).forEach((line, i) => drawLine(f, r.x, r.y + i, line));
    if (this.scroll > 0) {
      const y = r.y + r.h - 1;
      for (let x = r.x; x < r.x + r.w; x++) put(f, x, y, ' ');
      drawLine(f, r.x, y, [t(`↓ ${this.scroll} more below`, 2), t(' · pgdn or the wheel to scroll down', 1)]);
    }
  }

  /**
   * Draws the input line at row `y` from `x`, `w` wide: its rules on the rows above and below (the lower one carrying
   * the key hints), and above them the command palette or the shortcuts panel when open.
   */
  drawInput(f: Frame, x: number, y: number, w: number, nowMs: number): void {
    // the input region hides the stars behind it
    for (let row = y - 1; row <= y + 1; row++) for (let col = x; col < x + w; col++) put(f, col, row, ' ');
    for (let col = x; col < x + w; col++) {
      put(f, col, y - 1, '─', 1);
      put(f, col, y + 1, '─', 1);
    }
    drawLine(f, x + 2, y + 1, this.hints());

    text(f, x + 1, y, USER_MARK, 2);
    const start = x + 1 + USER_MARK.length;
    const room = x + w - 1 - start;
    const cursorOn = Math.floor(nowMs / 500) % 2 === 0;
    if (this.buffer.length === 0) {
      text(f, start, y, PLACEHOLDER.slice(0, room), 1);
      if (cursorOn) put(f, start, y, '█', 0);
    } else {
      // scrolled so the cursor stays visible
      const from = Math.max(0, this.cursor - room + 1);
      this.buffer.slice(from, from + room).forEach((c, i) => put(f, start + i, y, c, 0));
      // after `/name `, the arguments it takes
      const hint = this.argHint();
      if (hint && this.cursor === this.buffer.length)
        text(f, start + this.buffer.length - from, y, hint.slice(0, room), 1);
      if (cursorOn) put(f, start + this.cursor - from, y, '█', 0);
    }

    if (this.shortcutsOpen) this.drawPanel(f, x, y - 2, w, shortcutLines());
    else {
      const menu = this.menu;
      if (menu.length) this.drawMenu(f, x, y - 2, w, menu);
    }
  }

  /** The key hints on the rule under the input: what the keys do right now. */
  private hints(): Line {
    const sep = t(' · ', 1);
    if (this.exitArmed) return [t(' Press Ctrl-C again to exit ', 2)];
    if (this.menu.length)
      return [
        t(' ↑↓', 2),
        t(' choose', 1),
        sep,
        t('tab', 2),
        t(' complete', 1),
        sep,
        t('enter', 2),
        t(' run', 1),
        sep,
        t('esc', 2),
        t(' close ', 1),
      ];
    if (this.shortcutsOpen) return [t(' esc', 2), t(' close ', 1)];
    if (this.scroll > 0) return [t(' pgdn', 2), t(' scroll down ', 1)];
    return [t(' /', 2), t(' commands', 1), sep, t('?', 2), t(' shortcuts', 1), sep, t('↑↓', 2), t(' history ', 1)];
  }

  /** The arguments still to type for `/name ` when the command takes some and none are typed yet. */
  private argHint(): string | undefined {
    const m = /^\/(\S+) $/.exec(this.input);
    if (!m) return undefined;
    const typed = m[1]!.toLowerCase();
    return this.commands.find((c) => c.name === typed || c.aliases?.includes(typed))?.args;
  }

  /** The palette, bottom row just above `bottom`: name (and its arguments) and summary, the highlighted row on a bar. */
  private drawMenu(f: Frame, x: number, bottom: number, w: number, menu: Command[]): void {
    const index = Math.min(this.menuIndex, menu.length - 1);
    const first = Math.max(0, Math.min(index - MENU_ROWS + 1, menu.length - MENU_ROWS));
    const shown = menu.slice(first, first + MENU_ROWS);
    const label = (c: Command) => `/${c.name}${c.args ? ` ${c.args}` : ''}`;
    const width = Math.max(...menu.map((c) => label(c).length)) + 3;
    shown.forEach((c, i) => {
      const y = bottom - shown.length + 1 + i;
      const on = first + i === index;
      for (let col = x; col < x + w; col++) put(f, col, y, ' ', on ? 3 : 0);
      drawLine(f, x + 2, y, [
        t(`/${c.name}`, on ? 3 : 2),
        t(`${c.args ? ` ${c.args}` : ''}`.padEnd(width - c.name.length - 1), on ? 3 : 1),
        t(c.summary.slice(0, Math.max(0, w - width - 4)), on ? 3 : 1),
      ]);
    });
  }

  /** A panel of lines (the shortcuts), bottom row just above `bottom`, with a blank row above it. */
  private drawPanel(f: Frame, x: number, bottom: number, w: number, lines: Line[]): void {
    const all: Line[] = [[t('Keyboard shortcuts', 0)], ...lines];
    all.forEach((line, i) => {
      const y = bottom - all.length + 1 + i;
      for (let col = x; col < x + w; col++) put(f, col, y, ' ');
      drawLine(f, x + 2, y, line);
    });
    for (let col = x; col < x + w; col++) put(f, col, bottom - all.length, '─', 1);
  }
}

function unknownCommand(name: string): Line {
  return [t(`unknown command: ${name}`), t(' · type ', 1), t('/', 2), t(' for commands', 1)];
}

/** Draws a bordered box, leaving the top edge open over `gap` (for a logo sitting on it); its inside is cleared. */
export function drawFrame(f: Frame, r: Rect, gap: { from: number; to: number } | null = null): void {
  if (r.w < 4 || r.h < 2) return;
  const right = r.x + r.w - 1;
  const bottom = r.y + r.h - 1;
  for (let y = r.y; y <= bottom; y++) for (let x = r.x; x <= right; x++) put(f, x, y, ' ');
  for (let x = r.x + 1; x < right; x++) {
    if (!gap || x < gap.from || x > gap.to) put(f, x, r.y, '─', 1);
    put(f, x, bottom, '─', 1);
  }
  for (let y = r.y + 1; y < bottom; y++) {
    put(f, r.x, y, '│', 1);
    put(f, right, y, '│', 1);
  }
  put(f, r.x, r.y, '╭', 1);
  put(f, right, r.y, '╮', 1);
  put(f, r.x, bottom, '╰', 1);
  put(f, right, bottom, '╯', 1);
}

/** Pads a row to `width` with marked spaces, so its bar runs the whole width. */
function fill(row: Line, width: number): Line {
  const used = row.reduce((n, seg) => n + [...seg.text].length, 0);
  return used < width ? [...row, t(' '.repeat(width - used), 3)] : row;
}

/** Lines under a mark: the first row starts with it, the rest (and wrapped rows) indent to line up with the text. */
function hang(mark: Segment, lines: Line[], width: number): Line[] {
  const indent = [...mark.text].length;
  const indentSeg = t(' '.repeat(indent), mark.tone === 3 ? 3 : 0);
  const out: Line[] = [];
  lines.forEach((line, i) => {
    wrap(line, width - indent).forEach((row, j) => out.push([i === 0 && j === 0 ? mark : indentSeg, ...row]));
  });
  return out;
}

/** Control characters (a stray newline or escape) would move the terminal's cursor; they show as spaces. */
const visible = (c: string): string => {
  const code = c.codePointAt(0)!;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : c;
};

/** Splits a line into rows of at most `width` cells. */
function wrap(line: Line, width: number): Line[] {
  const rows: Line[] = [[]];
  let used = 0;
  for (const seg of line) {
    let rest = [...seg.text].map(visible);
    while (rest.length) {
      if (used === width) {
        rows.push([]);
        used = 0;
      }
      const take = rest.slice(0, width - used);
      rows.at(-1)!.push({ text: take.join(''), tone: seg.tone });
      used += take.length;
      rest = rest.slice(take.length);
    }
  }
  return rows;
}

function drawLine(f: Frame, x: number, y: number, line: Line): void {
  for (const seg of line) {
    text(f, x, y, seg.text, seg.tone);
    x += [...seg.text].length;
  }
}
