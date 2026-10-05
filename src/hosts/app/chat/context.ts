import * as vscode from 'vscode';

/**
 * Explicit context assembly for the chat panel.
 *
 * Every source here is something the user ticked on purpose. Nothing is
 * gathered implicitly: the panel shows exactly what will be sent, and how many
 * characters of it, before anything leaves the machine.
 */

export type ContextKind =
  | 'pinned'
  | 'selection'
  | 'file'
  | 'tabsSameLang'
  | 'tabsAll'
  | 'folder'
  | 'pickedFiles'
  | 'searchHits';

export const KIND_LABELS: Record<ContextKind, string> = {
  pinned: 'Pinned lines',
  selection: 'Selected lines',
  file: 'Current file',
  tabsSameLang: 'Open tabs (same language)',
  tabsAll: 'Open tabs (all languages)',
  folder: 'Current folder',
  pickedFiles: 'Chosen files',
  searchHits: 'Search hits',
};

export interface ContextPiece {
  /** What the panel shows as the source of this text. */
  label: string;
  path: string;
  text: string;
  language: string;
}

export interface CollectedContext {
  pieces: ContextPiece[];
  chars: number;
  /** Sources that were dropped or cut short because the budget ran out. */
  skipped: string[];
}

/** Extensions worth reading when sweeping a folder; keeps binaries and lockfiles out. */
const FOLDER_GLOB =
  '*.{ts,tsx,js,jsx,mjs,cjs,py,rs,go,java,kt,kts,rb,php,cs,c,h,cpp,hpp,swift,scala,sh,sql,yaml,yml,toml,json,md}';

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv)(\/|$)/;

/**
 * The editor the context is anchored to.
 *
 * NOT vscode.window.activeTextEditor: that is undefined whenever a webview has
 * focus, which is exactly when the chat panel asks for context. The caller
 * passes the last text editor it saw instead.
 */
export async function collectContext(
  kinds: Set<ContextKind>,
  pickedFiles: vscode.Uri[],
  budget: number,
  editor: vscode.TextEditor | undefined,
  /** Already-materialised pieces the user ticked in the search planner. */
  searchPieces: ContextPiece[] = [],
): Promise<CollectedContext> {
  const acc = new Accumulator(budget);

  if (kinds.has('pinned')) { addPinned(acc); }
  if (kinds.has('selection')) { addSelection(acc, editor); }
  if (kinds.has('file')) { addCurrentFile(acc, editor); }
  if (kinds.has('tabsSameLang') || kinds.has('tabsAll')) {
    addOpenTabs(acc, editor, kinds.has('tabsSameLang') && !kinds.has('tabsAll'));
  }
  if (kinds.has('folder')) { await addFolder(acc, editor); }
  if (kinds.has('searchHits')) { addSearchHits(acc, searchPieces); }
  if (kinds.has('pickedFiles')) { await addPickedFiles(acc, pickedFiles); }

  return acc.result();
}

/** Collects pieces against a character budget, deduplicating by label and file. */
class Accumulator {
  readonly pieces: ContextPiece[] = [];
  readonly skipped: string[] = [];
  private readonly seen = new Set<string>();
  remaining: number;

  constructor(private readonly budget: number) {
    this.remaining = budget;
  }

  add(label: string, uri: vscode.Uri, text: string, language: string): void {
    const key = `${label}|${uri.toString()}`;
    if (this.seen.has(key) || !text.trim()) { return; }
    if (text.length > this.remaining) {
      this.skip(`${rel(uri)} (${Math.round(text.length / 1000)}k chars, over budget)`);
      return;
    }
    this.seen.add(key);
    this.pieces.push({ label, path: rel(uri), text, language });
    this.remaining -= text.length;
  }

  skip(reason: string): void { this.skipped.push(reason); }

  result(): CollectedContext {
    return { pieces: this.pieces, chars: this.budget - this.remaining, skipped: this.skipped };
  }
}

const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);

/** Every non-empty selection, so Alt+drag and Cmd+D multi-selections all count. */
function addSelection(acc: Accumulator, editor: vscode.TextEditor | undefined): void {
  if (!editor) { return acc.skip('Selected lines (no file open)'); }
  const selections = unpinnedSelections(editor);
  if (!selections.length && editor.selection.isEmpty) { return acc.skip('Selected lines (nothing is selected)'); }

  const { document } = editor;
  for (const sel of selections) {
    acc.add(
      `${KIND_LABELS.selection} ${sel.start.line + 1}-${sel.end.line + 1}`,
      document.uri,
      document.getText(sel),
      document.languageId,
    );
  }
}

/** Non-empty selections in document order, minus any already pinned, which the pin sends instead. */
function unpinnedSelections(editor: vscode.TextEditor): vscode.Selection[] {
  return editor.selections
    .filter((s) => !s.isEmpty && !pins.has(editor.document.uri, s))
    .sort((a, b) => a.start.compareTo(b.start));
}

function addPinned(acc: Accumulator): void {
  if (!pins.all().length) { return acc.skip('Pinned lines (nothing pinned yet: select lines, then Cmd+K L)'); }
  for (const pin of pins.all()) {
    acc.add(`${KIND_LABELS.pinned} ${pin.startLine}-${pin.endLine}`, pin.uri, pin.text, pin.language);
  }
}

function addCurrentFile(acc: Accumulator, editor: vscode.TextEditor | undefined): void {
  if (!editor) { return acc.skip('Current file (no file open)'); }
  acc.add(KIND_LABELS.file, editor.document.uri, editor.document.getText(), editor.document.languageId);
}

