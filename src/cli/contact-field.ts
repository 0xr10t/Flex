import type { KeyEvent } from './input.js';
import { pasteText } from './selection.js';

/** Small single-line editor shared by the contact name and address fields. Offsets are Unicode code points. */
export class ContactField {
  chars: string[];
  cursor: number;
  anchor: number | undefined;
  constructor(value: string) {
    this.chars = [...value];
    this.cursor = this.chars.length;
  }
  get value(): string {
    return this.chars.join('');
  }
  get range(): [number, number] {
    return [Math.min(this.anchor ?? this.cursor, this.cursor), Math.max(this.anchor ?? this.cursor, this.cursor)];
  }
  get selected(): string {
    const [a, b] = this.range;
    return this.chars.slice(a, b).join('');
  }
  remove(): boolean {
    const [a, b] = this.range;
    this.anchor = undefined;
    if (a === b) return false;
    this.chars.splice(a, b - a);
    this.cursor = a;
    return true;
  }
  handle(ev: KeyEvent): void {
    const key = ev.key;
    if (['left', 'right', 'home', 'end'].includes(key)) {
      const [a, b] = this.range;
      const before = this.cursor;
      this.cursor =
        key === 'home'
          ? 0
          : key === 'end'
            ? this.chars.length
            : !ev.shift && a !== b
              ? key === 'left'
                ? a
                : b
              : Math.max(0, Math.min(this.chars.length, before + (key === 'left' ? -1 : 1)));
      this.anchor = ev.shift ? (this.anchor ?? before) : undefined;
    } else if (key === 'char' || key === 'paste') {
      const incoming = [...pasteText(ev.char ?? '')];
      const [a, b] = this.range;
      if (this.chars.length - (b - a) + incoming.length > 4096) return;
      this.remove();
      this.chars.splice(this.cursor, 0, ...incoming);
      this.cursor += incoming.length;
    } else if (['backspace', 'delete', 'kill-start', 'kill-end', 'kill-word'].includes(key)) {
      if (this.remove()) return;
      if (key === 'backspace' && this.cursor > 0) this.chars.splice(--this.cursor, 1);
      else if (key === 'delete') this.chars.splice(this.cursor, 1);
      else if (key === 'kill-start') {
        this.chars.splice(0, this.cursor);
        this.cursor = 0;
      } else if (key === 'kill-end') this.chars.splice(this.cursor);
      else if (key === 'kill-word') {
        const start = this.chars
          .slice(0, this.cursor)
          .join('')
          .replace(/\s*\S+\s*$/u, '');
        const at = [...start].length;
        this.chars.splice(at, this.cursor - at);
        this.cursor = at;
      }
    }
  }
}
