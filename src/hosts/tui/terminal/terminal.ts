import * as os from 'os';
import { Draft, Key, draftOf, edit, insertText, charOf, keyId } from './editor';
import { Entry, indexPaths, rank, browse, browsesDisk } from './finder';
import { Token, TokenKind, Suggestion, Ghost, ArgChoice, tokenAt, rankCommands, rankChoices, ghostFor, firstWord } from './complete';
import { loadHistory, saveHistory } from './history';
import { layout, wrapInput, shortcuts, badge, LiveView } from './layout';
import { LineTerminal } from './line';
import { Screen } from './window/screen';
import { mentions, mentionOf } from '../context';
import { bold, dim, cyan, green, yellow } from '../render';

/**
 * The terminal a session talks through: output scrolls by above a live area
 * at the bottom that holds the prompt, the @-file and /-command popups, and a
 * footer with the mode and the shortcuts that apply right now.
 */
export interface Terminal {
  readonly width: number;
  /**
   * Prints above the live area. `mark` makes its first line a point to jump
   * to: a user message or the start of a reply. Output right after a message
   * is sent is marked as the reply on its own.
   */
  print(text: string, mark?: 'user' | 'agent'): void;
  /** A line under the output while a run works; none clears it. */
  status(text?: string): void;
  /** An answer as it streams in, already styled; none clears it. Only the rows that fit show. */
  preview(lines?: string[]): void;
  /** The next message, or undefined when the user leaves. The prompt shows the mode from setInfo. */
  read(): Promise<string | undefined>;
  /** One of the choices' keys, or undefined when declined, dismissed or aborted. */
  choose(question: string, choices: Choice[], signal?: AbortSignal): Promise<string | undefined>;
  setInfo(info: TerminalInfo): void;
  /** What / completes to, and what each command's argument completes to. */
  setCommands(commands: Command[]): void;
  /** Ctrl+C while something runs. */
  onInterrupt(handler: () => void): void;
  /** Shift+Tab. */
  onCycleMode(handler: () => void): void;
  close(): void;
}

export interface Choice { key: string; label: string }
export interface TerminalInfo { mode: 'chat' | 'agent' | 'operator'; model: string; root: string }
export interface Command {
  name: string;
  hint: string;
  /** What its argument offers: folders on disk, or a list fetched when it is asked for. */
  /** Each choice's `value` is inserted; its `label`, when given, is what the popup shows and matches. */
  args?: 'folders' | (() => Promise<Array<{ value: string; label?: string; hint?: string }>>);
  /** Shown dimmed after `/name ` until an argument is typed. */
  placeholder?: string;
}

/** The full terminal when both ends are one; plain lines otherwise. */
export function createTerminal(root: string): Terminal {
  return process.stdin.isTTY && process.stdout.isTTY ? new RichTerminal(root) : new LineTerminal();
}

type Phase =
  | { kind: 'busy' }
  | { kind: 'input'; resolve: (text: string | undefined) => void }
  | { kind: 'choose'; question: string; choices: Choice[]; resolve: (key: string | undefined) => void };

/** What the window reports of the mouse. */
type MouseEvent = Parameters<Parameters<Screen['enter']>[1]>[0];

/** The token being completed, what it could become, and which of those is picked. */
interface Popup extends Token {
  items: Array<Suggestion & { dir?: boolean }>;
  selected: number;
  /** Shown in place of the list while it is empty. */
  empty: string;
}

const POPUP_ITEMS = 50;
const INDEX_TTL_MS = 15000;
const ARGS_TTL_MS = 30000;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const INSERT_KEYS: Array<[string, string]> = [
  ['⏎', 'send'], ['⌥⏎', 'newline'], ['@', 'attach'], ['/', 'commands'], ['⇧⇥', 'mode'], ['⌥↑↓', 'points'],
  ['esc', 'normal'], ['F1', 'help'], ['^D', 'quit'],
];
const NORMAL_KEYS: Array<[string, string]> = [
  ['i a A o', 'insert'], ['h l w b e', 'move'], ['d c y', 'operators'], ['x p u', 'edit'],
  ['[ ]', 'points'], ['⏎', 'send'], ['?', 'help'],
];
const ACCEPT_WHOLE = new Set(['right', 'end', 'tab', 'C-e', 'C-f']);
const ACCEPT_WORD = new Set(['M-right', 'M-f', 'C-right']);

