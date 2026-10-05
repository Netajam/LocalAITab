import * as vscode from 'vscode';
import { listModels } from '../../core/llm/ollama';
import { chooseFallback } from '../../core/llm/modelselect';

/**
 * Substitutes the user has approved this session, keyed by "endpoint|requested".
 * Once someone accepts a fallback for a missing model, later requests in the
 * same window reuse it silently instead of prompting on every message.
 */
const approved = new Map<string, string>();

/**
 * Guards a request that needs an instruct model. When the configured model is
 * installed it is returned unchanged. When it is missing, the user is shown a
 * blocking choice -- pull the configured model, or run with the best installed
 * substitute -- and nothing runs against a model that is not there.
 *
 * Returns the model to use, or undefined when the user declined (caller aborts).
 */
export async function ensureInstructModel(
  endpoint: string,
  requested: string,
  output: vscode.OutputChannel,
): Promise<string | undefined> {
  let installed: string[];
  try {
    installed = await listModels(endpoint);
  } catch (err) {
    // Cannot verify -- let the request through so the real connection error,
    // not a guess about missing models, is what surfaces to the user.
    output.appendLine(`[models] could not list installed models: ${(err as Error).message}`);
    return requested;
  }

  if (installed.includes(requested)) { return requested; }

  const key = `${endpoint}|${requested}`;
  const remembered = approved.get(key);
  if (remembered && installed.includes(remembered)) { return remembered; }

  const cfg = vscode.workspace.getConfiguration('localAITab');
  const preferred = cfg.get<string[]>('refactorModelFallbacks', []);
  const fallback = chooseFallback(installed, preferred);
  const pull = `ollama pull ${requested}`;

  output.appendLine(
    `[models] instruct model "${requested}" is not installed; ` +
    (fallback ? `fallback available: ${fallback}` : 'no instruct fallback is installed'),
  );

  const useLabel = fallback ? `Use ${fallback}` : undefined;
  const actions = useLabel ? [useLabel, 'Copy pull command'] : ['Copy pull command'];
  const detail = fallback
    ? `Install it with "${pull}", or run this request with the installed model "${fallback}" instead.`
    : `Install it with "${pull}". No other instruct-capable model is installed to fall back to.`;

  const choice = await vscode.window.showWarningMessage(
    `LocalAITab: the instruct model "${requested}" is not installed.`,
    { modal: true, detail },
    ...actions,
  );

  if (useLabel && choice === useLabel && fallback) {
    approved.set(key, fallback);
    output.appendLine(`[models] using "${fallback}" in place of "${requested}" for this session`);
    return fallback;
  }
  if (choice === 'Copy pull command') {
    await vscode.env.clipboard.writeText(pull);
    void vscode.window.showInformationMessage(`LocalAITab: copied "${pull}" to the clipboard.`);
  }
  return undefined;
}
