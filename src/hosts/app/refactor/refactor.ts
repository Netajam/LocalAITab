import * as vscode from 'vscode';
import { chat, getCapabilities, OllamaError, GenerateResult } from '../../../core/llm/ollama';
import { cleanCode, matchIndentation } from '../../../core/llm/extract';
import { ensureInstructModel } from '../modelguard';
import {
  PRESETS, SYSTEM_PROMPT, buildUserPrompt, buildRepairPrompt,
  IMPROVE_INSTRUCTION, SCOPE_LABELS, ContextScope, ExtraFile,
} from './prompts';
import {
  snapshotErrors, newErrorsSince, waitForDiagnostics, endOfInsertion, describeErrors, ErrorSnapshot,
} from './verify';

export const PREVIEW_SCHEME = 'localaitab-refactor';

/** Backs the virtual documents shown in the before/after diff. */
export class PreviewProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, text: string): void {
    this.contents.set(uri.path, text);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }

  dispose(): void {
    this.emitter.dispose();
    this.contents.clear();
  }
}

let previewSeq = 0;

export interface RefactorOptions {
  /** Skip the preset picker and use this instruction. */
  instruction?: string;
  /** Ask the user which context scope to send. */
  chooseScope?: boolean;
  /** Check the language server for new errors after applying. */
  verify?: boolean;
  /** Label shown in the progress notification. */
  title?: string;
}

/** Make This Better: a fixed improvement instruction, checked against the language server. */
export function runImprove(output: vscode.OutputChannel, preview: PreviewProvider): Promise<void> {
  return runRefactor(output, preview, {
    instruction: IMPROVE_INSTRUCTION,
    verify: true,
    title: 'LocalAITab: improving selection',
  });
}

export async function runRefactor(
  output: vscode.OutputChannel,
  preview: PreviewProvider,
  options: RefactorOptions = {},
): Promise<void> {
  const prepared = await prepareRefactor(output, options);
  if (!prepared) { return; }
  const { request, cfg } = prepared;

  const result = await requestRefactor(output, cfg, request, options.title);
  if (!result) { return; }

  if (result === request.code) {
    reportUnchanged(output);
    return;
  }

  await proposeRefactor(output, prepared, result);
}

/** A refactor request ready to send, plus what is needed to stage its result. */
interface PreparedRefactor {
  request: RefactorRequest;
  cfg: vscode.WorkspaceConfiguration;
  range: vscode.Range;
  version: number;
  verify: boolean;
  errorsBefore: ErrorSnapshot;
}

/** Gathers the selection, instruction and context; undefined if the user backs out. */
async function prepareRefactor(
  output: vscode.OutputChannel,
  options: RefactorOptions,
): Promise<PreparedRefactor | undefined> {
  const editor = activeSelectionEditor();
  if (!editor) { return undefined; }

  const { document, selection } = editor;
  const code = document.getText(selection);
  const version = document.version;

  const instruction = await pickInstruction(options.instruction);
  if (!instruction) { return undefined; }

  const cfg = vscode.workspace.getConfiguration('localAITab');
  const target = await installedRefactorModel(cfg, output);
  if (!target) { return undefined; }

  const scope = await pickScope(cfg, options.chooseScope);
  if (!scope) { return undefined; }

  const request: RefactorRequest = {
    document, code, instruction, scope, target, ...buildContext(document, selection, scope, cfg),
  };
  return {
    request,
    cfg,
    range: new vscode.Range(selection.start, selection.end),
    version,
    verify: options.verify === true,
    // Errors already present are not this refactor's fault; snapshot them first.
    errorsBefore: snapshotErrors(document.uri),
  };
}

/** Shows the diff (if wanted), stages the result and asks the user to decide. */
async function proposeRefactor(
  output: vscode.OutputChannel,
  prepared: PreparedRefactor,
  result: string,
): Promise<void> {
  const { document, code } = prepared.request;
  const summary = `${code.split('\n').length} lines in, ${result.split('\n').length} out`;
  const wantPreview = prepared.cfg.get<boolean>('refactorPreview', true);
  const previewUris = wantPreview ? await showDiff(document, code, result) : [];

  await setPending({
    uri: document.uri,
    range: prepared.range,
    newText: result,
    version: prepared.version,
    previewUris,
    summary,
    verify: prepared.verify,
    errorsBefore: prepared.errorsBefore,
    languageId: document.languageId,
  });

  // With a diff open the title-bar buttons are the primary control and this is
  // a fallback; without one it is the only way to answer.
  const message = wantPreview
    ? `LocalAITab: review the diff, then Apply or Discard (${summary}).`
    : `LocalAITab: apply this refactor? (${summary})`;
  askApplyOrDiscard(message, output);
}

