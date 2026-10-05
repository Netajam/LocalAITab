import { score } from './finder';

/**
 * What completes where the cursor is, and the suggestion shown after it.
 *
 * Three places complete: the /command at the start of a message, its
 * argument, and an @path anywhere. Pure, so the rules can be tested; the
 * terminal fetches what an argument offers and draws the result.
 */

/** A command as completion needs it; terminal.ts's Command has this shape. */
export interface Completable {
  name: string;
  hint: string;
  /** What its argument offers: a folder on disk, or a list the session supplies. */
  args?: 'folders' | (() => Promise<ArgChoice[]>);
  /** Shown dimmed where the argument goes, until something is typed there. */
  placeholder?: string;
}

/** One thing an argument can be: `value` is what goes in, `label` what is shown and matched, if it differs. */
export interface ArgChoice { value: string; label?: string; hint?: string }

export type TokenKind = 'commands' | 'args' | 'folders' | 'files';

export interface Token {
  kind: TokenKind;
  /** The span text[start, end) a completion replaces; `query` is what is typed of it. */
  start: number;
  end: number;
  query: string;
  /** For an argument, the command it belongs to. */
  command?: Completable;
}

/** The completion under the cursor, if any. Only a single-line message completes commands. */
export function tokenAt(text: string, cursor: number, commands: Completable[]): Token | undefined {
  const cmd = /^\/(\S*)/.exec(text);
  if (cmd && !text.includes('\n')) {
    if (cursor <= cmd[0].length) { return { kind: 'commands', start: 0, end: cmd[0].length, query: cmd[1].slice(0, Math.max(0, cursor - 1)) }; }
    const arg = argToken(text, cursor, commands.find((c) => c.name === cmd[1]), cmd[0].length);
    if (arg) { return arg; }
  }
  return mentionToken(text, cursor);
}

function argToken(text: string, cursor: number, command: Completable | undefined, nameEnd: number): Token | undefined {
  if (!command?.args) { return undefined; }
  let start = nameEnd;
  while (text[start] === ' ') { start++; }
  if (cursor < start || start === nameEnd) { return undefined; }
  return { kind: command.args === 'folders' ? 'folders' : 'args', start, end: text.length, query: text.slice(start, cursor), command };
}

function mentionToken(text: string, cursor: number): Token | undefined {
  let s = cursor;
  while (s > 0 && !/\s/.test(text[s - 1])) { s--; }
  if (text[s] !== '@') { return undefined; }
  let e = cursor;
  while (e < text.length && !/\s/.test(text[e])) { e++; }
  return { kind: 'files', start: s, end: e, query: text.slice(s + 1, cursor).replace(/^"/, '') };
}

export interface Suggestion {
  value: string;
  label: string;
  positions: number[];
  hint?: string;
}

/** Commands ranked against what is typed of the name; all of them, in order, before anything is. */
export function rankCommands(query: string, commands: Completable[]): Suggestion[] {
  return rankBy(query, commands, (c) => c.name).map(({ item: c, positions }) => ({
    value: '/' + c.name, label: '/' + c.name, positions: positions.map((p) => p + 1), hint: c.hint,
  }));
}

/** An argument's choices ranked against what is typed of it, by what they show. */
export function rankChoices(query: string, choices: ArgChoice[]): Suggestion[] {
  return rankBy(query, choices, (c) => c.label ?? c.value).map(({ item: c, positions }) => ({
    value: c.value, label: c.label ?? c.value, positions, hint: c.hint,
  }));
}

function rankBy<T>(query: string, items: T[], key: (t: T) => string): Array<{ item: T; positions: number[] }> {
  if (!query) { return items.map((item) => ({ item, positions: [] })); }
  return items
    .map((item) => ({ item, m: score(query, key(item)) }))
    .filter((x): x is { item: T; m: NonNullable<typeof x.m> } => x.m !== undefined)
    .sort((a, b) => b.m.score - a.m.score)
    .map(({ item, m }) => ({ item, positions: m.positions }));
}

/** Dimmed text after the cursor. `accept` is false for a placeholder, which only describes. */
export interface Ghost { text: string; accept: boolean }

/**
 * What to show after the cursor, fish-style: the rest of the completion that
 * would be accepted, else the rest of the latest earlier message that starts
 * with what is typed, else a command's argument placeholder. Only with the
 * cursor at the end of a one-line message.
 */
export function ghostFor(text: string, cursor: number, completion: string | undefined, history: string[], commands: Completable[]): Ghost | undefined {
  if (!text || cursor !== text.length || text.includes('\n')) { return undefined; }
  if (completion !== undefined) { return extension(text, completion); }
  return fromHistory(text, history) ?? placeholder(text, commands);
}

/** The rest of `full`, when it carries on from `text`. */
function extension(text: string, full: string): Ghost | undefined {
  return full.length > text.length && full.startsWith(text) ? { text: full.slice(text.length), accept: true } : undefined;
}

function fromHistory(text: string, history: string[]): Ghost | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const found = !history[i].includes('\n') && extension(text, history[i]);
    if (found) { return found; }
  }
  return undefined;
}

/** `/name ` with nothing after it yet: what the command's argument is for. */
function placeholder(text: string, commands: Completable[]): Ghost | undefined {
  const bare = /^\/(\S+) $/.exec(text);
  const hint = bare && commands.find((c) => c.name === bare[1])?.placeholder;
  return hint ? { text: hint, accept: false } : undefined;
}

/** The first word of a suggestion, with the spaces before it: what Alt+→ takes. */
export function firstWord(ghost: string): string {
  return /^\s*\S+/.exec(ghost)?.[0] ?? ghost;
}