const POPUP_KEYS: Record<TokenKind, Array<[string, string]>> = {
  files: [['↑↓', 'select'], ['⇥', 'open folder'], ['⏎', 'attach'], ['esc', 'close']],
  folders: [['↑↓', 'select'], ['⇥', 'open folder'], ['⏎', 'use it'], ['esc', 'close']],
  args: [['↑↓', 'select'], ['⇥', 'complete'], ['⏎', 'use it'], ['esc', 'close']],
  commands: [['↑↓', 'select'], ['⇥ ⏎', 'choose'], ['esc', 'close']],
};
const HELP_ROWS: Array<Array<[string, string]>> = [
  [['⏎', 'send'], ['⌥⏎ ^J \\⏎', 'newline'], ['↑↓', 'history'], ['^C', 'clear, or stop a run'], ['^D', 'quit'], ['^L', 'redraw']],
  [['@path', 'attach a file or folder'], ['@~/ @/', 'browse the disk'], ['⇥', 'open a folder'], ['⏎', 'attach it']],
  [['/', 'mode model allow skills clear help quit, or /skill args'], ['⇧⇥', 'chat → agent → operator']],
  [['^A ^E', 'line start, end'], ['^W', 'word back'], ['^U ^K', 'kill to start, end'], ['⌥← ⌥→', 'word']],
  [['esc', 'normal mode'], ['h l w b e 0 ^ $ f t gg G', 'move'], ['d c y + motion, dd cc yy', 'operate']],
  [['PgUp PgDn', 'scroll the conversation'], ['wheel', 'scroll'], ['⌥ drag (iTerm2) or ⇧ drag', 'select text']],
  [['◆', 'your message on the scroll bar'], ['•', 'a reply'], ['click either', 'jump to it']],
  [['⌥↑ ⌥↓', 'previous / next message or reply'], ['[ ]', 'the same, in normal mode'], ['click the bar', 'jump there']],
  [['x X s r ~ J p P', 'edit'], ['u ^R', 'undo, redo'], ['i a I A o O', 'insert'], ['F1 ^/ ?', 'close help']],
];

/** Each mode's colour, for its prompt and its footer badge. */
const MODE_COLOUR: Record<TerminalInfo['mode'], (s: string) => string> = { chat: green, agent: cyan, operator: yellow };

/**
 * The prompt: a plain marker in the mode's colour. The mode's name is in the
 * footer; as a label here it read as the agent speaking.
 */
export function promptFor(mode: TerminalInfo['mode']): string {
  return MODE_COLOUR[mode]('❯') + ' ';
}

/**
 * A message the user sent, as the conversation shows it: labelled as theirs,
 * in the colour of their ◆ on the scroll bar, with the mode it went to after it.
 */
export function userMessage(text: string, mode: TerminalInfo['mode'], width: number): string {
  const rows = wrapInput(cyan(bold('you ›')) + ' ', text, text.length, width).rows;
  rows[rows.length - 1] += dim(`  · ${mode}`);
  return rows.join('\n');
}

class RichTerminal implements Terminal {
  private phase: Phase = { kind: 'busy' };
  private draft: Draft = draftOf();
  private popup?: Popup;
  /** The token whose popup Esc closed; it stays closed until another token starts. */
  private dismissed?: string;
  private history: string[] = loadHistory();
  private historyAt = 0;
  private stash = '';
  private info: TerminalInfo;
  private commands: Command[] = [];
  private statusText = '';
  private previewLines?: string[];
  /** Set when a message is sent: the next thing printed starts its reply. */
  private replyDue = false;
  private statusSince = 0;
  private spinner?: NodeJS.Timeout;
  private helpOpen = false;
  private pasting = false;
  private closed = false;
  private readonly screen = new Screen();
  /** Rows the conversation had at the last draw: a page, for PgUp and PgDn. */
  private conversationRows = 10;

