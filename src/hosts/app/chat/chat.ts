import * as vscode from 'vscode';
import * as path from 'path';
import {
  chatStream, getCapabilities, getContextWindow, ChatMessage, ContextWindow, GenerateResult,
} from '../../../core/llm/ollama';
import { Conversation, Mode, LoopMode, Turn, TurnResult } from '../../../core/harness/conversation';
import {
  buildSketch, planQueries, runPlan, materialise, PlanSelection, PlannedQuery, PlanOutcome,
} from './plan';
import { ContextPiece, CollectedContext } from './context';
import { SessionStore, TurnRecord, PROJECTS_DIR, SESSIONS_DIR, convertSessions } from '../../../core/harness/sessions';
import { LiveSession } from '../../../core/harness/live';
import { editorHost, reviewTarget } from './host';
import { ensureInstructModel } from '../modelguard';
import {
  absolutePath, displayPath, configuredFolders, stat, listFolder, browseFiles, browseFolder, pickFiles,
} from './access';

// The palette's New Skill command reaches skills through the panel's module,
// which keeps chat.ts the one way into this feature.
export { scaffoldSkill } from './skills';
import {
  ContextKind, KIND_LABELS, collectContext, renderContext, CHAT_SYSTEM_PROMPT, EditorAnchor,
  Pin, pins, describePin,
} from './context';

const DEFAULT_KINDS: ContextKind[] = ['selection', 'file'];
const EXCLUDED = '**/{node_modules,.git,dist,build,out,target,.venv,__pycache__}/**';

const MODES: Mode[] = ['chat', 'agent', 'operator'];

type WebviewMessage = { type: string; [k: string]: unknown };

/**
 * How a tool loop's trace abbreviates a step: the result shown under it, and
 * the status line while the tool runs. Agent and operator steps share a shape.
 */
interface StepBrief {
  result(step: { tool: string; result: string }): string;
  toolLine(tool: string, args: Record<string, unknown>): string;
}

const AGENT_BRIEF: StepBrief = {
  result: (step) => step.result.slice(0, 300),
  toolLine: (tool, args) => `${tool} ${JSON.stringify(args).slice(0, 120)}`,
};

/** A command's verdict is its exit line plus the tail, not the head. */
const OPERATOR_BRIEF: StepBrief = {
  result: (step) => (step.tool === 'run_command' ? commandVerdict(step.result) : AGENT_BRIEF.result(step)),
  toolLine: (tool, args) => (tool === 'run_command' ? `$ ${String(args.command ?? '')}` : AGENT_BRIEF.toolLine(tool, args)),
};

/**
 * Hands an edit the agent proposed to the extension's review flow. Injected
 * rather than imported so chat does not depend on the refactor feature.
 */
export type StageEdit = (edit: {
  uri: vscode.Uri;
  range: vscode.Range;
  before: string;
  after: string;
  languageId: string;
  summary: string;
  output: vscode.OutputChannel;
}) => Promise<void>;

export class ChatPanel {
  private static current: ChatPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  /** The thread, the skills, and the tool loops behind agent and operator mode. */
  private readonly conversation: Conversation;
  /** Pins made before the panel opened are attached from the start. */
  private kinds = new Set<ContextKind>(pins.all().length ? ['pinned', ...DEFAULT_KINDS] : DEFAULT_KINDS);
  private pickedFiles: vscode.Uri[] = [];
  private inFlight?: AbortController;
  private mode: Mode = 'chat';
  /** Set by instructModel(): what the last request actually ran on. */
  private guardedModel?: string;
  /** Materialised from what the user ticked in the search planner. */
  private searchPieces: ContextPiece[] = [];
  /** Skill problems last logged; skills are rescanned whenever the panel comes back into view. */
  private skillProblems = '';
  /** Granted with /allow; lasts as long as the panel. localAITab.extraFolders is the lasting kind. */
  private grantedFolders: vscode.Uri[] = [];
  private lastPlanFiles: Array<{ path: string; hits: Array<{ line: number; text: string }> }> = [];
  /** Per-mode totals, so the modes can be compared on real usage. */
  private tally = {
    chat: { runs: 0, ms: 0, promptTokens: 0, replyTokens: 0, steps: 0 },
    agent: { runs: 0, ms: 0, promptTokens: 0, replyTokens: 0, steps: 0 },
    operator: { runs: 0, ms: 0, promptTokens: 0, replyTokens: 0, steps: 0 },
  };

  /**
   * Characters per token, used to estimate usage before a request exists.
   * Ollama exposes no tokenizer endpoint, so this starts at a code-weighted
   * guess and is corrected against prompt_eval_count after every reply.
   */
  private charsPerToken = 3.6;
  private lastPromptTokens = 0;
  private lastReplyTokens = 0;

  /** Captured before the panel is created, since opening it steals focus. */
  private readonly anchor = new EditorAnchor();
  private readonly sessions: SessionStore;
  /** ~/.localaitab/sessions/<extension host pid>.json while the panel is open: one per window. */
  private readonly live: LiveSession;

