import { StringDecoder } from 'node:string_decoder';
// Raw terminal input to events: SGR mouse reports (position and wheel), editing keys (arrows, Home/End, Page Up/Down,
// Delete, Backspace, Tab), the readline control keys (Ctrl-A/E/U/K/W), bracketed paste, and typed characters, so the
// command box can be edited like a shell line.

export type Key =
  | 'char'
  | 'paste'
  | 'cut'
  | 'save'
  | 'clipboard-paste'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'page-up'
  | 'page-down'
  | 'tab'
  | 'backtab'
  | 'kill-start'
  | 'kill-end'
  | 'kill-word'
  | 'escape'
  | 'interrupt'
  | 'eof'
  | 'clear';

/** A key; `char` carries the typed character, or the pasted text for `paste`. */
export type KeyEvent = { kind: 'key'; key: Key; char?: string; shift?: boolean };
export type InputEvent =
  | { kind: 'mouse'; col: number; row: number; action?: 'down' | 'move' | 'up'; button?: number }
  /** One notch of the mouse wheel: -1 up (back through the conversation), 1 down. */
  | { kind: 'wheel'; delta: -1 | 1 }
  | KeyEvent;

const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

/** CSI and SS3 final bytes (and `~` codes) that mean an editing key. */
const CSI_KEYS: Record<string, Key> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'backtab' };
const TILDE_KEYS: Record<string, Key> = {
  '1': 'home',
  '7': 'home',
  '4': 'end',
  '8': 'end',
  '3': 'delete',
  '5': 'page-up',
  '6': 'page-down',
};

const CONTROL_KEYS: Record<string, Key> = {
  '\r': 'enter',
  '\n': 'enter',
  '\t': 'tab',
  '\u007f': 'backspace',
  '\b': 'backspace',
  '\u0001': 'home',
  '\u0005': 'end',
  '\u0015': 'kill-start',
  '\u000b': 'kill-end',
  '\u0017': 'kill-word',
  '\u0003': 'interrupt',
  '\u0018': 'cut',
  '\u0013': 'save',
  '\u0016': 'clipboard-paste',
  '\u0004': 'eof',
  '\u000c': 'clear',
};

/**
 * Splits a chunk of raw input into events. Mouse reports use SGR encoding (`ESC [ < button ; col ; row M|m`): moves
 * report their position, wheel notches their direction. Text between the bracketed-paste markers is one `paste`. An
 * Escape at the end of a chunk is the Escape key; unknown escape sequences are dropped.
 */
export function parseInput(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  let rest = data;
  // bracketed paste: everything between the markers is text, newlines included, and never runs anything
  for (let at = rest.indexOf(PASTE_START); at !== -1; at = rest.indexOf(PASTE_START)) {
    events.push(...parseKeys(rest.slice(0, at)));
    const end = rest.indexOf(PASTE_END, at);
    const text = rest.slice(at + PASTE_START.length, end === -1 ? undefined : end);
    if (text) events.push({ kind: 'key', key: 'paste', char: text });
    rest = end === -1 ? '' : rest.slice(end + PASTE_END.length);
  }
  events.push(...parseKeys(rest));
  return events;
}

