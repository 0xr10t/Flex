import type { InputEvent, KeyEvent } from './input.js';
import type { Frame, Rect } from './render/frame.js';

/** A modal command view owns input until it is closed; its keystrokes never reach the payment conversation. */
export interface CliPanel {
  readonly hint: string;
  handle(ev: KeyEvent): 'close' | void;
  mouse(ev: Extract<InputEvent, { kind: 'mouse' }>): void;
  wheel(delta: -1 | 1): void;
  draw(frame: Frame, rect: Rect): void;
  idle(): Promise<void>;
}