/** The active editor, provided it has a non-empty selection; warns otherwise. */
function activeSelectionEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('LocalAITab: no active editor.');
    return undefined;
  }
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('LocalAITab: select the code you want to refactor first.');
    return undefined;
  }
  return editor;
}

/** Uses the given instruction, else a preset, else whatever the user types. */
async function pickInstruction(given: string | undefined): Promise<string | undefined> {
  if (given) { return given; }

  const picked = await vscode.window.showQuickPick(
    PRESETS.map((p) => ({ label: p.label, detail: p.detail, instruction: p.instruction })),
    { placeHolder: 'How should this selection be refactored?', matchOnDetail: true },
  );
  if (!picked) { return undefined; }
  if (picked.instruction) { return picked.instruction; }

  const typed = await vscode.window.showInputBox({
    prompt: 'Describe the refactor',
    placeHolder: 'e.g. split the retry logic out into its own function',
  });
  return typed?.trim() || undefined;
}

/** The configured context scope, or the user's pick when asked to choose. */
async function pickScope(
  cfg: vscode.WorkspaceConfiguration,
  choose: boolean | undefined,
): Promise<ContextScope | undefined> {
  const configured = cfg.get<ContextScope>('refactorContext', 'surrounding');
  if (!choose) { return configured; }

  const chosen = await vscode.window.showQuickPick(
    (Object.keys(SCOPE_LABELS) as ContextScope[]).map((k) => ({
      label: k, detail: SCOPE_LABELS[k], scope: k,
    })),
    { placeHolder: 'How much context should the model see?', matchOnDetail: true },
  );
  return chosen?.scope;
}

/** Which model does the refactoring, and where it is served. */
interface ModelTarget {
  endpoint: string;
  model: string;
}

function refactorModel(cfg: vscode.WorkspaceConfiguration): ModelTarget {
  return {
    endpoint: cfg.get<string>('endpoint', 'http://localhost:11434'),
    model: cfg.get<string>('refactorModel', 'qwen3.6:35b-a3b-coding'),
  };
}

/**
 * The refactor model, swapped for an installed stand-in when the configured one
 * is missing; undefined when the user declines (caller aborts).
 */
async function installedRefactorModel(
  cfg: vscode.WorkspaceConfiguration,
  output: vscode.OutputChannel,
): Promise<ModelTarget | undefined> {
  const { endpoint, model: configured } = refactorModel(cfg);
  const model = await ensureInstructModel(endpoint, configured, output);
  return model ? { endpoint, model } : undefined;
}

/** Everything the refactor prompt is built from. */
interface RefactorRequest {
  document: vscode.TextDocument;
  code: string;
  instruction: string;
  scope: ContextScope;
  target: ModelTarget;
  context?: string;
  extraFiles: ExtraFile[];
}

/** Asks the model for the refactored code; undefined when there is nothing to show. */
function requestRefactor(
  output: vscode.OutputChannel,
  cfg: vscode.WorkspaceConfiguration,
  req: RefactorRequest,
  title: string | undefined,
): Thenable<string | undefined> {
  const { model } = req.target;
  return withCancellableProgress(
    title ?? `LocalAITab: refactoring with ${model}`,
    async (signal, token) => {
      try {
        const { res, think } = await askRefactorModel(cfg, req.target, refactorPrompt(req), signal);
        output.appendLine(
          `[refactor] ${model} ${res.totalMs}ms ${res.evalCount}tok think=${think ?? 'n/a'} ` +
          `scope=${req.scope} "${req.instruction.slice(0, 60)}"`,
        );
        return usableCode(output, model, req.code, res.text);
      } catch (err) {
        if (token.isCancellationRequested) { return undefined; }
        const message = err instanceof OllamaError ? err.message : (err as Error).message;
        output.appendLine(`[refactor error] ${message}`);
        vscode.window.showErrorMessage(`LocalAITab: ${message}`);
        return undefined;
      }
    },
  );
}

function refactorPrompt(req: RefactorRequest): string {
  return buildUserPrompt({
    languageId: req.document.languageId,
    filePath: vscode.workspace.asRelativePath(req.document.uri),
    instruction: req.instruction,
    code: req.code,
    context: req.context,
    extraFiles: req.extraFiles,
  });
}

