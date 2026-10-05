import * as vscode from 'vscode';
import { ConversationHost, Settings, StagedChange } from '../../../core/harness/conversation';

/**
 * The editor's side of a conversation: what it reads and writes goes through
 * the editor's documents, what needs the user's say goes through its dialogs,
 * and its settings are the localAITab.* ones.
 */

export function editorHost(log: ConversationHost['log'], model: () => string): ConversationHost {
  return { workspace: editorWorkspace, approve: approveInModal, log, settings: () => editorSettings(model()) };
}

function editorSettings(model: string): Settings {
  const cfg = vscode.workspace.getConfiguration('localAITab');
  return {
    endpoint: cfg.get<string>('endpoint', 'http://localhost:11434'),
    model,
    keepAlive: cfg.get<string>('keepAlive', '30m'),
    chatMaxTokens: cfg.get<number>('chatMaxTokens', 2048),
    chatTemperature: cfg.get<number>('chatTemperature', 0.3),
    chatHistoryTurns: cfg.get<number>('chatHistoryTurns', 8),
    agentMaxSteps: cfg.get<number>('agentMaxSteps', 8),
    agentTemperature: cfg.get<number>('agentTemperature', 0.2),
    agentMaxReadChars: cfg.get<number>('agentMaxReadChars', 12000),
    agentMaxSearchLines: cfg.get<number>('agentMaxSearchLines', 25),
    operatorMaxSteps: cfg.get<number>('operatorMaxSteps', 30),
    operatorTemperature: cfg.get<number>('operatorTemperature', 0.2),
    operatorMaxOutputChars: cfg.get<number>('operatorMaxOutputChars', 8000),
    operatorCommandTimeout: cfg.get<number>('operatorCommandTimeout', 120),
  };
}

/**
 * Reads see unsaved edits, and writes land through the open document when
 * there is one, so the editor and its undo stack stay in step with the disk.
 */
const editorWorkspace: ConversationHost['workspace'] = {
  async read(file) {
    return (await vscode.workspace.openTextDocument(vscode.Uri.file(file))).getText();
  },

  async replace(file, at, length, text) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(at), doc.positionAt(at + length)), text);
    if (!(await vscode.workspace.applyEdit(edit))) { throw new Error('the editor refused the edit.'); }
    await doc.save();
  },

  async write(file, content) {
    const uri = vscode.Uri.file(file);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (!open) {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
      return;
    }
    await editorWorkspace.replace(file, 0, open.getText().length, content);
  },
};

const approveInModal: ConversationHost['approve'] = async (command, cwd) => {
  const RUN = 'Run';
  const ALL = 'Run all for this request';
  const pick = await vscode.window.showWarningMessage(
    'LocalAITab Operator wants to run a command',
    { modal: true, detail: `${command}\n\nin ${cwd}` },
    RUN, ALL,
  );
  return pick === ALL ? 'all' : pick === RUN ? 'once' : undefined;
};

/** A staged edit as the review diff wants it: a range in an open document. */
export async function reviewTarget(staged: StagedChange) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(staged.file));
  return {
    uri: doc.uri,
    range: new vscode.Range(doc.positionAt(staged.at), doc.positionAt(staged.at + staged.before.length)),
    languageId: doc.languageId,
  };
}