  private index?: Entry[];
  private indexedAt = 0;
  private indexing = false;
  private readonly browsed = new Map<string, Entry[]>();
  /** What each command's argument offered, and when it was asked; undefined items while loading. */
  private readonly argChoices = new Map<string, { items?: ArgChoice[]; at: number }>();

  private interrupt?: () => void;
  private cycle?: () => void;
  private readonly onResize = () => this.render();

  constructor(private readonly root: string) {
    this.info = { mode: 'agent', model: '', root };
    this.screen.enter((k) => this.key(k), (m) => this.mouse(m));
    process.stdout.on('resize', this.onResize);
    process.stdout.write('\x1b[?2004h'); // bracketed paste, so a pasted newline does not send
  }

  get width(): number { return process.stdout.columns || 100; }

  print(text: string, mark?: 'user' | 'agent'): void {
    if (this.closed) { process.stdout.write(text + '\n'); return; }
    this.screen.append(text, mark ?? (this.replyDue ? 'agent' : undefined));
    this.replyDue = false;
    this.render();
  }


  status(text?: string): void {
    this.statusText = text ?? '';
    if (text && !this.spinner) {
      this.statusSince = Date.now();
      this.spinner = setInterval(() => this.render(), 100);
    }
    if (!text) { this.stopSpinner(); }
    this.render();
  }

  preview(lines?: string[]): void {
    this.previewLines = lines;
    this.render();
  }

  read(): Promise<string | undefined> {
    this.stopSpinner();
    this.statusText = '';
    this.previewLines = undefined;
    return new Promise((resolve) => {
      this.phase = { kind: 'input', resolve };
      this.draft = draftOf();
      this.historyAt = this.history.length;
      this.render();
    });
  }

  choose(question: string, choices: Choice[], signal?: AbortSignal): Promise<string | undefined> {
    return new Promise((resolve) => {
      const done = (key: string | undefined) => {
        signal?.removeEventListener('abort', abort);
        const chosen = choices.find((c) => c.key === key);
        this.phase = { kind: 'busy' };
        this.print(`${question} ${dim('→')} ${chosen ? bold(chosen.label) : dim('no')}`);
        resolve(key);
      };
      const abort = () => { if (this.phase.kind === 'choose') { done(undefined); } };
      signal?.addEventListener('abort', abort, { once: true });
      this.phase = { kind: 'choose', question, choices, resolve: done };
      this.render();
    });
  }

  setInfo(info: TerminalInfo): void { this.info = info; this.render(); }
  setCommands(commands: Command[]): void { this.commands = commands; }
  onInterrupt(handler: () => void): void { this.interrupt = handler; }
  onCycleMode(handler: () => void): void { this.cycle = handler; }

  close(): void {
    if (this.closed) { return; }
    this.stopSpinner();
    process.stdout.write('\x1b[?2004l');
    this.closed = true;
    process.stdout.off('resize', this.onResize);
    this.screen.leave();
    const phase = this.phase;
    this.phase = { kind: 'busy' };
    if (phase.kind !== 'busy') { phase.resolve(undefined); }
  }

  // ---------- keys ----------

  private key(k: Key): void {
    if (k.name === 'paste-start') { this.pasting = true; return; }
    // Moving about the conversation works whatever else is going on.
    const move = this.pasting ? undefined : this.navigation[keyId(k)];
    if (move) { move(); return; }
    if (k.name === 'paste-end') { this.pasting = false; this.afterEdit(); return; }
    if (this.phase.kind === 'input') { this.inputKey(k); return; }
    if (this.phase.kind === 'choose') { this.chooseKey(k, this.phase); return; }
    if (k.ctrl && k.name === 'c') { this.interrupt?.(); }
  }