/** Strips the reply down to code, warning when nothing but reasoning or prose came back. */
function usableCode(
  output: vscode.OutputChannel,
  model: string,
  code: string,
  reply: string,
): string {
  const cleaned = matchIndentation(code, cleanCode(reply));
  if (!cleaned && reply.trim()) {
    // Everything the model produced was reasoning or prose.
    output.appendLine(`[refactor] nothing usable in reply: ${JSON.stringify(reply.slice(0, 300))}`);
    vscode.window.showWarningMessage(
      `LocalAITab: ${model} returned no code. It may have spent its budget reasoning -- ` +
      `raise localAITab.refactorMaxTokens or pick a non-reasoning instruct model.`,
    );
  }
  return cleaned;
}

function reportUnchanged(output: vscode.OutputChannel): void {
  output.appendLine('[refactor] result was byte-identical to the selection; nothing to preview.');
  void vscode.window
    .showInformationMessage(
      'LocalAITab: the model returned the selection unchanged. It may have judged the instruction ' +
      'inapplicable, or the selection may be too small to act on.',
      'Show log',
    )
    .then((c) => { if (c) { output.show(true); } });
}

/** Runs a model call under a cancellable notification; cancelling aborts the request. */
function withCancellableProgress(
  title: string,
  run: (signal: AbortSignal, token: vscode.CancellationToken) => Promise<string | undefined>,
): Thenable<string | undefined> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    async (_progress, token): Promise<string | undefined> => {
      const ac = new AbortController();
      const sub = token.onCancellationRequested(() => ac.abort());
      try {
        return await run(ac.signal, token);
      } finally {
        sub.dispose();
      }
    },
  );
}

/** One chat round with the refactor model, using the refactor sampling settings. */
async function askRefactorModel(
  cfg: vscode.WorkspaceConfiguration,
  target: ModelTarget,
  user: string,
  signal: AbortSignal,
): Promise<{ res: GenerateResult; think: false | undefined }> {
  // Reasoning models will happily spend the entire token budget thinking
  // and return nothing, so turn it off where the model supports the flag.
  const caps = await getCapabilities(target.endpoint, target.model);
  const think = caps.includes('thinking') ? false : undefined;

  const res = await chat({
    endpoint: target.endpoint,
    model: target.model,
    system: SYSTEM_PROMPT,
    user,
    temperature: cfg.get<number>('refactorTemperature', 0.2),
    maxTokens: cfg.get<number>('refactorMaxTokens', 2048),
    keepAlive: cfg.get<string>('keepAlive', '30m'),
    signal,
    think,
  });
  return { res, think };
}

/** Offers Apply / Discard in a notification and acts on the answer. */
function askApplyOrDiscard(message: string, output: vscode.OutputChannel): void {
  void vscode.window
    .showInformationMessage(message, 'Apply', 'Discard')
    .then((choice) => {
      if (choice === 'Apply') { void applyPending(output); }
      else if (choice === 'Discard') { void discardPending(); }
    });
}

const SELECTION_MARKER = '/* <<< selection >>> */';

/**
 * Assembles the reference material sent alongside the selection.
 *
 * Completion and refactoring had drifted apart here: completion already sent
 * neighbouring tabs, while refactoring saw nothing but a window around the
 * cursor. The scopes below make that an explicit choice.
 */
function buildContext(
  document: vscode.TextDocument,
  selection: vscode.Selection,
  scope: ContextScope,
  cfg: vscode.WorkspaceConfiguration,
): { context?: string; extraFiles: ExtraFile[] } {
  if (scope === 'none') { return { extraFiles: [] }; }

  const full = document.getText();
  const start = document.offsetAt(selection.start);
  const end = document.offsetAt(selection.end);

  if (scope === 'surrounding') {
    const half = Math.floor(cfg.get<number>('refactorContextChars', 2000) / 2);
    const joined =
      full.slice(Math.max(0, start - half), start) + SELECTION_MARKER + full.slice(end, end + half);
    return { context: nonBlank(joined), extraFiles: [] };
  }

  // 'file' and 'openTabs' both send the whole current file.
  const context = nonBlank(full.slice(0, start) + SELECTION_MARKER + full.slice(end));
  if (scope === 'file') { return { context, extraFiles: [] }; }

  return { context, extraFiles: neighbourFiles(document, cfg.get<number>('refactorNeighborBudget', 6000)) };
}

function nonBlank(text: string): string | undefined {
  return text.trim() ? text : undefined;
}

/** Other visible files in the same language, whole, until the budget runs out. */
function neighbourFiles(document: vscode.TextDocument, budget: number): ExtraFile[] {
  let remaining = budget;
  const extraFiles: ExtraFile[] = [];

  for (const editor of vscode.window.visibleTextEditors) {
    const doc = editor.document;
    if (!isNeighbour(doc, document)) { continue; }

    const text = doc.getText();
    if (!text.trim() || text.length > remaining) { continue; }

    extraFiles.push({ path: vscode.workspace.asRelativePath(doc.uri), text });
    remaining -= text.length;
    if (remaining <= 0) { break; }
  }
  return extraFiles;
}

