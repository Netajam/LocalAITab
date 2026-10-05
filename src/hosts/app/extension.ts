import * as vscode from 'vscode';
import { LocalCompletionProvider } from './completion/provider';
import {
  PreviewProvider, PREVIEW_SCHEME, runRefactor, runImprove, setPreviewProvider,
  applyPending, discardPending, watchForPreviewClose, stageExternalEdit,
} from './refactor/refactor';
import { ChatPanel, scaffoldSkill } from './chat/chat';
import { pins, describePin } from './chat/context';
import { diagnose, verifyModels } from './diagnose';
import { selectModel, ModelSlot } from './selectmodel';

let enabled = true;
let statusBar: vscode.StatusBarItem;
let chatBar: vscode.StatusBarItem;
let busyTimer: NodeJS.Timeout | undefined;

const cfg = () => vscode.workspace.getConfiguration('localAITab');

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('LocalAITab');
  enabled = cfg().get<boolean>('enabled', true);

  context.subscriptions.push(...createStatusBars(), output);
  render();

  const provider = new LocalCompletionProvider(output, () => enabled, () => flashBusy());

  const preview = new PreviewProvider();
  setPreviewProvider(preview);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    ...completionCommands(context, output, provider),
    ...chatCommands(context, output),
    ...refactorCommands(output, preview),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('localAITab')) { return; }
      provider.invalidate();
      if (e.affectsConfiguration('localAITab.enabled')) {
        enabled = cfg().get<boolean>('enabled', true);
      }
      render();
      void verifyModels(output);
    }),
  );

  void verifyModels(output);
}

function createStatusBars(): vscode.Disposable[] {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'localAITab.toggle';

  // A visible entry point for chat: the command palette and a chord are not
  // discoverable for something you reach for many times a day.
  chatBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  chatBar.command = 'localAITab.chat';
  chatBar.text = '$(comment-discussion) LocalAITab Chat';
  chatBar.tooltip = 'Open LocalAITab Chat (Cmd+K Q)';
  chatBar.show();

  return [statusBar, chatBar];
}

function completionCommands(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  provider: LocalCompletionProvider,
): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('localAITab.triggerOnce', () => triggerOnce(output, provider)),

    vscode.commands.registerCommand('localAITab.diagnose', () =>
      diagnose(context, output, { enabled, lastSkip: provider.lastSkip })),

    vscode.commands.registerCommand('localAITab.toggle', () => {
      enabled = !enabled;
      render();
      vscode.window.setStatusBarMessage(`LocalAITab ${enabled ? 'enabled' : 'disabled'}`, 2000);
    }),

    vscode.commands.registerCommand('localAITab.toggleTriggerMode', async () => {
      const next = cfg().get<string>('trigger', 'manual') === 'manual' ? 'automatic' : 'manual';
      await cfg().update('trigger', next, vscode.ConfigurationTarget.Global);
      render();
      vscode.window.setStatusBarMessage(`LocalAITab: ${next} suggestions`, 2000);
    }),

    vscode.commands.registerCommand('localAITab.showStats', () => showStats(output, provider)),

    vscode.commands.registerCommand('localAITab.selectModel', (slot?: ModelSlot) => selectModel(slot)),
  ];
}

/** Pins the active editor's selections and tells the chat panel, if it is open. */
function pinSelection(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selections.every((s) => s.isEmpty)) {
    void vscode.window.showInformationMessage('LocalAITab: select some lines to pin first.');
    return;
  }
  const added = pins.add(editor);
  vscode.window.setStatusBarMessage(
    added.length
      ? `$(pinned) Pinned ${added.map(describePin).join(', ')} for LocalAITab Chat (${pins.all().length} pinned)`
      : 'Already pinned',
    4000,
  );
  ChatPanel.send({ type: 'pinned', added });
}

function chatCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel): vscode.Disposable[] {
  const show = () => ChatPanel.show(context, output, stageExternalEdit);
  const showAndSend = (message: { type: string; [k: string]: unknown }) => {
    show();
    ChatPanel.send(message);
  };

  return [
    vscode.commands.registerCommand('localAITab.chat', show),

    vscode.commands.registerCommand('localAITab.chatNewSession', () => showAndSend({ type: 'newSession' })),

    // From the explorer (one or several files) or an editor tab; the palette
    // passes no uri and falls back to the active file.
    vscode.commands.registerCommand('localAITab.chatAttach', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const targets = uris?.length ? uris : uri ? [uri] : [];
      const active = vscode.window.activeTextEditor?.document.uri;
      if (!targets.length && active?.scheme === 'file') { targets.push(active); }
      showAndSend(targets.length ? { type: 'attach', uris: targets } : { type: 'attach', arg: '' });
    }),

    // Keeps the selection as chat context after the editor moves on to
    // another one. Does not open the panel: pinning is usually one of several.
    vscode.commands.registerCommand('localAITab.chatPinSelection', pinSelection),

    vscode.commands.registerCommand('localAITab.chatHistory', () => showAndSend({ type: 'pickSession' })),

    vscode.commands.registerCommand('localAITab.newSkill', () => scaffoldSkill()),
  ];
}