  private inputKey(k: Key): void {
    if (this.pasting) { this.paste(k); return; }
    if (this.globalKey(k)) { return; }
    if (this.popup && this.popupKey(k, this.popup)) { return; }
    if (this.acceptGhost(k)) { return; }
    if (k.name === 'tab') { return; }

    const { draft, event } = edit(this.draft, k);
    this.draft = draft;
    if (event === 'submit') { this.submit(); return; }
    if (event === 'history-prev' || event === 'history-next') { this.recall(event === 'history-prev' ? -1 : 1); }
    this.afterEdit();
  }

  /** Keys that mean the same whatever is being typed. True when handled. */
  private globalKey(k: Key): boolean {
    const action = k.name === 'tab' && k.shift ? this.cycle : this.globals[keyId(k)] ?? this.normalAction(k);
    action?.();
    return action !== undefined;
  }

  private readonly globals: Record<string, () => void> = {
    // Ctrl+C clears what is typed; on an empty prompt it leaves, like Ctrl+D.
    'C-c': () => { if (this.draft.text) { this.draft = draftOf(); this.afterEdit(); } else { this.finishInput(undefined); } },
    'C-d': () => { if (!this.draft.text) { this.finishInput(undefined); } },
    'C-l': () => { process.stdout.write('\x1b[2J'); this.render(); },
    'f1': () => this.toggleHelp(),
  };

  /** Keys that move about the conversation in any phase: a page, or the previous and next point. */
  private readonly navigation: Record<string, () => void> = {
    'pageup': () => this.scrollBy(1, true),
    'pagedown': () => this.scrollBy(-1, true),
    'M-up': () => this.jumpBy(-1),
    'M-down': () => this.jumpBy(1),
  };

  /** A wheel turn scrolls; a click on the scroll bar jumps there. */
  private mouse(m: MouseEvent): void {
    if (m.kind === 'wheel') { this.scrollBy(m.direction, false); return; }
    if (this.screen.click(m.col, m.row, this.conversationRows)) { this.render(); }
  }

  /** To the previous (-1) or next (+1) message or reply. */
  private jumpBy(direction: 1 | -1): void {
    this.screen.jump(direction, this.conversationRows);
    this.render();
  }

  /** Moves the conversation back (+) or forward (−), by wheel steps or by a page. */
  private scrollBy(direction: 1 | -1, page: boolean): void {
    this.screen.scroll(direction, this.conversationRows, page);
    this.render();
  }

  private readonly toggleHelp = () => { this.helpOpen = !this.helpOpen; this.render(); };

  /** Ctrl+/ (sent as ^_) anywhere; ? and [ ] in normal mode when no command is half-typed. */
  private normalAction(k: Key): (() => void) | undefined {
    if (k.sequence === '\x1f') { return this.toggleHelp; }
    if (this.draft.mode !== 'normal' || this.draft.pending) { return undefined; }
    return ({ '?': this.toggleHelp, '[': () => this.jumpBy(-1), ']': () => this.jumpBy(1) } as Record<string, () => void>)[k.sequence ?? ''];
  }

  /** Pasted text goes in as typed, newlines and all, whatever the mode. */
  private paste(k: Key): void {
    const ch = k.name === 'return' || k.name === 'enter' ? '\n' : k.name === 'tab' ? '\t' : charOf(k);
    if (ch !== undefined) { this.draft = insertText({ ...this.draft, mode: 'insert' }, ch); }
  }

  private popupKey(k: Key, p: Popup): boolean {
    const n = p.items.length;
    if (k.name === 'up' || (k.ctrl && k.name === 'p')) { p.selected = (p.selected - 1 + n) % Math.max(1, n); this.render(); return true; }
    if (k.name === 'down' || (k.ctrl && k.name === 'n')) { p.selected = (p.selected + 1) % Math.max(1, n); this.render(); return true; }
    if (k.name === 'escape') {
      this.dismissed = `${p.kind}:${p.start}`;
      this.popup = undefined;
      this.render();
      return true;
    }
    if ((k.name === 'tab' || k.name === 'return') && !k.meta) { return this.pick(p, k.name === 'tab'); }
    return false;
  }

