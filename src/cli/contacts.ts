import type { ContactEdit, ContactRecord, ContactsPage } from '@flex/protocol';
import { AgentHttpError } from './agent/client.js';
import { ContactField } from './contact-field.js';
import type { InputEvent, KeyEvent } from './input.js';
import type { CliPanel } from './panel.js';
import { put, text, type Frame, type Rect, type Tone } from './render/frame.js';
import { pasteText } from './selection.js';

type Mouse = Extract<InputEvent, { kind: 'mouse' }>;
interface ContactActions {
  list(offset: number): Promise<ContactsPage>;
  save(id: number, edit: ContactEdit): Promise<ContactRecord>;
  copy(text: string): Promise<boolean>;
  paste(): Promise<string | undefined>;
}
interface Hit {
  x: number;
  y: number;
  w: number;
  action: () => void;
  field?: ContactField;
  from?: number;
}
const ERRORS: Record<string, string> = {
  name: 'Use a name of 1–32 letters, numbers, spaces, dots, hyphens or underscores; avoid reserved names.',
  address: 'Enter a valid nonzero address with a correct checksum. It cannot be your own wallet.',
  chain_ids: 'Select at least one supported network.',
  name_taken: 'That name is already used by another contact.',
  address_has_other_name: 'That address is already saved under another contact.',
  stale: 'This contact changed since you opened it. Cancel and reload before editing again.',
  not_found: 'This contact is no longer available. Cancel and reload.',
};