  /** Routes a palette command into the open panel, if there is one. */
  static send(message: { type: string; [k: string]: unknown }): void {
    void ChatPanel.current?.onMessage(message);
  }

  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel, stageEdit: StageEdit): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    ChatPanel.current = new ChatPanel(context, output, stageEdit);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly stageEdit: StageEdit,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'localAITab.chat',
      'LocalAITab Chat',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    const host = editorHost(output, () => this.guardedModel ?? this.model());
    this.conversation = new Conversation({
      ...host,
      // A monitor shows the panel as waiting on the person while the modal is up.
      approve: async (command, cwd) => {
        this.live.setStatus('waiting');
        try { return await host.approve(command, cwd); } finally { this.live.setStatus('busy'); }
      },
    });
    const workspace = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    this.sessions = new SessionStore(PROJECTS_DIR, workspace, output);
    this.live = new LiveSession({ entrypoint: 'localaitab-vscode', cwd: workspace(), sessionId: this.sessions.sessionId, log: output });
    this.sessions.onChange((id, title) => this.live.setSession(id, title));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.live.setCwd(workspace())));
    void this.restore();

    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) { void this.refreshSkills(); }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m), null, this.disposables);

    // Keep the context preview honest as the user moves around the editor.
    this.disposables.push(
      ...this.anchor.watch(),
      vscode.window.onDidChangeActiveTextEditor(() => void this.pushPreview()),
      vscode.window.onDidChangeTextEditorSelection(() => void this.pushPreview()),
    );

    void this.pushPreview();
  }

  /**
   * Picks up the most recent transcript for this workspace on open. Closing the
   * panel should not throw away the thread, which is the whole point of keeping
   * it on disk; New session is one click away when a clean start is wanted.
   */
  private async restore(): Promise<void> {
    // Conversations from before they took Claude Code's shape: those the terminal
    // and the panel shared, and older ones the panel kept in VS Code's own storage.
    for (const from of [SESSIONS_DIR, path.join(this.context.globalStorageUri.fsPath, 'sessions')]) {
      const converted = await convertSessions(from, PROJECTS_DIR, this.output);
      if (converted) { this.output.appendLine(`[sessions] converted ${converted} conversation(s) from ${from} into ${PROJECTS_DIR}`); }
    }
    const recent = await this.sessions.mostRecent();
    if (!recent) {
      await this.sessions.startNew();
      this.postSession();
      return;
    }

    const turns = await this.sessions.resume(recent.id);
    this.replay(turns);
    this.output.appendLine(`[sessions] resumed ${recent.id} (${turns.length} turns)`);
  }

  /** Makes a resumed session the live thread and plays it back into the transcript. */
  private replay(turns: TurnRecord[]): void {
    this.conversation.resume(turns.map((t) => ({ role: t.role, content: t.content })));

    for (const t of turns) {
      this.post({ type: 'replay', role: t.role, content: t.display ?? t.content, mode: t.mode });
    }
    this.postSession();
  }

  private postSession(): void {
    this.post({
      type: 'session',
      id: this.sessions.sessionId,
      turns: Math.ceil(this.conversation.history.length / 2),
    });
  }

  private async newSession(): Promise<void> {
    await this.sessions.startNew();
    this.conversation.clear();
    this.post({ type: 'cleared' });
    this.postSession();
    await this.pushPreview();
  }

  /** Lists saved transcripts and loads the chosen one. */
  private async pickSession(): Promise<void> {
    const list = await this.sessions.list();
    if (!list.length) {
      vscode.window.showInformationMessage('LocalAITab Chat: no saved conversations yet.');
      return;
    }

    const items = list.map((s) => ({
      label: s.title || '(empty)',
      description: `${plural(s.turns, 'turn')} - ${new Date(s.updated).toLocaleString()}`,
      detail: s.id === this.sessions.sessionId ? 'current session' : undefined,
      id: s.id,
    }));

    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: 'Resume a conversation',
      matchOnDescription: true,
    });
    if (!chosen || chosen.id === this.sessions.sessionId) { return; }

    const turns = await this.sessions.resume(chosen.id);
    this.post({ type: 'cleared' });
    this.replay(turns);
    await this.pushPreview();
  }

  private dispose(): void {
    ChatPanel.current = undefined;
    this.inFlight?.abort();
    this.live.close();
    for (const d of this.disposables) { d.dispose(); }
    this.panel.dispose();
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  /**
   * What the in-flight request is waiting on right now. Ollama gives no progress
   * events, so each phase is inferred from where the request is: before the
   * first byte a cold model is loading (or a warm one is reading the prompt),
   * then thinking and answer deltas arrive on separate fields.
   */
  private status(phase: 'context' | 'loading' | 'prompt' | 'thinking' | 'generating' | 'tool', detail = '', contextChars?: number): void {
    this.post({ type: 'status', phase, detail, contextChars });
  }

  /** One handler per message the webview sends; anything else is ignored. */
  private readonly handlers = new Map<string, (m: WebviewMessage) => unknown>(Object.entries({
    ready: () => this.init(),
    toggleKind: (m: WebviewMessage) => this.toggleKind(m.id as ContextKind),
    pickFiles: async () => { await this.choosePickedFiles(); await this.pushPreview(); },
    attach: (m: WebviewMessage) => this.attach(m),
    allow: (m: WebviewMessage) => this.allow(field(m, 'arg')),
    detach: (m: WebviewMessage) => { this.detach(field(m, 'arg')); return this.pushPreview(); },
    pinned: (m: WebviewMessage) => this.pinned(m.added as Pin[]),
    unpin: (m: WebviewMessage) => { this.unpin(field(m, 'arg')); return this.pushPreview(); },
    send: (m: WebviewMessage) => this.dispatch(field(m, 'text')),
    skill: (m: WebviewMessage) => this.runSkill(m),
    listSkills: () => this.refreshSkills(true),
    setMode: (m: WebviewMessage) => this.setMode(m.mode),
    stats: () => this.post({ type: 'stats', tally: this.tally }),
    plan: (m: WebviewMessage) => this.plan(field(m, 'task')),
    planSelect: (m: WebviewMessage) => this.applyPlanSelection(m.selection as unknown as PlanSelection),
    stop: () => this.inFlight?.abort(),
    newSession: () => this.newSession(),
    pickSession: () => this.pickSession(),
    revealSessions: () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.sessions.folder())),
    reset: () => { this.conversation.clear(); this.post({ type: 'cleared' }); },
    insert: (m: WebviewMessage) => insertIntoEditor(field(m, 'code')),
    copy: (m: WebviewMessage) => copyToClipboard(field(m, 'code')),
  }));

  private async onMessage(m: WebviewMessage): Promise<void> {
    await this.handlers.get(m.type)?.(m);
  }

  private async init(): Promise<void> {
    this.post({
      type: 'init',
      kinds: Object.entries(KIND_LABELS).map(([id, label]) => ({
        id, label, on: this.kinds.has(id as ContextKind),
      })),
      model: this.model(),
      mode: this.mode,
    });
    await this.refreshSkills();
    await this.pushPreview();
  }

  /** Turning on picked files with none chosen yet opens the picker. */
  private async toggleKind(id: ContextKind): Promise<void> {
    const on = !this.kinds.delete(id);
    if (on) { this.kinds.add(id); }
    if (on && id === 'pickedFiles' && !this.pickedFiles.length) {
      await this.choosePickedFiles();
    }
    await this.pushPreview();
  }

  /** /attach, or the explorer's attach command, whose files arrive already resolved. */
  private async attach(m: WebviewMessage): Promise<void> {
    const uris = Array.isArray(m.uris)
      ? (m.uris as vscode.Uri[])
      : await this.resolveAttach(field(m, 'arg'));
    if (uris.length) { this.addPicked(uris); }
    await this.pushPreview();
  }

  private setMode(mode: unknown): void {
    this.mode = MODES.includes(mode as Mode) ? mode as Mode : 'chat';
    this.post({ type: 'mode', mode: this.mode });
  }

  private model(): string {
    const cfg = vscode.workspace.getConfiguration('localAITab');
    return cfg.get<string>('chatModel', '') || cfg.get<string>('refactorModel', 'qwen3.6:35b-a3b-coding');
  }

  /**
   * The configured model, or the stand-in the user approved when it is not
   * installed; undefined when they declined (caller aborts). Remembered so the
   * conversation's loop, which reads the model from the host, runs on it too.
   */
  private async instructModel(cfg: vscode.WorkspaceConfiguration): Promise<string | undefined> {
    const endpoint = cfg.get<string>('endpoint', 'http://localhost:11434');
    const model = await ensureInstructModel(endpoint, this.model(), this.output);
    if (model) { this.guardedModel = model; }
    return model;
  }

  private async choosePickedFiles(): Promise<void> {
    const chosen = await this.pickAmong(await workspaceFiles(), 'Pick files to attach as context');
    if (chosen.length) {
      this.pickedFiles = chosen;
      this.kinds.add('pickedFiles');
    }
  }

  /**
   * Resolves the argument of /attach to files. An exact path (file or folder)
   * wins; otherwise the argument is a glob, or a fragment of a file name. More
   * than one match goes through a picker rather than attaching a whole sweep
   * the user never looked at.
   */
  private async resolveAttach(arg: string): Promise<vscode.Uri[]> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!arg) {
      return root ? this.pickAmong(await workspaceFiles(), 'Pick files to attach as context') : browseFiles();
    }
    const abs = absolutePath(arg);
    if (abs) { return this.attachAbsolute(vscode.Uri.file(abs), arg); }
    if (!root) {
      this.notice('/attach with a relative path needs an open workspace folder.', 'error');
      return [];
    }

    const exact = vscode.Uri.joinPath(root, arg);
    const type = await stat(exact);
    if (type === vscode.FileType.File) { return [exact]; }

    const found = await vscode.workspace.findFiles(attachGlob(arg, exact, type), EXCLUDED, 500);
    if (found.length > 1) {
      return this.pickAmong(found, `${found.length} files match "${arg}" - pick the ones to attach`);
    }
    if (!found.length) { this.notice(`/attach: nothing matches "${arg}".`, 'error'); }
    return found;
  }

  /**
   * An absolute or ~ path is the user naming a file themselves, so it may be
   * anywhere. A folder is walked directly: findFiles only sees workspace folders.
   */
  private async attachAbsolute(uri: vscode.Uri, arg: string): Promise<vscode.Uri[]> {
    const type = await stat(uri);
    if (type === vscode.FileType.File) { return [uri]; }
    if (type === vscode.FileType.Directory) {
      return this.pickAmong(await listFolder(uri), `Files under ${displayPath(uri)} - pick the ones to attach`);
    }
    this.notice(`/attach: ${arg} does not exist.`, 'error');
    return [];
  }

  private pickAmong(uris: vscode.Uri[], placeHolder: string): Promise<vscode.Uri[]> {
    return pickFiles(uris, placeHolder, new Set(this.pickedFiles.map((u) => u.toString())));
  }

  private inWorkspace(uri: vscode.Uri): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
  }

  /** Folders outside the workspace the agent may read: the setting, then /allow grants. */
  private allowedFolders(): vscode.Uri[] {
    const seen = new Set<string>();
    return [...configuredFolders(), ...this.grantedFolders].filter((u) => {
      if (seen.has(u.fsPath)) { return false; }
      seen.add(u.fsPath);
      return true;
    });
  }

  /** /allow [folder]: lets the agent read a folder outside the workspace until the panel closes. */
  private async allow(arg: string): Promise<void> {
    let folder: vscode.Uri | undefined;
    if (arg) {
      const abs = absolutePath(arg);
      if (!abs) {
        this.notice('/allow needs an absolute path or one starting with ~/.', 'error');
        return;
      }
      folder = vscode.Uri.file(abs);
    } else {
      folder = await browseFolder();
      if (!folder) { return; }
    }

    if ((await stat(folder)) !== vscode.FileType.Directory) {
      this.notice(`/allow: ${displayPath(folder)} is not a folder.`, 'error');
      return;
    }
    if (this.inWorkspace(folder)) {
      this.notice(`${displayPath(folder)} is inside the workspace; the agent can already read it.`);
      return;
    }
    if (!this.allowedFolders().some((u) => u.fsPath === folder!.fsPath)) { this.grantedFolders.push(folder); }

    this.output.appendLine(`[access] agent may read ${folder.fsPath} for this panel`);
    this.notice(
      `Agent mode may now read and search ${displayPath(folder)}, and stage edits there for your review, ` +
      `until this panel closes. Allowed: ${this.allowedFolders().map(displayPath).join(', ')}. ` +
      'To keep a folder, add it to localAITab.extraFolders in your user settings.',
    );
  }

  /** Adds to the chosen files rather than replacing them, as the picker chip does. */
  addPicked(uris: vscode.Uri[]): void {
    const have = new Set(this.pickedFiles.map((u) => u.toString()));
    const added = uris.filter((u) => !have.has(u.toString()));
    this.pickedFiles.push(...added);
    this.kinds.add('pickedFiles');

    const names = added.map(displayPath);
    this.notice(added.length
      ? `Attached ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}.`
      : 'Already attached.');
  }

  /** After the pin command: turns pinned lines on and says what was pinned. */
  private async pinned(added: Pin[]): Promise<void> {
    this.kinds.add('pinned');
    this.notice(added.length
      ? `Pinned ${added.map(describePin).join(', ')}. ${plural(pins.all().length, 'pin')} attached; /unpin drops them.`
      : 'Already pinned.');
    await this.pushPreview();
  }

  /** Drops pins whose "path:start-end" contains the argument, or all of them. */
  private unpin(arg: string): void {
    const removed = pins.remove(arg);
    if (!pins.all().length) { this.kinds.delete('pinned'); }

    if (removed) {
      this.notice(`Unpinned ${plural(removed, 'selection')}.`);
      return;
    }
    this.notice(arg ? `/unpin: no pin matches "${arg}".` : 'Nothing was pinned.', 'error');
  }

  /** Drops chosen files whose path contains the argument, or all of them. */
  private detach(arg: string): void {
    const before = this.pickedFiles.length;
    this.pickedFiles = arg
      ? this.pickedFiles.filter((u) => !displayPath(u).includes(arg))
      : [];
    const removed = before - this.pickedFiles.length;
    if (!this.pickedFiles.length) { this.kinds.delete('pickedFiles'); }

    if (removed) {
      this.notice(`Detached ${plural(removed, 'file')}.`);
      return;
    }
    this.notice(arg ? `/detach: no attached file matches "${arg}".` : 'No files were attached.', 'error');
  }

  /**
   * Rescans the skill folders and hands the invocable ones to the composer.
   * `show` asks the webview to list them, which is what /skills does.
   */
  private async refreshSkills(show = false): Promise<void> {
    const problems = await this.conversation.loadSkills(
      vscode.workspace.getConfiguration('localAITab').get<string[]>('skillPaths'),
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    );
    // Rescans happen on every focus change; only a new set of problems is news.
    const key = problems.join('\n');
    if (key !== this.skillProblems) {
      this.skillProblems = key;
      for (const p of problems) { this.output.appendLine(`[skills] skipped ${p}`); }
    }

    this.post({
      type: 'skills',
      show,
      skills: this.conversation.invocableSkills().map((s) => ({
        name: s.name, arg: s.argumentHint, help: s.description, dir: s.dir,
      })),
      problems: show ? problems : [],
    });
  }

  /**
   * /name args: sends the skill's instructions as the message, in whichever
   * mode is active. The transcript shows what was typed; the model and the
   * saved session get the expanded text, since that is what was sent.
   */
  private async runSkill(m: { [k: string]: unknown }): Promise<void> {
    const name = String(m.name ?? '');
    const arg = String(m.arg ?? '');
    const typed = String(m.text ?? '');
    await this.refreshSkills();
    const prompt = this.conversation.skillPrompt(name, arg, this.mode);
    if (prompt === undefined) {
      this.notice(`/${name}: that skill is gone. Type /skills for the current list.`, 'error');
      return;
    }

    const dir = this.conversation.invocableSkills().find((s) => s.name === name)?.dir;
    this.output.appendLine(`[skills] /${name} from ${dir}`);
    await this.dispatch(prompt, typed);
  }

  /** Sends a message through whichever mode is active. */
  private async dispatch(text: string, display = text): Promise<void> {
    switch (this.mode) {
      case 'agent': case 'operator': return this.sendLoop(this.mode, text, display);
      default: return this.send(text, display);
    }
  }

  private notice(text: string, level: 'info' | 'error' = 'info'): void {
    this.post({ type: 'notice', text, level });
  }

  /** Shows the user exactly what would be sent, before they send it. */
  private async pushPreview(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('localAITab');
    const { window, budget, collected, editor } = await this.gatherContext(cfg, this.model());

    this.post({
      type: 'preview',
      chars: collected.chars,
      budget,
      pieces: collected.pieces.map((p) => ({
        label: p.label, path: p.path, chars: p.text.length,
      })),
      skipped: collected.skipped,
      kinds: [...this.kinds],
      anchor: editor ? vscode.workspace.asRelativePath(editor.document.uri) : '',
      usage: this.previewUsage(cfg, window, budget, renderContext(collected).length),
    });
  }

  /**
   * Everything already committed to the next prompt. The webview adds the
   * draft in the composer on top of this, live as it is typed.
   */
  private previewUsage(
    cfg: vscode.WorkspaceConfiguration, window: ContextWindow, budget: number, contextChars: number,
  ) {
    return {
      systemChars: CHAT_SYSTEM_PROMPT.length,
      contextChars,
      historyChars: this.conversation.history.reduce((n, m) => n + m.content.length, 0),
      charsPerToken: this.charsPerToken,
      windowTokens: window.tokens,
      windowRunning: window.running,
      reserveTokens: cfg.get<number>('chatMaxTokens', 2048),
      capTokens: Math.round(budget / this.charsPerToken),
      turns: this.conversation.history.length / 2,
      lastPromptTokens: this.lastPromptTokens,
      lastReplyTokens: this.lastReplyTokens,
    };
  }

  /** Reads the model's window and gathers the context the user ticked, within the budget it leaves. */
  private async gatherContext(cfg: vscode.WorkspaceConfiguration, model: string) {
    const window = await getContextWindow(cfg.get<string>('endpoint', 'http://localhost:11434'), model);
    const budget = this.budgetChars(window.tokens, cfg);
    const editor = this.anchor.current();
    const collected = await collectContext(this.kinds, this.pickedFiles, budget, editor, this.searchPieces);
    return { window, budget, collected, editor };
  }

  /**
   * Asks the model for a ripgrep plan, runs it locally, and hands the results
   * back for the user to tick. Nothing reaches the prompt until they do.
   */
  private async plan(task: string): Promise<void> {
    if (!task.trim() || this.inFlight) { return; }

    const cfg = vscode.workspace.getConfiguration('localAITab');
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) {
      this.post({ type: 'error', message: 'Search planning needs an open workspace folder.' });
      return;
    }

    const model = await this.instructModel(cfg);
    if (!model) { return; }

    this.post({ type: 'planBegin', task });
    await this.track('plan', async (signal) => {
      const globs = cfg.get<string>('planGlobs', '!{node_modules,.git,dist,build,out,target}/**');
      const sketch = await buildSketch(root, cfg.get<number>('planMaxSymbols', 160), globs);
      this.post({ type: 'planSketch', files: sketch.files.length, symbols: sketch.symbols.length });

      const queries = await planQueries({
        task,
        endpoint: cfg.get<string>('endpoint', 'http://localhost:11434'),
        model,
        temperature: cfg.get<number>('planTemperature', 0.2),
        keepAlive: cfg.get<string>('keepAlive', '30m'),
        signal,
        sketch,
      });

      const outcome = await runPlan({
        queries,
        root,
        defaultGlobs: globs,
        contextLines: cfg.get<number>('planContextLines', 4),
        maxHitsPerFile: cfg.get<number>('planMaxHitsPerFile', 6),
        maxFiles: cfg.get<number>('planMaxFiles', 20),
      });
      this.reportPlan(queries, outcome);
    });
  }

  /** Hands the search results to the planner pane for the user to tick. */
  private reportPlan(queries: PlannedQuery[], outcome: PlanOutcome): void {
    this.lastPlanFiles = outcome.files.map((f) => ({ path: f.path, hits: f.hits }));
    this.output.appendLine(
      `[plan] ${queries.length} queries -> ${outcome.totalHits} hits in ${outcome.files.length} files ` +
      `(${outcome.emptyQueries.length} empty) ${outcome.ms}ms`,
    );

    this.post({
      type: 'planResult',
      queries: queries.map((q) => ({ pattern: q.pattern, glob: q.glob ?? '', why: q.why ?? '' })),
      files: this.lastPlanFiles,
      totalHits: outcome.totalHits,
      emptyQueries: outcome.emptyQueries,
      ms: outcome.ms,
    });
  }

  private async applyPlanSelection(selection: PlanSelection): Promise<void> {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) { return; }

    const cfg = vscode.workspace.getConfiguration('localAITab');
    const pieces = await materialise(selection, root, cfg.get<number>('planContextLines', 4));

    this.searchPieces = pieces.map((p) => ({
      label: p.label, path: p.path, text: p.text, language: p.language,
    }));

    if (this.searchPieces.length) { this.kinds.add('searchHits'); }
    else { this.kinds.delete('searchHits'); }

    this.output.appendLine(
      `[plan] attached ${this.searchPieces.length} piece(s), ` +
      `${this.searchPieces.reduce((n, p) => n + p.text.length, 0)} chars`,
    );
    await this.pushPreview();
  }

  /**
   * Agent and operator mode: the model drives a bounded tool loop instead of
   * answering in one shot. In agent mode read-only tools run unattended and an
   * edit only ever gets staged for the same approval diff the refactor
   * commands use. Operator mode edits directly and runs shell commands, each
   * shown to the user in a modal first; it is kept apart so agent mode stays
   * the safe, staged default.
   */
  private async sendLoop(mode: LoopMode, text: string, display = text): Promise<void> {
    if (!text.trim() || this.inFlight) { return; }

    const where = this.loopRoots(mode);
    if (!where) {
      this.post({
        type: 'error',
        message: mode === 'agent'
          ? 'Agent mode needs an open workspace folder, or a folder granted with /allow.'
          : 'Operator mode needs an open workspace folder.',
      });
      return;
    }

    const cfg = vscode.workspace.getConfiguration('localAITab');
    const model = await this.instructModel(cfg);
    if (!model) { return; }
    const opening = await this.beginToolRun(display, cfg, model, mode);
    await this.saveQuestion(text, display, opening.collected, mode, model);

    await this.track(mode, async (signal) => {
      const turn: Turn = {
        ...where,
        contextBlock: opening.contextBlock,
        signal,
        events: this.sessions.record(this.loopEvents(model, opening.warm, opening.collected.chars, mode === 'agent' ? AGENT_BRIEF : OPERATOR_BRIEF)),
      };
      const result = await this.conversation.run(mode, text, turn);
      await this.recordLoopTurn(model, result);
      await this.reportLoopEnd(result);
      await this.pushPreview();
    });
  }

  /**
   * Where a loop may work. With no workspace open, agent mode takes a granted
   * folder in its stead, so notes outside any project can still be worked on;
   * operator mode runs commands, and only ever in a workspace.
   */
  private loopRoots(mode: LoopMode): { root: string; extraRoots: string[] } | undefined {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (mode === 'operator') { return workspace && { root: workspace.fsPath, extraRoots: [] }; }
    const extraRoots = this.allowedFolders();
    const root = workspace ?? extraRoots[0];
    return root && { root: root.fsPath, extraRoots: extraRoots.map((u) => u.fsPath) };
  }

  /** Mirrors a tool loop into the panel's trace and status line. */
  private loopEvents(model: string, warm: boolean, contextChars: number, brief: StepBrief): Turn['events'] {
    return {
      onStep: (step) => this.post({
        type: 'agentStep',
        index: step.index,
        tool: step.tool,
        args: JSON.stringify(step.args).slice(0, 200),
        result: brief.result(step),
        ok: step.ok,
        ms: step.ms,
      }),
      // Tool calls come back whole, not streamed, so a step is one wait. Only
      // the first can be a cold model loading, and only it carries the context.
      onThinking: (step, max) => {
        if (step === 1 && !warm) {
          this.status('loading', `${model} into memory`, contextChars);
          return;
        }
        this.status('thinking', `step ${step} of ${max}`, step === 1 ? contextChars : undefined);
      },
      onToolStart: (tool, args) => this.status('tool', brief.toolLine(tool, args)),
    };
  }

  /** Saves the turn the conversation just added to its thread, if it added one. */
  private async recordLoopTurn(model: string, result: TurnResult): Promise<void> {
    this.lastPromptTokens = result.promptTokens;
    this.lastReplyTokens = result.replyTokens;
    if (!result.note) { return; }

    await this.saveAnswer({
      content: result.note, mode: result.mode, model,
      promptTokens: result.promptTokens, replyTokens: result.replyTokens,
      ms: result.totalMs, steps: result.steps.length,
      staged: result.mode === 'agent' ? result.staged?.path : undefined,
    });
  }

  /** Closes the run in the panel and hands any staged edit to the review diff. */
  private async reportLoopEnd(result: TurnResult): Promise<void> {
    this.countLoopRun(result);
    const staged = result.mode === 'agent' ? result.staged : undefined;
    this.postAgentEnd(result, staged?.path ?? '', result.mode === 'operator' ? result.changed : []);

    if (staged) {
      await this.stageEdit({
        ...(await reviewTarget(staged)),
        before: staged.before,
        after: staged.after,
        summary: `agent proposed a change to ${staged.path}`,
        output: this.output,
      });
    }

    const changed = result.mode === 'operator' ? `changed=${result.changed.length} ` : '';
    this.output.appendLine(
      `[${result.mode}] done in ${result.steps.length} step(s) ${result.totalMs}ms ` +
      `prompt=${result.promptTokens}tok reply=${result.replyTokens}tok ` +
      `${changed}${result.hitCap ? 'HIT CAP' : 'terminated'}`,
    );
  }

  /** Opens the reply in the panel and gathers the context the user ticked. */
  private async beginToolRun(
    display: string, cfg: vscode.WorkspaceConfiguration, model: string, label: 'agent' | 'operator',
  ) {
    this.post({ type: 'userMessage', text: display });
    this.post({ type: 'agentBegin', model, label });
    this.status('context');

    const { window, collected } = await this.gatherContext(cfg, model);
    return { warm: window.running, collected, contextBlock: renderContext(collected) };
  }

  /**
   * Runs a request as the one in flight, so Stop can abort it and no other
   * starts meanwhile. A failure is logged under `tag` and shown in the panel,
   * except one the user caused with Stop when `onAbort` says how that ends.
   */
  private async track(
    tag: Mode | 'plan', run: (signal: AbortSignal) => Promise<void>, onAbort?: () => void,
  ): Promise<void> {
    const ac = new AbortController();
    this.inFlight = ac;
    this.live.setStatus('busy');
    try {
      await run(ac.signal);
    } catch (err) {
      if (ac.signal.aborted && onAbort) { onAbort(); return; }
      const message = (err as Error).message;
      this.output.appendLine(`[${tag} error] ${message}`);
      this.post({ type: 'error', message });
    } finally {
      if (this.inFlight === ac) { this.inFlight = undefined; this.live.setStatus('idle'); }
    }
  }

  /** Saves a question as it is sent; its run and answer follow it in the file. */
  private async saveQuestion(text: string, display: string, collected: CollectedContext, mode: Mode, model: string): Promise<void> {
    await this.sessions.prompt({
      content: text, display, mode, model,
      sources: collected.pieces.map((p) => p.label), contextChars: collected.chars,
    });
  }

  /** Saves the answer that closes the question; the conversation already holds it. */
  private async saveAnswer(reply: Omit<TurnRecord, 'at' | 'role'>): Promise<void> {
    await this.sessions.answer(reply);
    this.postSession();
  }

  private countLoopRun(result: TurnResult): void {
    const t = this.tally[result.mode];
    t.runs++; t.ms += result.totalMs; t.steps += result.steps.length;
    t.promptTokens += result.promptTokens; t.replyTokens += result.replyTokens;
  }

  private postAgentEnd(outcome: TurnResult, staged: string, changed: string[]): void {
    this.post({
      type: 'agentEnd',
      answer: outcome.answer,
      hitCap: outcome.hitCap,
      aborted: outcome.aborted,
      steps: outcome.steps.length,
      ms: outcome.totalMs,
      promptTokens: outcome.promptTokens,
      replyTokens: outcome.replyTokens,
      staged,
      changed,
    });
  }

  /**
   * The cap on attached context, in characters.
   *
   * Derived from the model's actual window rather than being a fixed number:
   * a standalone character budget was both meaningless next to the window meter
   * and far too small, capping attachments at ~14% of an available 65k window.
   */
  private budgetChars(windowTokens: number, cfg: vscode.WorkspaceConfiguration): number {
    const explicit = cfg.get<number>('chatContextTokens', 0);
    const percent = cfg.get<number>('chatContextPercent', 60);
    const reserve = cfg.get<number>('chatMaxTokens', 2048);

    // With no window information, fall back to something that fits any model.
    const available = windowTokens ? Math.max(0, windowTokens - reserve) : 8000;
    const tokens = explicit > 0 ? explicit : Math.round(available * (percent / 100));

    return Math.round(tokens * this.charsPerToken);
  }

  /** Corrects the chars-per-token estimate against the model's own count. */
  private calibrate(promptChars: number, promptTokens: number | undefined): void {
    if (!promptTokens || promptTokens < 50) { return; }
    const observed = promptChars / promptTokens;
    // Smoothed, so one odd turn does not swing the meter.
    this.charsPerToken = this.charsPerToken * 0.6 + observed * 0.4;
  }

  private async send(text: string, display = text): Promise<void> {
    if (!text.trim() || this.inFlight) { return; }

    const cfg = vscode.workspace.getConfiguration('localAITab');
    const model = await this.instructModel(cfg);
    if (!model) { return; }
    this.post({ type: 'userMessage', text: display });
    this.post({ type: 'begin', model });
    this.status('context');

    const { window, collected } = await this.gatherContext(cfg, model);
    const messages = this.chatMessages(text, renderContext(collected));
    const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
    this.announcePrompt(window.running, model, promptChars, collected.chars);
    await this.saveQuestion(text, display, collected, 'chat', model);

    await this.track('chat', async (signal) => {
      const res = await this.streamReply(cfg, model, messages, signal);
      await this.recordChatTurn(text, model, promptChars, res);
      this.output.appendLine(
        `[chat] ${model} ${res.totalMs}ms prompt=${res.promptEvalCount ?? '?'}tok ` +
        `reply=${res.evalCount}tok context=${collected.chars}ch ` +
        `chars/token=${this.charsPerToken.toFixed(2)}`,
      );
      this.post({
        type: 'end', ms: res.totalMs, tokens: res.evalCount,
        promptTokens: res.promptEvalCount,
      });
      await this.pushPreview();
    }, () => this.post({ type: 'end', aborted: true }));
  }

  /**
   * Context rides in the system message so it stays at the prompt prefix,
   * which keeps it reusable across turns instead of re-sent per message.
   */
  private chatMessages(text: string, contextBlock: string): ChatMessage[] {
    return [
      { role: 'system', content: contextBlock ? `${CHAT_SYSTEM_PROMPT}\n\n${contextBlock}` : CHAT_SYSTEM_PROMPT },
      ...this.conversation.history,
      { role: 'user', content: text },
    ];
  }

  /** Tells the user what the wait is about to be: prompt size, or a cold model loading. */
  private announcePrompt(warm: boolean, model: string, promptChars: number, contextChars: number): void {
    if (warm) {
      this.status('prompt', `~${Math.round(promptChars / this.charsPerToken).toLocaleString()} tokens`, contextChars);
    } else {
      this.status('loading', `${model} into memory`, contextChars);
    }
  }

  /** Streams the reply into the panel, moving the status line from thinking to generating. */
  private async streamReply(
    cfg: vscode.WorkspaceConfiguration, model: string, messages: ChatMessage[], signal: AbortSignal,
  ): Promise<GenerateResult> {
    const endpoint = cfg.get<string>('endpoint', 'http://localhost:11434');
    const caps = await getCapabilities(endpoint, model);
    let phase = '';
    return chatStream({
      endpoint,
      model,
      messages,
      temperature: cfg.get<number>('chatTemperature', 0.3),
      maxTokens: cfg.get<number>('chatMaxTokens', 2048),
      keepAlive: cfg.get<string>('keepAlive', '30m'),
      signal,
      think: caps.includes('thinking') ? cfg.get<boolean>('chatThinking', false) : undefined,
      onThinking: () => {
        if (phase !== 'thinking') { phase = 'thinking'; this.status('thinking'); }
      },
      onToken: (delta) => {
        if (phase !== 'generating') { phase = 'generating'; this.status('generating'); }
        this.post({ type: 'token', delta });
      },
    });
  }

  private async recordChatTurn(text: string, model: string, promptChars: number, res: GenerateResult): Promise<void> {
    this.calibrate(promptChars, res.promptEvalCount);
    this.lastPromptTokens = res.promptEvalCount ?? 0;
    this.lastReplyTokens = res.evalCount;

    const t = this.tally.chat;
    t.runs++; t.ms += res.totalMs;
    t.promptTokens += res.promptEvalCount ?? 0; t.replyTokens += res.evalCount;

    this.conversation.remember(text, res.text);
    await this.saveAnswer({
      content: res.text, mode: 'chat', model,
      promptTokens: res.promptEvalCount, replyTokens: res.evalCount, ms: res.totalMs,
    });
  }

  /**
   * The stylesheet and script live in media/ rather than inline: embedding them
   * in a template literal meant every backslash needed escaping twice, which
   * silently broke the code-fence regex once already.
   */
  private html(): string {
    const w = this.panel.webview;
    const uri = (f: string) =>
      w.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = makeNonce();

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${uri('chat.css')}">
</head>
<body>
  <div id="modebar">
    <button id="mChat" class="mode on">Chat</button>
    <button id="mAgent" class="mode">Agent</button>
    <button id="mOperator" class="mode">Operator</button>
    <span class="hint" id="modeHint">one shot, context you pick</span>
    <button id="ab" class="secondary tiny">A/B stats</button>
  </div>

  <div id="sessionbar">
    <span id="sessionInfo" class="dim"></span>
    <button id="sNew" class="secondary tiny">New session</button>
    <button id="sOpen" class="secondary tiny">History</button>
    <button id="sReveal" class="secondary tiny">Show files</button>
  </div>

  <div id="context">
    <div class="chips" id="chips"></div>
    <div id="summary"></div>
    <div id="anchor"></div>
    <div id="detail"></div>
    <div id="meterWrap">
      <div id="meter"></div>
      <div id="track"><div id="bar"></div><div id="cap" class="hidden"></div></div>
    </div>
  </div>

  <div id="planPane" class="hidden">
    <div id="planHead"></div>
    <div id="planQueries"></div>
    <div id="planFiles"></div>
    <div class="row">
      <button id="planAttach">Attach ticked</button>
      <button id="planAll" class="secondary tiny">All files</button>
      <button id="planNone" class="secondary tiny">None</button>
      <button id="planClose" class="secondary tiny">Close</button>
    </div>
  </div>

  <div id="log"></div>

  <div id="composer">
    <div id="suggest" class="hidden"></div>
    <textarea id="input" placeholder="Ask about the attached code, or / for commands  (Enter to send, Shift+Enter for a newline)"></textarea>
    <div class="row">
      <button id="send">Send</button>
      <button id="stop" class="secondary" disabled>Stop</button>
      <button id="find" class="secondary">Find context</button>
      <button id="reset" class="secondary">Clear</button>
      <span class="hint" id="model"></span>
    </div>
  </div>

  <script nonce="${nonce}" src="${uri('markdown.js')}"></script>
  <script nonce="${nonce}" src="${uri('commands.js')}"></script>
  <script nonce="${nonce}" src="${uri('chat.js')}"></script>
</body>
</html>`;
  }
}

async function insertIntoEditor(code: string): Promise<void> {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.scheme === 'file');
  if (!editor) {
    vscode.window.showWarningMessage('LocalAITab Chat: no file editor to insert into.');
    return;
  }
  await editor.edit((b) => {
    if (editor.selection.isEmpty) { b.insert(editor.selection.active, code); }
    else { b.replace(editor.selection, code); }
  });
  await vscode.window.showTextDocument(editor.document, editor.viewColumn);
}

async function copyToClipboard(code: string): Promise<void> {
  await vscode.env.clipboard.writeText(code);
  vscode.window.setStatusBarMessage('LocalAITab Chat: copied', 2000);
}

/** A string field of a webview message, empty when absent. */
function field(m: WebviewMessage, key: string): string {
  return String(m[key] ?? '');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The exit line of a command's output and its last two lines. */
function commandVerdict(result: string): string {
  const lines = result.split('\n');
  return [lines[0], ...lines.slice(-2)].join('\n');
}

/**
 * How an /attach argument that names no file becomes a search: a folder's
 * contents, a glob as typed, or a fragment of a file name.
 */
function attachGlob(arg: string, exact: vscode.Uri, type: vscode.FileType | undefined): vscode.GlobPattern {
  if (type === vscode.FileType.Directory) { return new vscode.RelativePattern(exact, '**/*'); }
  return /[*?{[]/.test(arg) ? arg : `**/*${arg}*`;
}

function workspaceFiles(): Thenable<vscode.Uri[]> {
  return vscode.workspace.findFiles('**/*', EXCLUDED, 2000);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) { out += chars[Math.floor(Math.random() * chars.length)]; }
  return out;
}

