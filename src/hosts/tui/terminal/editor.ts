/**
 * The message being typed, edited the way vim edits a buffer.
 *
 * Insert mode behaves like any shell prompt, so typing just works; Esc drops
 * into normal mode for motions (h l w b e 0 ^ $ f t j k gg G), operators
 * (d c y with a motion, or doubled for the whole line), counts, x s r ~ J p P,
 * and undo. Pure: a key goes in, the next draft comes out, and the terminal
 * decides what to draw.
 */

export type EditMode = 'insert' | 'normal';

/** A keypress as Node's readline reports it. */
export interface Key {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

interface Snapshot { text: string; cursor: number }

export interface Draft {
  text: string;
  /** Index into text; in normal mode always on a character, never past a line's end. */
  cursor: number;
  mode: EditMode;
  /** Keys of a normal-mode command still being typed: a count, an operator, a `g`. */
  pending: string;
  /** What d, c, y and x last took, and whether it was whole lines. */
  register: { text: string; linewise: boolean };
  undo: Snapshot[];
  redo: Snapshot[];
  /** Set while an insert is under way, so the whole insert undoes as one step. */
  inserting: boolean;
}

/** What a key asks of the terminal beyond changing the draft. */
export type EditEvent = 'submit' | 'history-prev' | 'history-next';

export function draftOf(text = ''): Draft {
  return {
    text, cursor: text.length, mode: 'insert', pending: '',
    register: { text: '', linewise: false }, undo: [], redo: [], inserting: false,
  };
}

export function edit(d: Draft, key: Key): { draft: Draft; event?: EditEvent } {
  return d.mode === 'insert' ? insertKey(d, key) : normalKey(d, key);
}

/** The printable character a key carries, if it is one. */
export function charOf(key: Key): string | undefined {
  if (key.ctrl || key.meta) { return undefined; }
  const s = key.sequence ?? '';
  return s.length >= 1 && !/[\x00-\x1f\x7f]/.test(s) && !s.startsWith('\x1b') ? s : undefined;
}

// ---------- insert mode ----------

type Result = { draft: Draft; event?: EditEvent };
type Edit = (d: Draft) => Result;
const just = (f: (d: Draft) => Draft): Edit => (d) => ({ draft: f(d) });

/** A key as the binding tables name it: modifiers, then the key's name ("C-w", "M-left"). */
export function keyId(key: Key): string {
  return `${key.ctrl ? 'C-' : ''}${key.meta ? 'M-' : ''}${key.name ?? ''}`;
}

const wordLeft = just((d) => moveTo(d, wordBack(d.text, d.cursor)));
const wordRight = just((d) => moveTo(d, wordEndForward(d.text, d.cursor)));
const deleteWordBack = just((d) => remove(d, wordBack(d.text, d.cursor), d.cursor));
const newline = just((d) => insertText(d, '\n'));
const toLineStart = just((d) => moveTo(d, lineStart(d.text, d.cursor)));
const toLineEnd = just((d) => moveTo(d, lineEnd(d.text, d.cursor)));

/** Insert mode's keys beyond typing, shell-style. */
const INSERT_KEYS: Record<string, Edit> = {
  'return': submitOrContinue,
  'enter': newline,
  'M-return': newline,
  // A terminal reports a lone Esc with the meta flag set, since Esc is also what Alt sends.
  'escape': just(toNormal),
  'M-escape': just(toNormal),
  'backspace': just((d) => remove(d, d.cursor - 1, d.cursor)),
  'M-backspace': deleteWordBack,
  'C-w': deleteWordBack,
  'delete': just((d) => remove(d, d.cursor, d.cursor + 1)),
  'C-u': just((d) => remove(d, lineStart(d.text, d.cursor), d.cursor)),
  'C-k': just((d) => remove(d, d.cursor, lineEnd(d.text, d.cursor))),
  'left': just((d) => moveTo(d, d.cursor - 1)),
  'right': just((d) => moveTo(d, d.cursor + 1)),
  'C-left': wordLeft, 'M-left': wordLeft, 'M-b': wordLeft,
  'C-right': wordRight, 'M-right': wordRight, 'M-f': wordRight,
  'home': toLineStart, 'C-a': toLineStart,
  'end': toLineEnd, 'C-e': toLineEnd,
  'up': (d) => verticalOrHistory(d, -1),
  'down': (d) => verticalOrHistory(d, 1),
};

function insertKey(d: Draft, key: Key): Result {
  const ch = charOf(key);
  if (ch !== undefined) { return { draft: insertText(d, ch) }; }
  return INSERT_KEYS[keyId(key)]?.(d) ?? { draft: d };
}

/** Enter sends, unless the line ends in a backslash: that continues it on a new line, as in a shell. */
function submitOrContinue(d: Draft): Result {
  if (d.text[d.cursor - 1] !== '\\' || d.cursor !== lineEnd(d.text, d.cursor)) { return { draft: d, event: 'submit' }; }
  const unslashed = { ...d, text: d.text.slice(0, d.cursor - 1) + d.text.slice(d.cursor), cursor: d.cursor - 1 };
  return { draft: insertText(unslashed, '\n') };
}

/** Inserted text; the first change of an insert records where undo returns to. */
export function insertText(d: Draft, s: string): Draft {
  const base = d.inserting ? d : { ...withUndo(d), inserting: true };
  return { ...base, text: base.text.slice(0, base.cursor) + s + base.text.slice(base.cursor), cursor: base.cursor + s.length };
}

function remove(d: Draft, from: number, to: number): Draft {
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(d.text.length, Math.max(from, to));
  if (a === b) { return d; }
  const base = d.inserting ? d : { ...withUndo(d), inserting: true };
  return { ...base, text: base.text.slice(0, a) + base.text.slice(b), cursor: a };
}

function toNormal(d: Draft): Draft {
  const back = d.cursor > lineStart(d.text, d.cursor) ? d.cursor - 1 : d.cursor;
  return clampNormal({ ...d, mode: 'normal', pending: '', inserting: false, cursor: back });
}

// ---------- normal mode ----------

function normalKey(d: Draft, key: Key): Result {
  if (key.name === 'escape') { return { draft: { ...d, pending: '' } }; }
  if (key.name === 'return') { return { draft: { ...d, pending: '' }, event: 'submit' }; }
  if (key.ctrl && key.name === 'r') { return { draft: redo(d) }; }
  const nav = arrowKey(key);
  const ch = nav ?? charOf(key);
  if (ch === undefined) { return { draft: d }; }
  return command(d, d.pending + ch);
}

/** Arrows and Home/End mean the same in normal mode as their vim keys. */
function arrowKey(key: Key): string | undefined {
  return ({ left: 'h', right: 'l', up: 'k', down: 'j', home: '0', end: '$', backspace: 'h', delete: 'x' } as Record<string, string>)[key.name ?? ''];
}

/**
 * Parses the pending keys as `[count] [operator [count]] motion` or a
 * standalone command, and runs it once complete.
 */
function command(d: Draft, keys: string): { draft: Draft; event?: EditEvent } {
  const m = /^(\d*)([dcy]?)(\d*)(.*)$/.exec(keys)!;
  const [, c1, op, c2, rest] = m;
  if (c1 === '0' && !op && !rest) { return motionOnly(d, '0', 1); }
  if (!rest) { return { draft: { ...d, pending: keys } }; }
  const count = (Number(c1) || 1) * (Number(c2) || 1);

  if (op) { return { draft: operate(d, op, rest, count) }; }
  const simple = standalone(d, rest, count);
  if (simple) { return simple; }
  return motionOnly(d, rest, count);
}

function motionOnly(d: Draft, keys: string, count: number): { draft: Draft; event?: EditEvent } {
  if (keys === 'j' || keys === 'k') {
    const moved = vertical(d, keys === 'j' ? count : -count);
    if (moved === undefined) { return { draft: { ...d, pending: '' }, event: keys === 'j' ? 'history-next' : 'history-prev' }; }
    return { draft: clampNormal({ ...d, cursor: moved, pending: '' }) };
  }
  const target = motion(d.text, d.cursor, keys, count);
  if (target === 'more') { return { draft: { ...d, pending: keys } }; }
  if (target === undefined) { return { draft: { ...d, pending: '' } }; }
  return { draft: clampNormal({ ...d, cursor: target.to, pending: '' }) };
}

/** Commands that are not a motion and take no operator; `r` waits for the character to put. */
function standalone(d: Draft, keys: string, count: number): Result | undefined {
  if (keys === 'r') { return { draft: { ...d, pending: 'r' } }; }
  if (keys.length === 2 && keys[0] === 'r') { return { draft: replaceChar(d, keys[1]) }; }
  const run = COMMANDS[keys];
  return run && { draft: run(d, count) };
}

type Command = (d: Draft, count: number) => Draft;

/** Leaves normal mode with the cursor at `at`, starting a fresh undo step. */
const insertAt = (at: (d: Draft) => number): Command => (d) => ({ ...d, mode: 'insert', cursor: at(d), pending: '', inserting: false });
/** An operator and motion a single key stands for: x is dl, D is d$. */
const shorthand = (op: string, keys: string, counted = true): Command => (d, count) => operate(d, op, keys, counted ? count : 1);

const COMMANDS: Record<string, Command> = {
  i: insertAt((d) => d.cursor),
  a: insertAt((d) => Math.min(d.cursor + 1, lineEnd(d.text, d.cursor))),
  I: insertAt((d) => firstNonBlank(d.text, lineStart(d.text, d.cursor))),
  A: insertAt((d) => lineEnd(d.text, d.cursor)),
  o: (d) => ({ ...insertText({ ...d, cursor: lineEnd(d.text, d.cursor), inserting: false }, '\n'), mode: 'insert', pending: '' }),
  O: (d) => {
    const ls = lineStart(d.text, d.cursor);
    return { ...insertText({ ...d, cursor: ls, inserting: false }, '\n'), cursor: ls, mode: 'insert', pending: '' };
  },
  x: shorthand('d', 'l'),
  X: shorthand('d', 'h'),
  s: shorthand('c', 'l'),
  S: shorthand('c', 'c', false),
  D: shorthand('d', '$', false),
  C: shorthand('c', '$', false),
  Y: shorthand('y', 'y'),
  u: (d) => undo(d),
  p: (d, count) => paste(d, false, count),
  P: (d, count) => paste(d, true, count),
  '~': toggleCase,
  J: joinLines,
};

function replaceChar(d: Draft, ch: string): Draft {
  if (d.cursor >= lineEnd(d.text, d.cursor)) { return { ...d, pending: '' }; }
  return clampNormal({ ...withUndo(d), text: d.text.slice(0, d.cursor) + ch + d.text.slice(d.cursor + 1), pending: '' });
}

function toggleCase(d: Draft, count: number): Draft {
  const end = Math.min(d.cursor + count, lineEnd(d.text, d.cursor));
  const flipped = [...d.text.slice(d.cursor, end)].map((x) => (x === x.toUpperCase() ? x.toLowerCase() : x.toUpperCase())).join('');
  return clampNormal({ ...withUndo(d), text: d.text.slice(0, d.cursor) + flipped + d.text.slice(end), cursor: end, pending: '' });
}

/** J: the next line joins this one, one space between. */
function joinLines(d: Draft): Draft {
  const le = lineEnd(d.text, d.cursor);
  if (le >= d.text.length) { return { ...d, pending: '' }; }
  const next = firstNonBlank(d.text, le + 1);
  return clampNormal({ ...withUndo(d), text: d.text.slice(0, le).trimEnd() + ' ' + d.text.slice(next), cursor: le, pending: '' });
}

/** An operator over a motion, or over whole lines when doubled (dd, cc, yy). */
function operate(d: Draft, op: string, keys: string, count: number): Draft {
  const t = d.text;
  if (keys === op) { return operateLines(d, op, count); }
  if (keys === 'j' || keys === 'k') { return operateLines(d, op, count + 1, keys === 'k' ? -count : 0); }
  const target = operatorTarget(t, d.cursor, op, keys, count);
  if (target === 'more') { return { ...d, pending: op + keys }; }
  if (target === undefined) { return { ...d, pending: '' }; }

  const from = Math.min(d.cursor, target.to);
  const to = Math.min(t.length, Math.max(d.cursor, target.to) + (target.inclusive ? 1 : 0));
  const taken = t.slice(from, to);
  const register = { text: taken, linewise: false };
  if (op === 'y') { return clampNormal({ ...d, register, cursor: from, pending: '' }); }

  const next = { ...withUndo(d), text: t.slice(0, from) + t.slice(to), cursor: from, register, pending: '' };
  return op === 'c' ? { ...next, mode: 'insert', inserting: true } : clampNormal(next);
}

/**
 * A motion as an operator reads it. cw changes to the end of the word under
 * the cursor rather than eating the space after it, and a word motion stops
 * at the end of the line instead of joining the next one, as in vim.
 */
function operatorTarget(t: string, c: number, op: string, keys: string, count: number): Target | 'more' | undefined {
  if (op === 'c' && (keys === 'w' || keys === 'W') && cls(t[c], keys === 'W')) {
    let to = sameClassEnd(t, c, keys === 'W');
    for (let i = 1; i < count; i++) { to = wordEnd(t, to, keys === 'W'); }
    return { to, inclusive: true };
  }
  const target = motion(t, c, keys, count);
  if (target && target !== 'more' && (keys === 'w' || keys === 'W') && target.to > lineEnd(t, c)) {
    return { to: lineEnd(t, c), inclusive: false };
  }
  return target;
}

/** The last character of the run of one class the cursor is in. */
function sameClassEnd(t: string, c: number, big: boolean): number {
  let i = c;
  const k = cls(t[c], big);
  while (i + 1 < t.length && cls(t[i + 1], big) === k) { i++; }
  return i;
}

/** dd, cc, yy and their counts; `shift` starts the range above the cursor (dk). */
function operateLines(d: Draft, op: string, count: number, shift = 0): Draft {
  const range = lineRange(d, count, shift);
  const register = { text: range.lines.slice(range.first, range.last + 1).join('\n'), linewise: true };
  if (op === 'y') { return { ...d, register, pending: '' }; }
  // cc leaves one empty line to type into; dd takes the lines away.
  const kept = [...range.lines.slice(0, range.first), ...(op === 'c' ? [''] : []), ...range.lines.slice(range.last + 1)];
  const text = kept.join('\n');
  const row = Math.min(range.first, Math.max(0, kept.length - 1));
  if (op === 'c') {
    return { ...withUndo(d), text, cursor: offsetOfRow(text, row), register, mode: 'insert', inserting: true, pending: '' };
  }
  return clampNormal({ ...withUndo(d), text, cursor: firstNonBlank(text, offsetOfRow(text, row)), register, pending: '' });
}

/** The draft's lines, and the first and last of the `count` a line operator covers. */
function lineRange(d: Draft, count: number, shift: number): { lines: string[]; first: number; last: number } {
  const lines = d.text.split('\n');
  const first = Math.max(0, rowOf(d.text, d.cursor) + shift);
  return { lines, first, last: Math.min(lines.length - 1, first + count - 1) };
}

function paste(d: Draft, before: boolean, count: number): Draft {
  const { text: reg, linewise } = d.register;
  if (!reg) { return { ...d, pending: '' }; }
  const t = d.text;
  const body = Array(count).fill(reg).join(linewise ? '\n' : '');
  if (linewise) {
    const at = before ? lineStart(t, d.cursor) : lineEnd(t, d.cursor);
    const text = before ? t.slice(0, at) + body + '\n' + t.slice(at) : t.slice(0, at) + '\n' + body + t.slice(at);
    const start = before ? at : at + 1;
    return clampNormal({ ...withUndo(d), text, cursor: firstNonBlank(text, start), pending: '' });
  }
  const at = before || !t.length ? d.cursor : Math.min(d.cursor + 1, t.length);
  const text = t.slice(0, at) + body + t.slice(at);
  return clampNormal({ ...withUndo(d), text, cursor: at + body.length - 1, pending: '' });
}

// ---------- motions ----------

interface Target { to: number; inclusive: boolean }

/** Where a motion lands, 'more' when it needs another key (f, g), or undefined when it has nowhere to go. */
export function motion(t: string, c: number, keys: string, count: number): Target | 'more' | undefined {
  const m = MOTIONS[keys];
  if (m) { return m(t, c, count); }
  if (keys.length === 2 && 'fFtT'.includes(keys[0])) { return findInLine(t, c, keys[0], keys[1], count); }
  return undefined;
}

type Motion = (t: string, c: number, count: number) => Target | 'more';

const exclusive = (to: number): Target => ({ to, inclusive: false });
/** A word motion taken `count` times. */
const words = (step: (t: string, at: number, big: boolean) => number, big: boolean, inclusive: boolean): Motion => (t, c, count) => {
  let at = c;
  for (let i = 0; i < count; i++) { at = step(t, at, big); }
  return { to: at, inclusive };
};
const needsMore: Motion = () => 'more';

const MOTIONS: Record<string, Motion> = {
  h: (t, c, n) => exclusive(Math.max(lineStart(t, c), c - n)),
  l: (t, c, n) => exclusive(Math.min(lineEnd(t, c), c + n)),
  '0': (t, c) => exclusive(lineStart(t, c)),
  '^': (t, c) => exclusive(firstNonBlank(t, lineStart(t, c))),
  $: (t, c) => (lineEnd(t, c) > lineStart(t, c) ? { to: lineEnd(t, c) - 1, inclusive: true } : exclusive(c)),
  w: words(wordForward, false, false),
  W: words(wordForward, true, false),
  b: words(wordBack, false, false),
  B: words(wordBack, true, false),
  e: words(wordEnd, false, true),
  E: words(wordEnd, true, true),
  G: (t) => exclusive(firstNonBlank(t, lineStart(t, t.length))),
  gg: (t) => exclusive(firstNonBlank(t, 0)),
  g: needsMore, f: needsMore, F: needsMore, t: needsMore, T: needsMore,
};

/**
 * f and t find `ch` forward on the line, F and T backward; t and T stop one
 * short of it. A till motion starts looking one further on, so it does not
 * find the character it is already beside.
 */
function findInLine(t: string, c: number, kind: string, ch: string, count: number): Target | undefined {
  const step = kind === 'f' || kind === 't' ? 1 : -1;
  const till = kind === 't' || kind === 'T';
  const lo = lineStart(t, c);
  const hi = lineEnd(t, c);
  let found = 0;
  for (let i = c + step * (till ? 2 : 1); i >= lo && i < hi; i += step) {
    if (t[i] === ch && ++found === count) { return { to: till ? i - step : i, inclusive: step === 1 }; }
  }
  return undefined;
}

type Cls = 0 | 1 | 2;
/** 0 blank, 1 word character, 2 punctuation; a WORD (big) treats 1 and 2 alike. */
function cls(ch: string | undefined, big: boolean): Cls {
  if (ch === undefined || /\s/.test(ch)) { return 0; }
  if (big) { return 1; }
  return /[\p{L}\p{N}_]/u.test(ch) ? 1 : 2;
}

function wordForward(t: string, c: number, big = false): number {
  let i = c;
  const start = cls(t[i], big);
  if (start) { while (i < t.length && cls(t[i], big) === start) { i++; } }
  while (i < t.length && !cls(t[i], big)) { i++; }
  return i;
}

export function wordBack(t: string, c: number, big = false): number {
  let i = c - 1;
  while (i > 0 && !cls(t[i], big)) { i--; }
  const k = cls(t[i], big);
  while (i > 0 && cls(t[i - 1], big) === k && k) { i--; }
  return Math.max(0, i);
}

function wordEnd(t: string, c: number, big = false): number {
  let i = c + 1;
  while (i < t.length && !cls(t[i], big)) { i++; }
  const k = cls(t[i], big);
  while (i + 1 < t.length && cls(t[i + 1], big) === k) { i++; }
  return Math.min(i, Math.max(0, t.length - 1));
}

/** Just past the end of the next word, for Alt+F in insert mode. */
function wordEndForward(t: string, c: number): number {
  let i = c;
  while (i < t.length && !cls(t[i], false)) { i++; }
  const k = cls(t[i], false);
  while (i < t.length && cls(t[i], false) === k && k) { i++; }
  return i;
}

// ---------- lines ----------

export function lineStart(t: string, c: number): number {
  return t.lastIndexOf('\n', c - 1) + 1;
}

export function lineEnd(t: string, c: number): number {
  const n = t.indexOf('\n', c);
  return n < 0 ? t.length : n;
}

function firstNonBlank(t: string, from: number): number {
  let i = from;
  while (i < t.length && (t[i] === ' ' || t[i] === '\t')) { i++; }
  return i;
}

function rowOf(t: string, c: number): number {
  return t.slice(0, c).split('\n').length - 1;
}

function offsetOfRow(t: string, row: number): number {
  let at = 0;
  for (let r = 0; r < row; r++) {
    const n = t.indexOf('\n', at);
    if (n < 0) { return t.length; }
    at = n + 1;
  }
  return at;
}

/** The same column `rows` lines away, or undefined when that is past the first or last line. */
function vertical(d: Draft, rows: number): number | undefined {
  const t = d.text;
  const row = rowOf(t, d.cursor) + rows;
  const total = t.split('\n').length;
  if (row < 0 || row >= total) { return undefined; }
  const col = d.cursor - lineStart(t, d.cursor);
  const start = offsetOfRow(t, row);
  return Math.min(start + col, lineEnd(t, start));
}

function verticalOrHistory(d: Draft, rows: number): { draft: Draft; event?: EditEvent } {
  const moved = vertical(d, rows);
  if (moved === undefined) { return { draft: d, event: rows < 0 ? 'history-prev' : 'history-next' }; }
  return { draft: { ...d, cursor: moved } };
}

function moveTo(d: Draft, at: number): Draft {
  return { ...d, cursor: Math.max(0, Math.min(d.text.length, at)), inserting: false };
}

/** Normal mode sits on a character: never past the last one of a non-empty line. */
function clampNormal(d: Draft): Draft {
  if (d.mode !== 'normal') { return d; }
  const c = Math.max(0, Math.min(d.cursor, d.text.length));
  const ls = lineStart(d.text, c);
  const le = lineEnd(d.text, c);
  return { ...d, cursor: le > ls ? Math.min(c, le - 1) : ls };
}

// ---------- undo ----------

function withUndo(d: Draft): Draft {
  return { ...d, undo: [...d.undo.slice(-99), { text: d.text, cursor: d.cursor }], redo: [] };
}

function undo(d: Draft): Draft {
  const last = d.undo[d.undo.length - 1];
  if (!last) { return { ...d, pending: '' }; }
  return clampNormal({
    ...d, text: last.text, cursor: last.cursor, pending: '',
    undo: d.undo.slice(0, -1), redo: [...d.redo, { text: d.text, cursor: d.cursor }],
  });
}

function redo(d: Draft): Draft {
  const next = d.redo[d.redo.length - 1];
  if (!next) { return d; }
  return clampNormal({
    ...d, text: next.text, cursor: next.cursor, pending: '',
    redo: d.redo.slice(0, -1), undo: [...d.undo, { text: d.text, cursor: d.cursor }],
  });
}
