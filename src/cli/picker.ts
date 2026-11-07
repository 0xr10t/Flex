// A list you move through with the arrow keys and open with Enter, shown in place of the conversation. /db uses it to
// choose which database to read: Enter closes it and runs that getter, so the records land in the conversation like any
// other reply.

import type { InputEvent, KeyEvent } from './input.js';
import type { CliPanel, PanelResult } from './panel.js';
import { put, text, type Frame, type Rect } from './render/frame.js';

export interface PickerItem {
  label: string;
  detail?: string;
  /** The line Enter runs, e.g. `/get balances`. */
  run: string;
}

export class PickerPanel implements CliPanel {
  private index = 0;
  private first = 0;
  /** Where each visible row was drawn, for clicks. */
  private rowsAt: { y: number; index: number }[] = [];

  constructor(
    private readonly title: string,
    private readonly items: readonly PickerItem[],
    private readonly footer: readonly string[] = [],
  ) {}

  get hint(): string {
    return '↑↓ choose · enter open · home/end · pgup/pgdn · esc close';
  }

  /** The highlighted item (for tests). */
  get selected(): PickerItem | undefined {
    return this.items[this.index];
  }

  private move(delta: number): void {
    if (!this.items.length) return;
    this.index = Math.max(0, Math.min(this.items.length - 1, this.index + delta));
  }

  handle(ev: KeyEvent): PanelResult {
    switch (ev.key) {
      case 'up':
      case 'backtab':
        this.move(-1);
        return;
      case 'down':
      case 'tab':
        this.move(1);
        return;
      case 'page-up':
        this.move(-10);
        return;
      case 'page-down':
        this.move(10);
        return;
      case 'home':
        this.index = 0;
        return;
      case 'end':
        this.index = Math.max(0, this.items.length - 1);
        return;
      case 'enter': {
        const item = this.items[this.index];
        return item ? { run: item.run } : 'close';
      }
      case 'escape':
      case 'interrupt':
      case 'eof':
        return 'close';
      case 'char':
        if (ev.char === 'q') return 'close';
        if (ev.char === 'k') this.move(-1);
        if (ev.char === 'j') this.move(1);
        return;
    }
  }

  mouse(ev: Extract<InputEvent, { kind: 'mouse' }>): PanelResult {
    const hit = this.rowsAt.find((r) => r.y === ev.row - 1);
    if (!hit || ev.action === 'move') return;
    if (ev.action === 'up') return;
    if (hit.index === this.index) return { run: this.items[hit.index]!.run };
    this.index = hit.index;
  }

  wheel(delta: -1 | 1): void {
    this.move(delta);
  }

  draw(f: Frame, r: Rect): void {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) put(f, x, y, ' ');
    text(f, r.x, r.y, this.title.slice(0, r.w), 2);
    const top = r.y + 2;
    const room = Math.max(1, r.h - 3 - this.footer.length);
    if (this.index < this.first) this.first = this.index;
    if (this.index >= this.first + room) this.first = this.index - room + 1;
    this.first = Math.max(0, Math.min(this.first, Math.max(0, this.items.length - room)));
    const width = Math.max(0, ...this.items.map((i) => [...i.label].length)) + 3;
    this.rowsAt = [];
    this.items.slice(this.first, this.first + room).forEach((item, i) => {
      const y = top + i;
      const index = this.first + i;
      const on = index === this.index;
      this.rowsAt.push({ y, index });
      for (let x = r.x; x < r.x + r.w; x++) put(f, x, y, ' ', on ? 3 : 0);
      text(f, r.x, y, (on ? '❯ ' : '  ').slice(0, r.w), on ? 3 : 2);
      text(f, r.x + 2, y, item.label.padEnd(width).slice(0, Math.max(0, r.w - 2)), on ? 3 : 0);
      if (item.detail) text(f, r.x + 2 + width, y, item.detail.slice(0, Math.max(0, r.w - width - 3)), on ? 3 : 1);
    });
    const shown = Math.min(room, this.items.length);
    const more = this.items.length - (this.first + shown);
    let y = top + shown;
    if (this.first > 0 || more > 0) {
      text(f, r.x + 2, y, `${this.index + 1} of ${this.items.length}`.slice(0, r.w), 1);
      y++;
    }
    for (const line of this.footer) text(f, r.x, ++y, line.slice(0, r.w), 1);
  }

  async idle(): Promise<void> {}
}