  /** Tab or Enter on the popup. False lets the key through, so Enter sends. */
  private pick(p: Popup, tab: boolean): boolean {
    const item = p.items[p.selected];
    if (!item) { return tab; }
    // A command already typed out in full is sent, not completed again.
    if (!tab && p.kind === 'commands' && this.draft.text.slice(p.start, p.end) === item.value) { return false; }
    this.accept(p, item, tab);
    // An argument is the last thing a command takes: choosing it with Enter sends.
    if (!tab && (p.kind === 'args' || p.kind === 'folders')) { this.submit(); }
    return true;
  }

  /** Puts the chosen item in place of the token. Tab on a folder keeps it open to look inside. */
  private accept(p: Popup, item: Popup['items'][number], tab: boolean): void {
    const open = item.dir && tab;
    const text = inserted(p, item) + (p.kind === 'commands' || (p.kind === 'files' && !open) ? ' ' : '');
    const t = this.draft.text;
    const base = { ...this.draft, text: t.slice(0, p.start) + t.slice(p.end), cursor: p.start };
    this.draft = insertText(base, text);
    this.afterEdit();
  }

  /** →, End or Tab take the whole suggestion; Alt+→ its next word. True when one was taken. */
  private acceptGhost(k: Key): boolean {
    const id = keyId(k);
    const ghost = ACCEPT_WHOLE.has(id) || ACCEPT_WORD.has(id) ? this.ghost() : undefined;
    if (!ghost?.accept) { return false; }
    this.draft = insertText(this.draft, ACCEPT_WORD.has(id) ? firstWord(ghost.text) : ghost.text);
    this.afterEdit();
    return true;
  }

  /** The dimmed suggestion after the cursor, from the popup's pick or from history. */
  private ghost(): Ghost | undefined {
    if (this.phase.kind !== 'input' || this.draft.mode !== 'insert') { return undefined; }
    const p = this.popup;
    const item = p?.items[p.selected];
    const completion = p && item ? this.draft.text.slice(0, p.start) + inserted(p, item) : undefined;
    return ghostFor(this.draft.text, this.draft.cursor, completion, this.history, this.commands);
  }

  private chooseKey(k: Key, phase: Extract<Phase, { kind: 'choose' }>): void {
    if (k.ctrl && k.name === 'c') { this.interrupt?.(); phase.resolve(undefined); return; }
    if (k.name === 'escape' || k.name === 'return') { phase.resolve(undefined); return; }
    const ch = charOf(k)?.toLowerCase();
    if (ch && phase.choices.some((c) => c.key === ch)) { phase.resolve(ch); }
  }

  private submit(): void {
    const text = this.draft.text;
    if (!text.trim()) { this.afterEdit(); return; }
    if (this.history[this.history.length - 1] !== text) {
      this.history.push(text);
      void saveHistory(this.history);
    }
    this.finishInput(text);
  }

  /** Leaves the prompt, echoing what was sent into the scrollback. */
  private finishInput(text: string | undefined): void {
    if (this.phase.kind !== 'input') { return; }
    const { resolve } = this.phase;
    this.phase = { kind: 'busy' };
    // Sending something means wanting to see what comes of it.
    this.screen.follow();
    this.popup = undefined;
    this.dismissed = undefined;
    this.helpOpen = false;
    if (text !== undefined) {
      this.print(userMessage(text, this.info.mode, this.width - 1), 'user');
      this.replyDue = true;
    } else {
      this.render();
    }
    resolve(text);
  }

