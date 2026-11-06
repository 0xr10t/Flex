// Raw terminal input to events: SGR mouse reports, editing keys (arrows, Home/End, Delete, Backspace), control keys
// and typed characters, so the command box can be edited like a shell line.

export type Key =
  | 'char'
  | 'enter'
  | 'backspace'
  | 'delete'
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'escape'
  | 'interrupt'
  | 'eof'
  | 'clear';

export type KeyEvent = { kind: 'key'; key: Key; char?: string };
export type InputEvent = { kind: 'mouse'; col: number; row: number } | KeyEvent;

const ESC = '\u001b';

/** CSI and SS3 final bytes (and `~` codes) that mean an editing key. */
const CSI_KEYS: Record<string, Key> = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
const TILDE_KEYS: Record<string, Key> = { '1': 'home', '7': 'home', '4': 'end', '8': 'end', '3': 'delete' };

const CONTROL_KEYS: Record<string, Key> = {
  '\r': 'enter',
  '\n': 'enter',
  '\u007f': 'backspace',
  '\b': 'backspace',
  '\u0003': 'interrupt',
  '\u0004': 'eof',
  '\u000c': 'clear',
};

/**
 * Splits a chunk of raw input into events. Mouse reports use SGR encoding (`ESC [ < button ; col ; row M|m`); only
 * their position matters. An Escape at the end of a chunk is the Escape key; unknown escape sequences are dropped.
 */
export function parseInput(data: string): InputEvent[] {
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
        const col = Number(parts[1]);
        const row = Number(parts[2]);
        if (parts.length === 3 && Number.isInteger(col) && Number.isInteger(row))
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
