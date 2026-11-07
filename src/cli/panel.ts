import type { InputEvent, KeyEvent } from './input.js';
import type { Frame, Rect } from './render/frame.js';

/** What a key (or click) did: nothing to report, close the panel, or close it and run a line as if it had been typed. */
export type PanelResult = 'close' | { run: string } | void;

/** A modal command view owns input until it is closed; its keystrokes never reach the payment conversation. */
export interface CliPanel {
  readonly hint: string;
  handle(ev: KeyEvent): PanelResult;
  mouse(ev: Extract<InputEvent, { kind: 'mouse' }>): PanelResult;
  wheel(delta: -1 | 1): void;
  draw(frame: Frame, rect: Rect): void;
  idle(): Promise<void>;
}
