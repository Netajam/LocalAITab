import * as vscode from 'vscode';
import { listModels, getCapabilities } from '../../core/llm/ollama';
import { ModelKind, modelKind, partitionForRole, suitsRole } from '../../core/llm/modelselect';

/**
 * LocalAITab: Select Model. Lists what Ollama has installed, sorted by whether
 * it suits the slot being filled, and writes the choice to the setting so
 * nobody has to know an exact tag or which kind of model goes where.
 */

const cfg = () => vscode.workspace.getConfiguration('localAITab');

export type ModelSlot = 'completion' | 'refactor' | 'chat';

interface SlotInfo {
  setting: 'model' | 'refactorModel' | 'chatModel';
  label: string;
  detail: string;
  needs: 'completion' | 'instruct';
}

const SLOTS: Record<ModelSlot, SlotInfo> = {
  completion: {
    setting: 'model',
    label: 'Completion',
    detail: 'Inline suggestions as you type or on Cmd+K A. Needs a base (FIM) model.',
    needs: 'completion',
  },
  refactor: {
    setting: 'refactorModel',
    label: 'Refactor, chat and agent',
    detail: 'Refactor Selection, Make This Better, chat, agent and search planning. Needs an instruct model.',
    needs: 'instruct',
  },
  chat: {
    setting: 'chatModel',
    label: 'Chat only',
    detail: 'Overrides the refactor model in the chat panel. Needs an instruct model.',
    needs: 'instruct',
  },
};

const KIND_LABEL: Record<ModelKind, string> = {
  base: 'base (FIM)',
  instruct: 'instruct',
  embedding: 'embedding',
};

const MISMATCH: Record<ModelKind, string> = {
  base: 'Base models complete text rather than follow instructions, so replies will not be what you asked for.',
  instruct: 'Instruct models tend to reply in prose instead of continuing the code at the cursor.',
  embedding: 'Embedding models produce vectors, not text, so every request will fail.',
};

type ModelItem = vscode.QuickPickItem & { action?: 'use' | 'inherit' | 'hint'; tag?: string; model?: ModelKind };

export async function selectModel(slot?: ModelSlot): Promise<void> {
  const endpoint = cfg().get<string>('endpoint', 'http://localhost:11434');

  let installed: string[];
  try {
    installed = await listModels(endpoint);
  } catch (err) {
    const choice = await vscode.window.showErrorMessage(
      `LocalAITab: could not reach Ollama at ${endpoint} (${(err as Error).message}). Is \`ollama serve\` running?`,
      'Change endpoint',
    );
    if (choice) { void vscode.commands.executeCommand('workbench.action.openSettings', 'localAITab.endpoint'); }
    return;
  }

  if (!installed.length) {
    void vscode.window.showWarningMessage(
      'LocalAITab: Ollama has no models installed. Pull one first, e.g. `ollama pull qwen2.5-coder:3b-base` ' +
      'for completion and `ollama pull qwen2.5-coder:7b-instruct` for refactor and chat.',
    );
    return;
  }

  const target = slot ?? await pickSlot();
  if (!target) { return; }
  const info = SLOTS[target];

  const models = await Promise.all(installed.map(async (tag) =>
    ({ tag, kind: modelKind(tag, await getCapabilities(endpoint, tag)) })));

  const picked = await vscode.window.showQuickPick(modelItems(target, models), {
    title: `LocalAITab: ${info.label} model`,
    placeHolder: info.detail,
    matchOnDescription: true,
  });
  if (!picked || picked.action === 'hint') { return; }

  if (picked.tag && picked.model && !suitsRole(info.needs, picked.model)) {
    const ok = await vscode.window.showWarningMessage(
      `"${picked.tag}" looks like ${picked.model === 'instruct' ? 'an' : 'a'} ${KIND_LABEL[picked.model]} model, ` +
      `and the ${info.label.toLowerCase()} slot needs ${info.needs === 'completion' ? 'a base' : 'an instruct'} model.`,
      { modal: true, detail: MISMATCH[picked.model] },
      'Use anyway',
    );
    if (!ok) { return; }
  }

  await save(info.setting, picked.tag ?? '');
  vscode.window.setStatusBarMessage(
    picked.tag
      ? `$(check) LocalAITab: ${info.label.toLowerCase()} model set to ${picked.tag}`
      : '$(check) LocalAITab: chat now uses the refactor model',
    4000,
  );
}

async function pickSlot(): Promise<ModelSlot | undefined> {
  const items = (Object.keys(SLOTS) as ModelSlot[]).map((slot) => {
    const info = SLOTS[slot];
    const current = cfg().get<string>(info.setting, '');
    return {
      slot,
      label: info.label,
      description: current || (slot === 'chat' ? 'same as refactor model' : 'not set'),
      detail: info.detail,
    };
  });
  const chosen = await vscode.window.showQuickPick(items, {
    title: 'LocalAITab: Select Model',
    placeHolder: 'Which model do you want to change?',
  });
  return chosen?.slot;
}

function modelItems(slot: ModelSlot, models: { tag: string; kind: ModelKind }[]): ModelItem[] {
  const info = SLOTS[slot];
  const current = cfg().get<string>(info.setting, '');
  const { suited, others } = partitionForRole(info.needs, models);

  const item = (m: { tag: string; kind: ModelKind }): ModelItem => ({
    label: m.tag === current ? `$(check) ${m.tag}` : m.tag,
    description: [KIND_LABEL[m.kind], m.tag === current ? 'current' : ''].filter(Boolean).join(' - '),
    action: 'use',
    tag: m.tag,
    model: m.kind,
  });

  const items: ModelItem[] = [];
  if (slot === 'chat') {
    const refactor = cfg().get<string>('refactorModel', '');
    items.push({
      action: 'inherit',
      label: current ? 'Same as refactor model' : '$(check) Same as refactor model',
      description: [refactor, current ? '' : 'current'].filter(Boolean).join(' - '),
    });
  }
  items.push(separator(`Suited to ${info.label.toLowerCase()}`));
  if (suited.length) {
    items.push(...suited.map(item));
  } else {
    items.push({
      action: 'hint',
      label: `$(info) None installed. Try: ollama pull ${info.needs === 'completion' ? 'qwen2.5-coder:3b-base' : 'qwen2.5-coder:7b-instruct'}`,
      alwaysShow: true,
    });
  }
  if (others.length) {
    items.push(separator('Other installed models'));
    items.push(...others.map(item));
  }
  return items;
}

const separator = (label: string): ModelItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

/** Writes where the value already lives, so a workspace override is not silently shadowing the change. */
async function save(setting: SlotInfo['setting'], value: string): Promise<void> {
  const inspected = cfg().inspect<string>(setting);
  const scope = inspected?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg().update(setting, value || undefined, scope);
}
