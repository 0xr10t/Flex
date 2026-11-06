// Raw terminal input to events: SGR mouse reports (position and wheel), editing keys (arrows, Home/End, Page Up/Down,
// Delete, Backspace, Tab), the readline control keys (Ctrl-A/E/U/K/W), bracketed paste, and typed characters, so the
// command box can be edited like a shell line.

export type Key =
  | 'char'
  | 'paste'
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
export type KeyEvent = { kind: 'key'; key: Key; char?: string };
export type InputEvent =
  | { kind: 'mouse'; col: number; row: number }
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
        events.push({ kind: 'mouse', col, row });
        continue;
      }
      const key = final === '~' ? TILDE_KEYS[params] : final !== undefined ? CSI_KEYS[final] : undefined;
      if (key) events.push({ kind: 'key', key });
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