function refactorCommands(output: vscode.OutputChannel, preview: PreviewProvider): vscode.Disposable[] {
  return [
    preview,
    vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, preview),

    vscode.commands.registerCommand('localAITab.refactor', () => runRefactor(output, preview)),

    vscode.commands.registerCommand('localAITab.improve', () => runImprove(output, preview)),

    vscode.commands.registerCommand('localAITab.refactorWithContext', () =>
      runRefactor(output, preview, { chooseScope: true })),
    vscode.commands.registerCommand('localAITab.applyRefactor', () => applyPending(output)),
    vscode.commands.registerCommand('localAITab.discardRefactor', () => discardPending()),
    watchForPreviewClose(),
  ];
}

/** Why an inline suggestion could not show in this editor, or undefined if it can. */
function completionBlocker(editor: vscode.TextEditor | undefined): string | undefined {
  if (!editor) { return 'no active editor to complete in.'; }

  const lang = editor.document.languageId;
  if (cfg().get<string[]>('disabledLanguages', []).includes(lang)) {
    return `completions are disabled for "${lang}" (see localAITab.disabledLanguages).`;
  }

  // VS Code will not render an inline suggestion while a selection is
  // active, so the trigger would otherwise appear to do nothing at all.
  if (!editor.selection.isEmpty) {
    return 'clear the selection first -- inline suggestions cannot render over selected text.';
  }

  if (!vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true)) {
    return 'editor.inlineSuggest.enabled is off, so no inline suggestion can be shown.';
  }
  return undefined;
}

async function triggerOnce(output: vscode.OutputChannel, provider: LocalCompletionProvider): Promise<void> {
  if (!enabled) {
    enabled = true;
    render();
  }

  const blocker = completionBlocker(vscode.window.activeTextEditor);
  if (blocker) {
    vscode.window.showWarningMessage(`LocalAITab: ${blocker}`);
    return;
  }

  const servedBefore = provider.stats.served;
  provider.lastSkip = undefined;
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

  // Give the request a chance to finish, then explain a silent no-result.
  await new Promise((r) => setTimeout(r, cfg().get<number>('timeoutMs', 10000) + 500));
  if (provider.stats.served === servedBefore && provider.lastSkip) {
    const choice = await vscode.window.showWarningMessage(
      `LocalAITab: no suggestion -- ${provider.lastSkip}`,
      'Show log',
    );
    if (choice) { output.show(true); }
  }
}

function showStats(output: vscode.OutputChannel, provider: LocalCompletionProvider): void {
  const s = provider.stats;
  output.show(true);
  output.appendLine(
    `\n--- stats ---\n` +
    `requests   ${s.requests}\n` +
    `served     ${s.served}\n` +
    `cache hits ${s.cacheHits}\n` +
    `aborted    ${s.aborted}\n` +
    `errors     ${s.errors}\n` +
    `last       ${s.lastMs}ms / ${s.lastTokens} tokens\n`,
  );
}

export function deactivate(): void {
  if (busyTimer) { clearTimeout(busyTimer); }
}

function render(busy = false): void {
  const manual = cfg().get<string>('trigger', 'manual') === 'manual';

  if (!enabled) {
    statusBar.text = '$(circle-slash) LocalAITab';
    statusBar.tooltip = 'LocalAITab is off. Click to enable.';
  } else if (busy) {
    statusBar.text = '$(loading~spin) LocalAITab';
    statusBar.tooltip = 'LocalAITab is thinking...';
  } else if (manual) {
    statusBar.text = '$(sparkle) LocalAITab';
    statusBar.tooltip =
      'LocalAITab: on demand.\nCmd+K A to suggest here.\nCmd+K R to refactor a selection.\nClick to disable.';
  } else {
    statusBar.text = '$(sparkle) LocalAITab auto';
    statusBar.tooltip = 'LocalAITab: suggesting as you type. Click to disable.';
  }
  statusBar.show();
}

function flashBusy(): void {
  render(true);
  if (busyTimer) { clearTimeout(busyTimer); }
  busyTimer = setTimeout(() => render(false), 500);
}