export class ContactsPanel implements CliPanel {
  private selected = 0;
  private draft:
    { original: ContactRecord; name: ContactField; address: ContactField; chains: Set<number> } | undefined;
  private focus = 0;
  private status = '';
  private pending: Promise<void> | undefined;
  private clipboard: Promise<void> | undefined;
  private epoch = 0;
  private tooSmall = false;
  private hits: Hit[] = [];
  private dragging: Hit | undefined;
  constructor(
    private page: ContactsPage,
    private readonly actions: ContactActions,
  ) {}
  get hint(): string {
    return this.pending
      ? 'Address book · saving/loading…'
      : this.draft
        ? 'Tab fields · Space network · Ctrl-S save · Esc cancel · Shift-arrows select · Ctrl-C/X/V clipboard'
        : '↑↓ select · E edit · PgUp/PgDn pages · R reload · Ctrl-C copy address · Esc close';
  }
  async idle(): Promise<void> {
    await Promise.all([this.pending, this.clipboard]);
  }
  private get networks(): Array<{ chain_id: number; name: string; available: boolean }> {
    const available = this.page.networks.map((network) => ({ ...network, available: true }));
    const missing = (this.draft?.original.chain_ids ?? []).filter(
      (id) => !available.some((network) => network.chain_id === id),
    );
    return [
      ...available,
      ...missing.map((chain_id) => ({ chain_id, name: `Unavailable network ${chain_id}`, available: false })),
    ];
  }
  private edit(): void {
    const original = this.page.contacts[this.selected];
    if (!original || this.pending || this.draft || this.tooSmall) return;
    this.draft = {
      original,
      name: new ContactField(original.name),
      address: new ContactField(original.address),
      chains: new Set(original.chain_ids),
    };
    this.focus = 0;
    this.status = '';
    this.epoch++;
  }
  private cancel(): void {
    this.draft = undefined;
    this.status = '';
    this.dragging = undefined;
    this.epoch++;
  }
  private field(): ContactField | undefined {
    return this.focus === 0 ? this.draft?.name : this.focus === 1 ? this.draft?.address : undefined;
  }
  private select(delta: number): void {
    this.selected = Math.max(0, Math.min(this.page.contacts.length - 1, this.selected + delta));
    this.status = '';
  }
  private reload(offset = this.page.offset): void {
    if (this.pending) return;
    this.status = '';
    this.pending = this.actions
      .list(offset)
      .then((page) => {
        this.page = page;
        this.selected = Math.max(0, Math.min(this.selected, page.contacts.length - 1));
      })
      .catch(() => {
        this.status = 'Could not load contacts. Press R to retry.';
      })
      .finally(() => {
        this.pending = undefined;
      });
  }
  private save(): void {
    const draft = this.draft;
    if (!draft || this.pending || this.tooSmall) return;
    if (!draft.name.value.trim()) {
      this.status = 'Enter a contact name.';
      this.focus = 0;
      return;
    }
    if (!draft.chains.size) {
      this.status = ERRORS.chain_ids!;
      return;
    }
    if ([...draft.chains].some((id) => !this.page.networks.some((network) => network.chain_id === id))) {
      this.status = 'Remove unavailable networks before saving.';
      return;
    }
    this.epoch++;
    const edit: ContactEdit = {
      name: draft.name.value,
      address: draft.address.value,
      chain_ids: [...draft.chains],
      version: draft.original.version,
    };
    this.status = 'Saving…';
    this.pending = this.actions
      .save(draft.original.id, edit)
      .then((saved) => {
        this.page.contacts[this.selected] = saved;
        this.draft = undefined;
        this.dragging = undefined;
        this.status = 'Contact saved.';
      })
      .catch((error: unknown) => {
        this.status =
          error instanceof AgentHttpError
            ? error.fields.map((field) => ERRORS[field] ?? 'Could not save this contact.').join(' ') ||
              'Could not save this contact.'
            : 'Save could not be confirmed. Cancel and reload to check the stored contact before retrying.';
      })
      .finally(() => {
        this.pending = undefined;
      });
  }
  private toggleNetwork(index: number): void {
    const network = this.networks[index];
    const id = network?.chain_id;
    if (!this.draft || id === undefined) return;
    if (this.draft.chains.has(id)) this.draft.chains.delete(id);
    else if (network?.available) this.draft.chains.add(id);
    this.focus = index + 2;
    this.epoch++;
  }
  private copy(cut: boolean): void {
    if (this.clipboard) return;
    const field = this.field();
    const value = this.draft ? field?.selected : this.page.contacts[this.selected]?.address;
    if (!value) return;
    const epoch = this.epoch;
    this.clipboard = this.actions
      .copy(value)
      .then((ok) => {
        if (!ok) {
          this.status = 'Could not reach the clipboard.';
          return;
        }
        if (cut && field && this.epoch === epoch) {
          field.remove();
          this.epoch++;
        }
        this.status = 'Copied to clipboard.';
      })
      .catch(() => {
        this.status = 'Could not reach the clipboard.';
      })
      .finally(() => {
        this.clipboard = undefined;
      });
  }
  private paste(): void {
    const field = this.field();
    if (!field || this.clipboard) return;
    const epoch = this.epoch;
    this.clipboard = this.actions
      .paste()
      .then((value) => {
        if (value === undefined) {
          this.status = 'Could not read the clipboard.';
          return;
        }
        if (epoch !== this.epoch) {
          this.status = 'Field changed; paste again when ready.';
          return;
        }
        this.insert(field, { kind: 'key', key: 'paste', char: value });
      })
      .catch(() => {
        this.status = 'Could not read the clipboard.';
      })
      .finally(() => {
        this.clipboard = undefined;
      });
  }
  private insert(field: ContactField, ev: KeyEvent): void {
    if ((ev.char?.length ?? 0) > 4096) {
      this.status = 'Pasted text is too long for a contact field.';
      return;
    }
    field.handle(ev);
    this.epoch++;
    this.status = '';
  }
  handle(ev: KeyEvent): 'close' | void {
    if (this.pending) return;
    if (ev.key === 'interrupt' || ev.key === 'cut') {
      this.copy(ev.key === 'cut');
      return;
    }
    if (ev.key === 'escape') {
      if (this.draft) this.cancel();
      else return 'close';
      return;
    }
    if (this.tooSmall) return;
    if (!this.draft) {
      if (ev.key === 'up') this.select(-1);
      else if (ev.key === 'down') this.select(1);
      else if (ev.key === 'enter' || (ev.key === 'char' && ev.char === 'e')) this.edit();
      else if (ev.key === 'char' && ev.char === 'r') this.reload();
      else if (ev.key === 'page-down' && this.page.next_offset !== null) this.reload(this.page.next_offset);
      else if (ev.key === 'page-up') this.reload(Math.max(0, this.page.offset - this.page.limit));
      return;
    }
    if (ev.key === 'save') {
      this.save();
      return;
    }
    if (ev.key === 'clipboard-paste') {
      this.paste();
      return;
    }
    if (ev.key === 'tab' || ev.key === 'backtab') {
      this.focus = (this.focus + (ev.key === 'tab' ? 1 : -1) + 2 + this.networks.length) % (2 + this.networks.length);
      this.epoch++;
      return;
    }
    const field = this.field();
    if (field) this.insert(field, ev);
    else if (ev.key === 'char' && ev.char === ' ') this.toggleNetwork(this.focus - 2);
  }
  wheel(delta: -1 | 1): void {
    if (!this.draft && !this.pending) this.select(delta);
  }
  mouse(ev: Mouse): void {
    if (this.pending || ev.button !== 0) return;
    const x = ev.col - 1,
      y = ev.row - 1;
    if (ev.action === 'down') {
      this.dragging = undefined;
      const hit = this.hits.find((h) => h.y === y && x >= h.x && x < h.x + h.w);
      if (!hit) return;
      this.epoch++;
      hit.action();
      if (hit.field) {
        hit.field.cursor = Math.max(0, Math.min(hit.field.chars.length, (hit.from ?? 0) + x - hit.x));
        hit.field.anchor = hit.field.cursor;
        this.dragging = hit;
      }
    } else if (this.dragging?.field) {
      const hit = this.dragging;
      hit.field!.cursor = Math.max(0, Math.min(hit.field!.chars.length, (hit.from ?? 0) + x - hit.x));
      this.epoch++;
      if (ev.action === 'up') this.dragging = undefined;
    }
  }
  draw(frame: Frame, rect: Rect): void {
    this.hits = [];
    const { x, y, w, h } = rect;
    for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) put(frame, x + col, y + row, ' ');
    const write = (row: number, value: string, tone: Tone = 0, col = 0) => {
      if (row >= 0 && row < h)
        text(frame, x + col, y + row, [...pasteText(value)].slice(0, Math.max(0, w - col)).join(''), tone);
    };
    const button = (row: number, col: number, label: string, action: () => void, tone: Tone = 2) => {
      write(row, label, tone, col);
      if (row < h) this.hits.push({ x: x + col, y: y + row, w: Math.min(label.length, w - col), action });
    };
    const wrapped = (row: number, value: string, tone: Tone = 0): number => {
      const chars = [...pasteText(value)];
      for (let at = 0; at < chars.length; at += Math.max(1, w))
        write(row++, chars.slice(at, at + Math.max(1, w)).join(''), tone);
      return row;
    };
    write(0, 'Address book', 2);
    button(1, 0, this.draft ? ' Read ' : '[Read]', () => this.cancel(), this.draft ? 1 : 2);
    button(1, 9, this.draft ? '[Edit]' : ' Edit ', () => this.edit(), this.draft ? 2 : 1);
    this.tooSmall = w < 30 || h < 17;
    if (this.tooSmall) {
      write(3, 'Enlarge terminal to edit contacts.', 1);
      return;
    }
    if (this.draft) {
      const field = (row: number, label: string, value: ContactField, index: number) => {
        write(row, label, this.focus === index ? 2 : 1);
        const from = Math.max(0, value.cursor - w + 2);
        const [a, b] = value.range;
        value.chars
          .slice(from, from + w)
          .forEach((char, i) =>
            put(frame, x + i, y + row + 1, char, this.focus === index && from + i >= a && from + i < b ? 4 : 0),
          );
        if (this.focus === index && a === b)
          put(frame, x + value.cursor - from, y + row + 1, value.chars[value.cursor] ?? ' ', 3);
        this.hits.push({
          x,
          y: y + row + 1,
          w,
          field: value,
          from,
          action: () => {
            this.focus = index;
          },
        });
      };
      field(2, 'Name', this.draft.name, 0);
      field(4, 'Wallet address', this.draft.address, 1);
      write(6, 'Networks', 1);
      this.networks.forEach((network, index) =>
        button(
          7 + index,
          0,
          `${this.draft!.chains.has(network.chain_id) ? '[x]' : '[ ]'} ${network.name}`,
          () => this.toggleNetwork(index),
          this.focus === index + 2 ? 3 : 0,
        ),
      );
      const row = 8 + this.networks.length;
      button(row, 0, '[Save Ctrl-S]', () => this.save());
      button(row, 16, '[Cancel Esc]', () => this.cancel());
      wrapped(row + 1, this.status, 2);
    } else {
      const selected = this.page.contacts[this.selected];
      let row = 3;
      if (selected) {
        row = wrapped(row, selected.name, 2);
        row = wrapped(row, selected.address);
        row = wrapped(
          row,
          selected.chain_ids.map((id) => this.page.networks.find((n) => n.chain_id === id)?.name ?? id).join(', '),
          1,
        );
      } else write(row++, 'No saved contacts yet.', 1);
      row++;
      write(row++, 'CONTACT                       NETWORKS', 1);
      const count = Math.max(1, Math.min(6, h - row - 5));
      const start = Math.max(0, this.selected - count + 1);
      this.page.contacts.slice(start, start + count).forEach((contact, i) => {
        const label =
          [...contact.name].slice(0, 27).join('').padEnd(30) +
          contact.chain_ids.map((id) => this.page.networks.find((n) => n.chain_id === id)?.name ?? id).join(', ');
        button(
          row + i,
          0,
          label,
          () => {
            this.selected = start + i;
          },
          this.selected === start + i ? 3 : 0,
        );
      });
      row += count + 1;
      button(row, 0, '[Prev]', () => this.reload(Math.max(0, this.page.offset - this.page.limit)));
      button(row, 9, '[Next]', () => {
        if (this.page.next_offset !== null) this.reload(this.page.next_offset);
      });
      write(
        row,
        `${this.page.total ? this.page.offset + 1 : 0}–${this.page.offset + this.page.contacts.length} of ${this.page.total}`,
        1,
        18,
      );
      wrapped(row + 1, this.status, 2);
    }
    write(h - 1, 'Existing payment summaries keep their original recipients.', 1);
  }
}