/** A different on-disk file written in the same language as the one being refactored. */
function isNeighbour(doc: vscode.TextDocument, document: vscode.TextDocument): boolean {
  return doc.uri.toString() !== document.uri.toString()
    && doc.uri.scheme === 'file'
    && doc.languageId === document.languageId;
}

/**
 * Stages an edit that did not come from a selection -- currently the agent's
 * insert_change. Deliberately routed through the same pending state, diff and
 * title-bar buttons as the refactor commands, so there is one approval path to
 * reason about rather than two.
 */
export async function stageExternalEdit(opts: {
  uri: vscode.Uri;
  range: vscode.Range;
  before: string;
  after: string;
  languageId: string;
  summary: string;
  output: vscode.OutputChannel;
}): Promise<void> {
  const document = await vscode.workspace.openTextDocument(opts.uri);
  const previewUris = await showDiff(document, opts.before, opts.after);

  await setPending({
    uri: opts.uri,
    range: opts.range,
    newText: opts.after,
    version: document.version,
    previewUris,
    summary: opts.summary,
    verify: false,
    errorsBefore: snapshotErrors(opts.uri),
    languageId: opts.languageId,
  });

  askApplyOrDiscard(`LocalAITab: ${opts.summary}`, opts.output);
}

/** A refactor that has been proposed and is waiting on the user. */
interface Pending {
  uri: vscode.Uri;
  range: vscode.Range;
  newText: string;
  version: number;
  previewUris: vscode.Uri[];
  summary: string;
  verify: boolean;
  errorsBefore: ErrorSnapshot;
  languageId: string;
}

let pending: Pending | undefined;

async function setPending(p: Pending): Promise<void> {
  pending = p;
  await vscode.commands.executeCommand('setContext', 'localAITab.hasPendingRefactor', true);
}

async function clearPending(): Promise<void> {
  pending = undefined;
  await vscode.commands.executeCommand('setContext', 'localAITab.hasPendingRefactor', false);
}

export function hasPendingRefactor(): boolean {
  return pending !== undefined;
}