function addOpenTabs(acc: Accumulator, editor: vscode.TextEditor | undefined, sameLanguageOnly: boolean): void {
  const lang = editor?.document.languageId;

  for (const doc of openDocuments(editor)) {
    if (sameLanguageOnly && doc.languageId !== lang) { continue; }
    acc.add('Open tab', doc.uri, doc.getText(), doc.languageId);
    if (acc.remaining <= 0) { break; }
  }
}

async function addFolder(acc: Accumulator, editor: vscode.TextEditor | undefined): Promise<void> {
  const base = editor?.document.uri;
  if (!base) { return acc.skip('Current folder (no file open)'); }

  const dir = vscode.Uri.joinPath(base, '..');
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(dir, FOLDER_GLOB),
    '**/{node_modules,.git,dist,build,out,target}/**',
    60,
  );
  for (const uri of found.sort((a, b) => a.path.localeCompare(b.path))) {
    if (SKIP_DIRS.test(uri.path)) { continue; }
    if (acc.remaining <= 0) { acc.skip(`${rel(uri)} (budget exhausted)`); continue; }
    const doc = await safeOpen(uri);
    if (doc) { acc.add('Folder file', uri, doc.getText(), doc.languageId); }
  }
}

function addSearchHits(acc: Accumulator, searchPieces: ContextPiece[]): void {
  if (!searchPieces.length) { acc.skip('Search hits (nothing ticked in the planner)'); }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file('/');
  for (const piece of searchPieces) {
    acc.add(piece.label, vscode.Uri.joinPath(root, piece.path), piece.text, piece.language);
  }
}

async function addPickedFiles(acc: Accumulator, pickedFiles: vscode.Uri[]): Promise<void> {
  for (const uri of pickedFiles) {
    const doc = await safeOpen(uri);
    if (doc) { acc.add('Chosen file', uri, doc.getText(), doc.languageId); }
  }
}

function openDocuments(editor: vscode.TextEditor | undefined): vscode.TextDocument[] {
  const out: vscode.TextDocument[] = [];
  const active = editor?.document.uri.toString();

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (!(input instanceof vscode.TabInputText)) { continue; }
      if (input.uri.scheme !== 'file' || input.uri.toString() === active) { continue; }

      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === input.uri.toString(),
      );
      if (doc) { out.push(doc); }
    }
  }
  return out;
}

async function safeOpen(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    return undefined; // binary, deleted, or too large for the editor
  }
}

/** A selection kept as context after the editor moves on to another one. */
export interface Pin {
  uri: vscode.Uri;
  /** 1-based and inclusive, as the preview shows them. */
  startLine: number;
  endLine: number;
  range: vscode.Range;
  /** Captured when pinned: later edits to the file do not move or change a pin. */
  text: string;
  language: string;
}

/**
 * Pinned selections, kept outside the chat panel so lines can be pinned
 * before it is opened, and so a selection elsewhere does not dismiss them.
 */
class Pins {
  private list: Pin[] = [];

  all(): readonly Pin[] { return this.list; }

  has(uri: vscode.Uri, range: vscode.Range): boolean {
    return this.list.some((p) => p.uri.toString() === uri.toString() && p.range.isEqual(range));
  }

  /** Pins every non-empty selection of the editor; returns the ones that were new. */
  add(editor: vscode.TextEditor): Pin[] {
    const { document } = editor;
    const added: Pin[] = [];
    for (const sel of editor.selections) {
      if (sel.isEmpty || this.has(document.uri, sel)) { continue; }
      const pin: Pin = {
        uri: document.uri,
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        range: new vscode.Range(sel.start, sel.end),
        text: document.getText(sel),
        language: document.languageId,
      };
      this.list.push(pin);
      added.push(pin);
    }
    return added;
  }

  /** Drops the pins whose "path:start-end" contains the argument, or all of them; returns how many went. */
  remove(arg: string): number {
    const before = this.list.length;
    this.list = arg ? this.list.filter((p) => !describePin(p).includes(arg)) : [];
    return before - this.list.length;
  }
}

export const pins = new Pins();

export function describePin(p: Pin): string {
  return `${rel(p.uri)}:${p.startLine}-${p.endLine}`;
}

/** Renders collected context as the reference block prefixed to the conversation. */
export function renderContext(collected: CollectedContext): string {
  if (!collected.pieces.length) { return ''; }

  const parts = ['The user has attached the following code as context.', ''];

  for (const p of collected.pieces) {
    parts.push(`--- ${p.label}: ${p.path} ---`, '```' + p.language, p.text, '```', '');
  }
  return parts.join('\n');
}

export const CHAT_SYSTEM_PROMPT = [
  'You are a coding assistant embedded in VS Code, answering about the code the user attached.',
  '',
  'Ground every answer in the attached context. If the answer is not determinable from what',
  'you were given, say which file or symbol you would need rather than guessing at it.',
  'Keep answers short. Use fenced code blocks with a language tag for any code.',
].join('\n');

/**
 * Remembers the last real text editor, because a focused webview makes
 * vscode.window.activeTextEditor undefined and the chat panel is a webview.
 */
export class EditorAnchor {
  private last?: vscode.TextEditor;

  constructor() {
    this.remember(vscode.window.activeTextEditor);
  }

  /** Only ever moves to another file editor; never cleared by focus changes. */
  remember(editor: vscode.TextEditor | undefined): void {
    if (editor && editor.document.uri.scheme === 'file') { this.last = editor; }
  }

  current(): vscode.TextEditor | undefined {
    if (this.last && !this.last.document.isClosed) { return this.last; }
    this.last = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
    return this.last;
  }

  watch(): vscode.Disposable[] {
    return [
      vscode.window.onDidChangeActiveTextEditor((e) => this.remember(e)),
      vscode.window.onDidChangeTextEditorSelection((e) => this.remember(e.textEditor)),
    ];
  }
}
