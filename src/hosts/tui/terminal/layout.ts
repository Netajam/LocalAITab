import { visibleWidth, charWidth, truncate, dim, cyan, magenta, bold, inverse } from '../render';

/**
 * The live area at the bottom of the terminal, as rows of text: pure, so what
 * the prompt looks like can be worked out (and tested) without a terminal.
 * Everything the conversation prints scrolls by above it.
 */

export interface PopupItem {
  label: string;
  /** Indexes into label to highlight, for fuzzy matches. */
  positions?: number[];
  hint?: string;
}

export interface LiveView {
  width: number;
  /** Rows the whole area may take; the input and popup give way first. */
  height: number;
  /** An answer still streaming in, already styled; its last rows show above the rule. */
  preview?: string[];
  /** Carried in the rule above the input, such as where the conversation is scrolled to. */
  note?: string;
  status?: string;
  question?: string;
  /** `ghost` is drawn dimmed after the text, where the cursor is. */
  input?: { prompt: string; text: string; cursor: number; ghost?: string };
  popup?: { items: PopupItem[]; selected: number; empty?: string };
  footer: string[];
}

export interface Laid {
  rows: string[];
  /** Where the terminal cursor goes; none while nothing is being typed. */
  cursor?: { row: number; col: number };
}

const MAX_INPUT_ROWS = 10;

export function layout(v: LiveView): Laid {
  const w = Math.max(20, v.width - 1);
  const footerRows = v.footer.map((f) => truncate(f, w));
  const rows: string[] = [...previewRows(v, w, footerRows.length), rule(v.note, w)];
  let cursor: Laid['cursor'];

  if (v.status) { rows.push(truncate(v.status, w)); }
  if (v.question) { rows.push(truncate(v.question, w)); }

  const room = Math.max(1, v.height - rows.length - footerRows.length);
  if (v.input) {
    const popupWant = v.popup ? Math.max(1, v.popup.items.length) : 0;
    const inputRoom = Math.max(1, Math.min(MAX_INPUT_ROWS, room - Math.min(popupWant, 3)));
    const wrapped = wrapInput(v.input.prompt, v.input.text, v.input.cursor, w, v.input.ghost);
    // Keep the cursor's row in view when the draft is taller than the room for it.
    const first = Math.max(0, Math.min(wrapped.cursorRow - inputRoom + 1, wrapped.rows.length - inputRoom));
    const shown = wrapped.rows.slice(first, first + inputRoom);
    cursor = { row: rows.length + wrapped.cursorRow - first, col: wrapped.cursorCol };
    rows.push(...shown);
    if (v.popup) { rows.push(...popupRows(v.popup, w, Math.max(1, room - shown.length))); }
  }
  rows.push(...footerRows);
  return { rows, cursor };
}

/** The rule above the input, carrying `note` when there is one. */
function rule(note: string | undefined, width: number): string {
  if (!note) { return dim('─'.repeat(width)); }
  return dim('── ') + truncate(note, width - 4) + ' ' + dim('─'.repeat(Math.max(0, width - visibleWidth(note) - 4)));
}

/** The tail of a streaming answer that fits above everything else. */
function previewRows(v: LiveView, w: number, footer: number): string[] {
  if (!v.preview?.length) { return []; }
  const room = Math.max(1, v.height - footer - 3);
  return v.preview.slice(-room).map((l) => truncate(l, w));
}

function popupRows(p: NonNullable<LiveView['popup']>, w: number, max: number): string[] {
  if (!p.items.length) { return [dim(`  ${p.empty ?? 'no matches'}`)]; }
  // Scroll the list so the selection stays visible.
  const first = Math.max(0, Math.min(p.selected - max + 1, p.items.length - max));
  return p.items.slice(first, first + max).map((item, i) => {
    const on = first + i === p.selected;
    const label = highlight(item.label, item.positions ?? []);
    const hint = item.hint ? '  ' + dim(item.hint) : '';
    const line = truncate(`${on ? cyan('❯') : ' '} ${label}${hint}`, w);
    return on ? bold(line) : line;
  });
}

function highlight(label: string, positions: number[]): string {
  if (!positions.length) { return label; }
  const at = new Set(positions);
  return [...label].map((ch, i) => (at.has(i) ? cyan(ch) : ch)).join('');
}

/**
 * The draft wrapped to the width, the prompt on its first row and an indent
 * of the same width on the rest, with the row and column the cursor is at.
 */
export function wrapInput(prompt: string, text: string, cursor: number, width: number, ghost = '') {
  const indent = visibleWidth(prompt);
  const full = text + ghost;
  const { at, rows: textRows } = placement(full, Math.max(4, width - indent));
  const style = styles(text);
  const count = Math.max(textRows, at[cursor].row + 1);
  const rows = Array.from({ length: count }, (_, r) => (r ? ' '.repeat(indent) : prompt));
  for (let i = 0; i < full.length; i++) {
    const paint = i >= text.length ? dim : style[i];
    if (full[i] !== '\n') { rows[at[i].row] += paint ? paint(full[i]) : full[i]; }
  }
  return { rows, cursorRow: at[cursor].row, cursorCol: indent + at[cursor].col };
}

/**
 * Where each character lands when `text` wraps at `room` columns, and where
 * a cursor after the last one goes: past a full row, that is the next row.
 * `rows` is what the text itself takes.
 */
function placement(text: string, room: number): { at: Array<{ row: number; col: number }>; rows: number } {
  const at: Array<{ row: number; col: number }> = [];
  let row = 0;
  let col = 0;
  for (const ch of text) {
    if (ch === '\n') { at.push({ row, col }); row++; col = 0; continue; }
    const w = charWidth(ch);
    if (col + w > room) { row++; col = 0; }
    at.push({ row, col });
    col += w;
  }
  const rows = row + 1;
  if (col >= room) { row++; col = 0; }
  at.push({ row, col });
  return { at, rows };
}

/** @mentions in cyan, a leading /command in magenta; one style per character. */
function styles(text: string): Array<((s: string) => string) | undefined> {
  const out: Array<((s: string) => string) | undefined> = new Array(text.length);
  const command = /^\/\S*/.exec(text);
  if (command) { for (let i = 0; i < command[0].length; i++) { out[i] = magenta; } }
  for (const m of text.matchAll(/(^|\s)(@("[^"]*"?|\S*))/g)) {
    const start = m.index! + m[1].length;
    for (let i = start; i < start + m[2].length; i++) { out[i] = cyan; }
  }
  return out;
}

/** Shortcuts as rows that fit `width`: keys bold, what they do dim, never split across rows. */
export function shortcuts(items: Array<[string, string]>, width: number): string[] {
  const sep = dim('  ·  ');
  const rows: string[] = [];
  let row = '';
  for (const [k, what] of items) {
    const item = `${bold(k)} ${dim(what)}`;
    if (row && visibleWidth(' ' + row + sep + item) > width - 1) { rows.push(' ' + row); row = item; }
    else { row = row ? row + sep + item : item; }
  }
  if (row) { rows.push(' ' + row); }
  return rows;
}

/** A label on a coloured block, for the mode in the footer. */
export function badge(text: string, colour: (s: string) => string): string {
  return colour(inverse(` ${text} `));
}