export async function applyPending(output: vscode.OutputChannel): Promise<void> {
  const p = pending;
  if (!p) {
    vscode.window.showInformationMessage('LocalAITab: no refactor is waiting to be applied.');
    return;
  }

  const doc = await vscode.workspace.openTextDocument(p.uri);
  if (doc.version !== p.version) {
    vscode.window.showWarningMessage(
      'LocalAITab: the file changed since this refactor was proposed, so it was not applied.',
    );
    await discardPending();
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(p.uri, p.range, p.newText);
  const ok = await vscode.workspace.applyEdit(edit);

  if (!ok) {
    vscode.window.showErrorMessage('LocalAITab: the edit could not be applied.');
    return;
  }

  output.appendLine(`[refactor] applied (${p.summary})`);
  await closePreviewTabs(p.previewUris);
  await clearPending();

  // Put the cursor back in the file that was just changed.
  await vscode.window.showTextDocument(doc, { preserveFocus: false });
  vscode.window.setStatusBarMessage('LocalAITab: refactor applied (undo with cmd+z)', 3000);

  if (p.verify) {
    await verifyApplied(output, p, new vscode.Range(p.range.start, endOfInsertion(p.range.start, p.newText)));
  }
}

/**
 * Checks whether the edit we just made broke anything, using the diagnostics
 * the language server publishes for the file. If it did, offer to feed those
 * errors back to the model and let it repair its own work.
 */
async function verifyApplied(
  output: vscode.OutputChannel,
  p: Pending,
  written: vscode.Range,
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('localAITab');
  const attempts = cfg.get<number>('verifyAttempts', 1);

  let range = written;

  for (let attempt = 0; ; attempt++) {
    await waitForDiagnostics(p.uri, cfg.get<number>('verifyTimeoutMs', 4000));
    const introduced = newErrorsSince(p.errorsBefore, p.uri);

    if (!introduced.length) {
      output.appendLine('[verify] no new errors');
      vscode.window.setStatusBarMessage('LocalAITab: verified, no new errors', 3000);
      return;
    }

    output.appendLine(`[verify] ${introduced.length} new error(s):\n${describeErrors(introduced)}`);

    const exhausted = attempt >= attempts;
    const repaired = exhausted ? undefined : await repair(output, p, range, introduced);
    if (!repaired) {
      const why = exhausted ? ' and could not be repaired automatically' : '';
      await offerUndo(output, `LocalAITab: this change introduced ${introduced.length} error(s)${why}.`);
      return;
    }
    range = repaired;
  }
}

/** The last word on errors a refactor left behind: undo it, read the log, or keep it. */
async function offerUndo(output: vscode.OutputChannel, message: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(message, 'Undo', 'Show log', 'Keep anyway');
  if (choice === 'Undo') { await vscode.commands.executeCommand('undo'); }
  else if (choice === 'Show log') { output.show(true); }
}

/** One repair round: hand the model its own errors and replace the range with the fix. */
async function repair(
  output: vscode.OutputChannel,
  p: Pending,
  range: vscode.Range,
  errors: vscode.Diagnostic[],
): Promise<vscode.Range | undefined> {
  const cfg = vscode.workspace.getConfiguration('localAITab');
  // The approved-fallback cache is already warm from the refactor that led here,
  // so this resolves without a second prompt.
  const target = await installedRefactorModel(cfg, output);
  if (!target) { return undefined; }

  const doc = await vscode.workspace.openTextDocument(p.uri);
  const current = doc.getText(range);

  const fixed = await requestRepair(output, cfg, target, p.languageId, current, errors);
  if (!fixed || fixed === current) { return undefined; }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(p.uri, range, fixed);
  if (!(await vscode.workspace.applyEdit(edit))) { return undefined; }

  return new vscode.Range(range.start, endOfInsertion(range.start, fixed));
}

/** Asks the model to fix the errors in `current`; undefined if the call failed. */
function requestRepair(
  output: vscode.OutputChannel,
  cfg: vscode.WorkspaceConfiguration,
  target: ModelTarget,
  languageId: string,
  current: string,
  errors: vscode.Diagnostic[],
): Thenable<string | undefined> {
  const user = buildRepairPrompt({ languageId, code: current, errors: describeErrors(errors) });

  return withCancellableProgress('LocalAITab: fixing errors it introduced', async (signal) => {
    try {
      const { res } = await askRefactorModel(cfg, target, user, signal);
      output.appendLine(`[repair] ${res.totalMs}ms ${res.evalCount}tok`);
      return matchIndentation(current, cleanCode(res.text));
    } catch (err) {
      output.appendLine(`[repair error] ${(err as Error).message}`);
      return undefined;
    }
  });
}

export async function discardPending(): Promise<void> {
  const p = pending;
  await clearPending();
  if (p) { await closePreviewTabs(p.previewUris); }
}

/** Closes the diff tab belonging to a proposal, leaving the user's own tabs alone. */
async function closePreviewTabs(uris: vscode.Uri[]): Promise<void> {
  const wanted = new Set(uris.map((u) => u.toString()));

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) {
        if (wanted.has(input.original.toString()) || wanted.has(input.modified.toString())) {
          await vscode.window.tabGroups.close(tab, false);
        }
      }
    }
  }
}

/**
 * Closing the diff is the natural way to say no, so treat it as a discard
 * rather than leaving a proposal pending against a tab that no longer exists.
 */
export function watchForPreviewClose(): vscode.Disposable {
  return vscode.window.tabGroups.onDidChangeTabs((e) => {
    if (!pending) { return; }
    const wanted = new Set(pending.previewUris.map((u) => u.toString()));

    for (const tab of e.closed) {
      const input = tab.input;
      if (input instanceof vscode.TabInputTextDiff) {
        if (wanted.has(input.original.toString()) || wanted.has(input.modified.toString())) {
          void clearPending();
          return;
        }
      }
    }
  });
}

async function showDiff(
  document: vscode.TextDocument,
  before: string,
  after: string,
): Promise<vscode.Uri[]> {
  const provider = getPreviewProvider();
  if (!provider) { return []; }

  const ext = extensionFor(document);
  const n = ++previewSeq;
  const beforeUri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/before-${n}${ext}`);
  const afterUri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/after-${n}${ext}`);

  provider.set(beforeUri, before);
  provider.set(afterUri, after);

  await vscode.commands.executeCommand(
    'vscode.diff',
    beforeUri,
    afterUri,
    'LocalAITab: proposed refactor -- Apply or Discard',
    { preview: true, preserveFocus: false },
  );

  return [beforeUri, afterUri];
}

/** Set once at activation so showDiff can reach the registered provider. */
let sharedProvider: PreviewProvider | undefined;
export function setPreviewProvider(p: PreviewProvider): void { sharedProvider = p; }
function getPreviewProvider(): PreviewProvider | undefined { return sharedProvider; }

function extensionFor(document: vscode.TextDocument): string {
  const m = document.uri.path.match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0] : '.txt';
}
