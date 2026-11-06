// The command box: a bordered region with the session's output above a `flex $` input line. It edits like a shell
// line (cursor keys, Home/End, Backspace/Delete, history on Up/Down, Ctrl-C to drop the line or leave, Ctrl-L to
// clear) and runs commands from a table. Only the built-in commands exist so far; the wallet commands plug in here.

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

export const BUILTIN_COMMANDS: readonly Command[] = [
  {
    name: 'help',
    summary: 'list the commands',
    run: (_args, commands) => {
      const width = Math.max(...commands.map((c) => c.name.length)) + 3;
      return commands.map((c) => [
        { text: '  ' + c.name.padEnd(width), tone: 2 },
        { text: c.summary, tone: 1 },
      ]);
    },
  },
  { name: 'clear', summary: 'clear the box', run: () => 'clear' },
  { name: 'exit', summary: 'leave flexx', run: () => 'quit' },
];

const WELCOME: Line = [
  { text: 'type ', tone: 1 },
  { text: 'help', tone: 2 },
  { text: ' to see the commands', tone: 1 },
];

/** Most output lines kept. */
const SCROLLBACK = 500;

export class Repl {
  private lines: Line[] = [WELCOME];
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

  /** Output lines so far, oldest first. */
  get output(): readonly Line[] {
    return this.lines;
  }

  /** Applies one key; returns 'quit' when the session should end. */
  handle(ev: KeyEvent): 'quit' | undefined {
    switch (ev.key) {
      case 'char':
        this.buffer.splice(this.cursor, 0, ...[...(ev.char ?? '')]);
        this.cursor += [...(ev.char ?? '')].length;
        break;
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
        this.lines = [];
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
    this.recall = this.history.length;
    this.push([
      { text: 'flex', tone: 2 },
      { text: ' $ ', tone: 1 },
      { text: line, tone: 0 },
    ]);
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return undefined;
    if (this.history.at(-1) !== line) this.history.push(line);
    this.recall = this.history.length;

    const [name, ...args] = words;
    const command = this.commands.find((c) => c.name === name!.toLowerCase());
    if (!command) {
      this.push([
        { text: `unknown command: ${name}`, tone: 0 },
        { text: ' · type ', tone: 1 },
        { text: 'help', tone: 2 },
      ]);
      return undefined;
    }
    const result = command.run(args, this.commands);
    if (result === 'quit') return 'quit';
    if (result === 'clear') this.lines = [];
    else for (const l of result) this.push(l);
    return undefined;
  }

  private push(line: Line): void {
    this.lines.push(line);
    if (this.lines.length > SCROLLBACK) this.lines.splice(0, this.lines.length - SCROLLBACK);
  }

  /** Draws the box into `f` at `r`; `nowMs` drives the cursor blink. */
  draw(f: Frame, r: Rect, nowMs: number): void {
    if (r.w < 8 || r.h < 3) return;
    const right = r.x + r.w - 1;
    const bottom = r.y + r.h - 1;
    // the box hides the stars behind it
    for (let y = r.y; y <= bottom; y++) for (let x = r.x; x <= right; x++) put(f, x, y, ' ');
    for (let x = r.x + 1; x < right; x++) {
      put(f, x, r.y, '─', 1);
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
    text(f, r.x + 2, r.y, ' flex ', 2);

    const innerX = r.x + 2;
    const innerW = r.w - 4;
    const innerRows = r.h - 2;
    const inputY = bottom - 1;

    // output, wrapped to the box, newest at the bottom just above the input line
    const wrapped = this.lines.flatMap((l) => wrap(l, innerW));
    const shown = wrapped.slice(Math.max(0, wrapped.length - (innerRows - 1)));
    shown.forEach((line, i) => drawLine(f, innerX, inputY - shown.length + i, line));

    // input line, scrolled so the cursor stays visible
    const prompt = 'flex $ ';
    text(f, innerX, inputY, 'flex', 2);
    text(f, innerX + 4, inputY, ' $ ', 1);
    const room = innerW - prompt.length;
    const start = Math.max(0, this.cursor - room + 1);
    const visible = this.buffer.slice(start, start + room);
    visible.forEach((c, i) => put(f, innerX + prompt.length + i, inputY, c, 0));
    if (Math.floor(nowMs / 500) % 2 === 0) put(f, innerX + prompt.length + this.cursor - start, inputY, '█', 0);
  }
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