  private recall(step: number): void {
    const next = this.historyAt + step;
    if (next < 0 || next > this.history.length) { return; }
    if (this.historyAt === this.history.length) { this.stash = this.draft.text; }
    this.historyAt = next;
    const text = next === this.history.length ? this.stash : this.history[next];
    const recalled = draftOf(text);
    this.draft = this.draft.mode === 'normal'
      ? { ...recalled, mode: 'normal', cursor: Math.max(0, text.length - 1) }
      : recalled;
    // A recalled message opens no popup, or the arrows would stop walking history.
    const tok = this.token();
    this.dismissed = tok && `${tok.kind}:${tok.start}`;
  }

  // ---------- popup ----------

  private afterEdit(): void {
    this.popup = this.popupFor();
    this.render();
  }

  /** The popup for the token under the cursor: a /command, its argument, or an @path. */
  private popupFor(): Popup | undefined {
    const tok = this.token();
    if (!tok) { this.dismissed = undefined; return undefined; }
    if (this.dismissed === `${tok.kind}:${tok.start}`) { return undefined; }
    this.dismissed = undefined;
    const { items, empty } = this.itemsFor(tok);
    const same = this.popup?.kind === tok.kind && this.popup.start === tok.start && this.popup.query === tok.query;
    return { ...tok, items, empty, selected: same ? Math.min(this.popup!.selected, Math.max(0, items.length - 1)) : 0 };
  }

  private token(): Token | undefined {
    return this.draft.mode === 'insert' ? tokenAt(this.draft.text, this.draft.cursor, this.commands) : undefined;
  }

  private itemsFor(tok: Token): { items: Popup['items']; empty: string } {
    switch (tok.kind) {
      case 'commands': return { items: rankCommands(tok.query, this.commands), empty: 'no such command' };
      case 'args': return this.argItems(tok);
      case 'folders': return { items: this.diskItems(tok.query || '~/', true), empty: 'no folders here' };
      default: return { items: this.fileItems(tok.query), empty: this.indexing && !this.index ? 'indexing files…' : 'no matches' };
    }
  }

  /** What a command's argument offers, fetched on first use and again after a while. */
  private argItems(tok: Token): { items: Popup['items']; empty: string } {
    const cmd = tok.command!;
    const cached = this.argChoices.get(cmd.name);
    if ((!cached || Date.now() - cached.at > ARGS_TTL_MS) && typeof cmd.args === 'function') {
      const fetch = cmd.args;
      this.argChoices.set(cmd.name, { items: cached?.items, at: Date.now() });
      void fetch().then(
        (items) => { this.argChoices.set(cmd.name, { items, at: Date.now() }); this.afterEdit(); },
        () => { this.argChoices.set(cmd.name, { items: [], at: Date.now() }); this.afterEdit(); },
      );
    }
    const items = this.argChoices.get(cmd.name)?.items;
    return { items: items ? rankChoices(tok.query, items).slice(0, POPUP_ITEMS) : [], empty: items ? 'nothing matches' : 'loading…' };
  }

  private fileItems(query: string): Popup['items'] {
    if (browsesDisk(query)) { return this.diskItems(query, false); }
    if (!this.index || Date.now() - this.indexedAt > INDEX_TTL_MS) { this.reindex(); }
    if (!this.index) { return []; }
    return rank(query, this.index, POPUP_ITEMS).map((m) => entryItem(m.entry, m.positions));
  }

  /**
   * One folder's entries at a time, as the query walks the disk: `~/no`
   * lists the home folder narrowed to "no". Folders only when `dirs`.
   */
  private diskItems(query: string, dirs: boolean): Popup['items'] {
    const folder = query.slice(0, query.lastIndexOf('/') + 1) || query;
    const entries = this.browsed.get(folder);
    if (!entries) {
      void browse(query, this.root).then((found) => { this.browsed.set(folder, found); this.afterEdit(); });
      return [];
    }
    const pool = dirs ? entries.filter((e) => e.dir) : entries;
    const tail = query.slice(query.lastIndexOf('/') + 1);
    const ranked = tail ? rank(query, pool, POPUP_ITEMS) : pool.slice(0, POPUP_ITEMS).map((entry) => ({ entry, positions: [] as number[] }));
    return ranked.map((m) => entryItem(m.entry, m.positions));
  }

