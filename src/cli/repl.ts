// The conversation: what you type and what comes back, styled like the Claude CLI. Your messages show as `❯ message`
// on a light bar across the width, replies as `● reply` with their further lines indented under it, a blank line between exchanges. The input line sits
// apart, between two rules, with a `❯` prompt and a dim hint while it is empty. It edits like a shell line (cursor
// keys, Home/End, Backspace/Delete, history on Up/Down, Ctrl-C to drop the line or leave, Ctrl-L to clear) and runs
// commands from a table. Only the built-in commands exist so far; the wallet commands plug in here.

import { put, text, type Frame, type Rect, type Tone } from './render/frame.js';
import type { KeyEvent } from './input.js';

export interface Segment {
  text: string;
  tone: Tone;
}

/** One line of output, possibly in several tones. */
export type Line = Segment[];

export type CommandResult = Line[] | 'clear' | 'quit';

export interface Command {
  name: string;
  summary: string;
  run(args: string[], commands: readonly Command[]): CommandResult;
}

/** One turn of the conversation. */
export type Entry = { kind: 'user'; text: string } | { kind: 'reply'; lines: Line[] } | { kind: 'note'; line: Line };

export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    name: 'help',
    summary: 'list the commands',
    run: (_args, commands) => {
      const width = Math.max(...commands.map((c) => c.name.length)) + 3;
      return commands.map((c) => [
        { text: c.name.padEnd(width), tone: 2 },
        { text: c.summary, tone: 1 },
      ]);
    },
  },
  { name: 'clear', summary: 'clear the conversation', run: () => 'clear' },
  { name: 'exit', summary: 'leave flexx', run: () => 'quit' },
];

const WELCOME: Entry = {
  kind: 'note',
  line: [
    { text: 'type ', tone: 1 },
    { text: 'help', tone: 2 },
    { text: ' to see the commands', tone: 1 },
  ],
};

const USER_MARK = '❯ ';
const REPLY_MARK = '● ';
const PLACEHOLDER = 'Try "help"';
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

  constructor(private readonly commands: readonly Command[] = BUILTIN_COMMANDS) {}

  /** The current input line. */
  get input(): string {
    return this.buffer.join('');
  }

  /** The conversation so far, oldest first. */
  get conversation(): readonly Entry[] {
    return this.entries;
  }

  /** Applies one key; returns 'quit' when the session should end. */
  handle(ev: KeyEvent): 'quit' | undefined {
    switch (ev.key) {
      case 'char': {
        const chars = [...(ev.char ?? '')];
        this.buffer.splice(this.cursor, 0, ...chars);
        this.cursor += chars.length;
        break;
      }
      case 'backspace':
        if (this.cursor > 0) this.buffer.splice(--this.cursor, 1);
        break;
      case 'delete':
        this.buffer.splice(this.cursor, 1);
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
      case 'clear':
        this.entries = [];
        break;
      case 'interrupt':
        if (this.buffer.length === 0) return 'quit';
        this.setInput([]);
        break;
      case 'eof':
        if (this.buffer.length === 0) return 'quit';
        break;
      case 'enter':
        return this.submit();
      case 'escape':
        break;
    }
    return undefined;
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
    this.setInput(next === this.history.length ? this.draft : [...this.history[next]!]);
  }

  private submit(): 'quit' | undefined {
    const line = this.input;
    this.setInput([]);
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return undefined;
    if (this.history.at(-1) !== line) this.history.push(line);
    this.recall = this.history.length;
    this.push({ kind: 'user', text: line.trim() });

    const [name, ...args] = words;
    const command = this.commands.find((c) => c.name === name!.toLowerCase());
    if (!command) {
      this.push({
        kind: 'reply',
        lines: [
          [
            { text: `unknown command: ${name}`, tone: 0 },
            { text: ' · type ', tone: 1 },
            { text: 'help', tone: 2 },
          ],
        ],
      });
      return undefined;
    }
    const result = command.run(args, this.commands);
    if (result === 'quit') return 'quit';
    if (result === 'clear') this.entries = [];
    else this.push({ kind: 'reply', lines: result });
    return undefined;
  }

  private push(entry: Entry): void {
    this.entries.push(entry);
    if (this.entries.length > SCROLLBACK) this.entries.splice(0, this.entries.length - SCROLLBACK);
  }

  /** The conversation as display rows `width` columns wide: marks, wrapping and the blank rows between turns. */
  rows(width: number): Line[] {
    const out: Line[] = [];
    this.entries.forEach((entry, i) => {
      if (i > 0) out.push([]);
      if (entry.kind === 'note') out.push(...wrap(entry.line, width));
      // your messages sit on a light bar across the whole width
      else if (entry.kind === 'user')
        out.push(
          ...hang({ text: USER_MARK, tone: 3 }, [[{ text: entry.text, tone: 3 }]], width).map((row) =>
            fill(row, width),
          ),
        );
      else out.push(...hang({ text: REPLY_MARK, tone: 0 }, entry.lines, width));
    });
    return out;
  }

  /** Draws the conversation into `r`, from its top; once it is full, the oldest rows scroll off. */
  drawConversation(f: Frame, r: Rect): void {
    const rows = this.rows(r.w);
    rows.slice(Math.max(0, rows.length - r.h)).forEach((line, i) => drawLine(f, r.x, r.y + i, line));
  }

  /** Draws the input line at row `y` from `x`, `w` wide, with its rules on the rows above and below. */
  drawInput(f: Frame, x: number, y: number, w: number, nowMs: number): void {
    // the input region hides the stars behind it
    for (let row = y - 1; row <= y + 1; row++) for (let col = x; col < x + w; col++) put(f, col, row, ' ');
    for (let col = x; col < x + w; col++) {
      put(f, col, y - 1, '─', 1);
      put(f, col, y + 1, '─', 1);
    }
    text(f, x + 1, y, USER_MARK, 2);
    const start = x + 1 + USER_MARK.length;
    const room = x + w - 1 - start;
    const cursorOn = Math.floor(nowMs / 500) % 2 === 0;
    if (this.buffer.length === 0) {
      text(f, start, y, PLACEHOLDER.slice(0, room), 1);
      if (cursorOn) put(f, start, y, '█', 0);
      return;
    }
    // scrolled so the cursor stays visible
    const from = Math.max(0, this.cursor - room + 1);
    this.buffer.slice(from, from + room).forEach((c, i) => put(f, start + i, y, c, 0));
    if (cursorOn) put(f, start + this.cursor - from, y, '█', 0);
  }
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
  return used < width ? [...row, { text: ' '.repeat(width - used), tone: 3 }] : row;
}

/** Lines under a mark: the first row starts with it, the rest (and wrapped rows) indent to line up with the text. */
function hang(mark: Segment, lines: Line[], width: number): Line[] {
  const indent = [...mark.text].length;
  const indentSeg: Segment = { text: ' '.repeat(indent), tone: mark.tone === 3 ? 3 : 0 };
  const out: Line[] = [];
  lines.forEach((line, i) => {
    wrap(line, width - indent).forEach((row, j) => out.push([i === 0 && j === 0 ? mark : indentSeg, ...row]));
  });
  return out;
}

/** Splits a line into rows of at most `width` cells. */
function wrap(line: Line, width: number): Line[] {
  const rows: Line[] = [[]];
  let used = 0;
  for (const seg of line) {
    let rest = [...seg.text];
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
