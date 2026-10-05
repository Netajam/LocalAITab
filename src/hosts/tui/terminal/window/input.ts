import { emitKeypressEvents, Interface } from 'readline';
import { PassThrough } from 'stream';
import { StringDecoder } from 'string_decoder';
import type { Key } from '../editor';

/**
 * Keys, wheel turns and clicks from a raw terminal.
 *
 * With mouse reporting on, the terminal interleaves `ESC [ < b ; x ; y M`
 * reports with the keys. Node's key decoder does not know them and would
 * hand their digits over as typing, so they are taken out of the stream
 * first, and what is left is decoded as keys.
 */

/** An SGR mouse report: button code, column, row, press (M) or release (m). */
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;

/** A wheel turn (+1 back in the conversation, -1 forward), or a left click at a 1-based column and row. */
export type Mouse = { kind: 'wheel'; direction: 1 | -1 } | { kind: 'click'; col: number; row: number };
/** The start of a report cut off at the end of a chunk; kept for the next one. */
const PARTIAL = /\x1b(\[(<[\d;]*)?)?$/;

export interface Input {
  stop(): void;
}

/** Starts reading `stdin` in raw mode. Releases, drags and other buttons are ignored. */
export function startInput(onKey: (key: Key) => void, onMouse: (event: Mouse) => void): Input {
  const keys = new PassThrough();
  // A short escape timeout keeps Esc into normal mode from lagging.
  emitKeypressEvents(keys, { escapeCodeTimeout: 25 } as unknown as Interface);
  keys.on('keypress', (sequence: string | undefined, key: Key | undefined) => onKey(key ?? { sequence }));

  const decoder = new StringDecoder('utf8');
  let carry = '';
  const onData = (chunk: Buffer) => {
    const { rest, mouse, pending } = takeMouse(carry + decoder.write(chunk));
    carry = pending;
    for (const event of mouse) { onMouse(event); }
    if (rest) { keys.write(rest); }
  };

  process.stdin.setRawMode(true);
  process.stdin.on('data', onData);
  process.stdin.resume();
  return {
    stop() {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      keys.end();
    },
  };
}

/** One report as an event: 64 and 65 are the wheel, 0 the left button; 4, 8 and 16 add Shift, Alt and Ctrl. */
function decode(code: number, col: number, row: number, press: boolean): Mouse | undefined {
  const button = code & ~(4 | 8 | 16);
  if (button === 64 || button === 65) { return { kind: 'wheel', direction: button === 64 ? 1 : -1 }; }
  return button === 0 && press ? { kind: 'click', col, row } : undefined;
}

/**
 * Splits mouse reports from the rest of `text`. A report cut off at the end
 * is held back as `pending`, unless it can only be a plain Esc key.
 */
export function takeMouse(text: string): { rest: string; mouse: Mouse[]; pending: string } {
  const mouse: Mouse[] = [];
  const rest = text.replace(MOUSE, (_, code: string, col: string, row: string, end: string) => {
    const event = decode(Number(code), Number(col), Number(row), end === 'M');
    if (event) { mouse.push(event); }
    return '';
  });
  const cut = PARTIAL.exec(rest);
  // A lone ESC at the end is the Esc key far more often than half a report.
  if (!cut || cut[0] === '\x1b' || cut[0] === '\x1b[') { return { rest, mouse, pending: '' }; }
  return { rest: rest.slice(0, cut.index), mouse, pending: cut[0] };
}