  private reindex(): void {
    if (this.indexing) { return; }
    this.indexing = true;
    void indexPaths(this.root).then((entries) => {
      this.index = entries;
      this.indexedAt = Date.now();
      this.indexing = false;
      if (this.popup?.kind === 'files') { this.afterEdit(); }
    });
  }

  // ---------- drawing ----------

  private render(): void {
    if (this.closed || this.pasting) { return; }
    const laid = layout(this.view());
    this.conversationRows = Math.max(1, this.screen.rows - laid.rows.length);
    this.screen.draw(laid.rows, laid.cursor);
  }

  /** What the live area should show in the current phase. */
  private view(): LiveView {
    // The pinned area leaves the conversation a few rows however much it holds.
    const view: LiveView = { width: this.width, height: Math.max(6, this.screen.rows - 4), footer: this.footer(), note: this.screen.note(this.conversationRows) };
    if (this.statusText && this.phase.kind === 'busy') { view.status = this.spinnerLine(); }
    if (this.phase.kind === 'busy') { view.preview = this.previewLines; }
    if (this.phase.kind === 'choose') { view.question = bold(this.phase.question); }
    if (this.phase.kind !== 'input') { return view; }
    view.input = { prompt: promptFor(this.info.mode), text: this.draft.text, cursor: this.draft.cursor, ghost: this.ghost()?.text };
    if (this.popup) { view.popup = { items: this.popup.items, selected: this.popup.selected, empty: this.popup.empty }; }
    return view;
  }

  private spinnerLine(): string {
    const frame = SPINNER[Math.floor(Date.now() / 100) % SPINNER.length];
    const secs = Math.floor((Date.now() - this.statusSince) / 1000);
    return `${cyan(frame)} ${this.statusText} ${dim(`${secs}s`)}`;
  }

  private stopSpinner(): void {
    if (this.spinner) { clearInterval(this.spinner); this.spinner = undefined; }
  }

  private footer(): string[] {
    const mode = badge(this.info.mode.toUpperCase(), MODE_COLOUR[this.info.mode]);
    const where = this.info.root.replace(os.homedir(), '~');
    const attached = this.phase.kind === 'input' ? mentions(this.draft.text).length : 0;
    const vim = this.phase.kind !== 'input' ? '' : this.draft.mode === 'normal' ? '  ' + bold('NORMAL') : '  ' + dim('INSERT');
    const info = ` ${mode} ${dim(this.info.model)} ${dim('·')} ${dim(where)}${attached ? `  ${cyan(`@${attached}`)}` : ''}${vim}`;
    if (this.helpOpen && this.phase.kind === 'input') { return [info, ...HELP_ROWS.flatMap((row) => shortcuts(row, this.width))]; }
    return [info, ...shortcuts(this.keys(), this.width)];
  }

  /** The shortcuts that do something right now. */
  private keys(): Array<[string, string]> {
    switch (this.phase.kind) {
      case 'busy': return [['^C', 'stop']];
      case 'choose': return [...this.phase.choices.map((c): [string, string] => [c.key, c.label]), ['esc', 'no']];
    }
    if (this.popup) { return POPUP_KEYS[this.popup.kind]; }
    const accept: Array<[string, string]> = this.ghost()?.accept ? [['→', 'accept suggestion']] : [];
    return [...accept, ...(this.draft.mode === 'normal' ? NORMAL_KEYS : INSERT_KEYS)];
  }
}

/** What choosing `item` puts in place of the token: a path is written as a mention. */
function inserted(p: Token, item: Suggestion): string {
  return p.kind === 'files' ? mentionOf(item.value) : item.value;
}

function entryItem(entry: Entry, positions: number[]): Popup['items'][number] {
  return { value: entry.path, label: entry.path, positions, hint: entry.dir ? 'folder' : undefined, dir: entry.dir };
}