function parseKeys(data: string): InputEvent[] {
  const events: InputEvent[] = [];
  const chars = [...data];
  let i = 0;
  while (i < chars.length) {
    const c = chars[i]!;
    if (c === ESC) {
      const next = chars[i + 1];
      if (next === undefined) {
        events.push({ kind: 'key', key: 'escape' });
        i++;
        continue;
      }
      if (next !== '[' && next !== 'O') {
        // Alt+key: ignore the modifier
        i++;
        continue;
      }
      let j = i + 2;
      while (j < chars.length && !/[A-Za-z~]/.test(chars[j]!)) j++;
      const params = chars.slice(i + 2, j).join('');
      const final = chars[j];
      i = j + 1;
      if (next === '[' && params.startsWith('<') && (final === 'M' || final === 'm')) {
        const parts = params.slice(1).split(';');
        const button = Number(parts[0]);
        const col = Number(parts[1]);
        const row = Number(parts[2]);
        if (parts.length !== 3 || !Number.isInteger(col) || !Number.isInteger(row)) continue;
        // wheel: bit 64 set, low bits 0 (up) or 1 (down); modifier bits (4, 8, 16) don't matter
        if (button & 64 && final === 'M') {
          if ((button & 3) <= 1) events.push({ kind: 'wheel', delta: button & 1 ? 1 : -1 });
          continue;
        }
        events.push({
          kind: 'mouse',
          col,
          row,
          action: final === 'm' ? 'up' : button & 32 ? 'move' : 'down',
          button: button & 3,
        });
        continue;
      }
      const key = final === '~' ? TILDE_KEYS[params.split(';')[0]!] : final !== undefined ? CSI_KEYS[final] : undefined;
      if (key)
        events.push({ kind: 'key', key, ...((Number(params.split(';')[1] ?? 1) - 1) & 1 ? { shift: true } : {}) });
      continue;
    }
    // a CR LF pair is one Enter
    if (c === '\n' && chars[i - 1] === '\r') {
      i++;
      continue;
    }
    const control = CONTROL_KEYS[c];
    if (control) events.push({ kind: 'key', key: control });
    else if (c >= ' ') events.push({ kind: 'key', key: 'char', char: c });
    i++;
  }
  return events;
}

/** Stateful decoder: a split paste marker or UTF-8 code point must never become submitted keystrokes. */
export class InputDecoder {
  private readonly utf8 = new StringDecoder('utf8');
  private pending = '';
  private pasted = '';
  private inPaste = false;
  private overflow = false;
  private previousCr = false;
  private flushedEscape = false;
  feed(chunk: Buffer | string): InputEvent[] {
    let text = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    if (this.previousCr && text.startsWith('\n')) text = text.slice(1);
    this.previousCr = false;
    if (this.flushedEscape && (text.startsWith('[') || text.startsWith('O'))) this.pending = ESC;
    if (text) this.flushedEscape = false;
    this.pending += text;
    const events: InputEvent[] = [];
    while (this.pending) {
      if (this.inPaste) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(PASTE_END.length - 1, this.pending.length);
          this.pasted += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(-keep);
          if (this.pasted.length > 1_000_000) {
            this.pasted = '';
            this.overflow = true;
          }
          return events;
        }
        const pasted = this.pasted + this.pending.slice(0, end);
        if (!this.overflow && pasted.length <= 1_000_000 && pasted)
          events.push({ kind: 'key', key: 'paste', char: pasted });
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.pasted = '';
        this.inPaste = false;
        this.overflow = false;
        continue;
      }
      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }
      const esc = this.pending.indexOf(ESC);
      if (esc !== 0) {
        const prefix = esc < 0 ? this.pending : this.pending.slice(0, esc);
        events.push(...parseInput(prefix));
        this.previousCr = prefix.endsWith('\r');
        this.pending = esc < 0 ? '' : this.pending.slice(esc);
        continue;
      }
      if (this.pending.length === 1) break;
      const tail = /^(?:\[[0-?]*[ -/]*[@-~]|O[A-Za-z])/.exec(this.pending.slice(1))?.[0];
      const sequence = tail ? ESC + tail : undefined;
      if (!sequence) {
        if (this.pending[1] === '[' || this.pending[1] === 'O') break;
        events.push(...parseInput(this.pending.slice(0, 2)));
        this.pending = this.pending.slice(2);
        continue;
      }
      events.push(...parseInput(sequence));
      this.pending = this.pending.slice(sequence.length);
    }
    return events;
  }
  /** Distinguish a standalone Escape from a sequence split across data events. Never flush an unfinished paste. */
  flush(): InputEvent[] {
    if (this.inPaste) return [];
    if (this.pending !== ESC) return [];
    this.pending = '';
    this.flushedEscape = true;
    return [{ kind: 'key', key: 'escape' }];
  }
}
