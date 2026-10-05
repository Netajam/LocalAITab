import * as vscode from 'vscode';
import { listModels, getCapabilities, generate } from '../../core/llm/ollama';
import { buildPrompt, postProcess, STOP_TOKENS } from '../../core/llm/fim';

/**
 * Health checks for the Ollama setup: a quiet one run on activation and
 * config changes, and the verbose self test behind LocalAITab: Diagnose.
 */

const cfg = () => vscode.workspace.getConfiguration('localAITab');

/**
 * Both model slots have a failure mode worth catching early: the completion
 * model must be a base model (instruct tags reply in prose), and the refactor
 * model must NOT be one (base models cannot follow an instruction).
 */
export async function verifyModels(output: vscode.OutputChannel): Promise<void> {
  const endpoint = cfg().get<string>('endpoint', 'http://localhost:11434');
  const completion = cfg().get<string>('model', '');
  const refactor = cfg().get<string>('refactorModel', '');

  let available: string[];
  try {
    available = await listModels(endpoint);
  } catch (err) {
    output.appendLine(`[warn] could not reach Ollama at ${endpoint}: ${(err as Error).message}`);
    return;
  }

  for (const [role, model] of [['completion', completion], ['refactor', refactor]] as const) {
    if (!model) { continue; }
    if (!available.includes(model)) {
      warnNotInstalled(output, role, model);
      continue;
    }
    if (wrongKind(role, model)) { output.appendLine(`[warn] ${ROLES[role].warning(model)}`); }
    output.appendLine(`[ok] ${role}: ${model}`);
  }
}

type Role = 'completion' | 'refactor';

/** Which kind of tag each model slot needs, and what to say when it has the other. */
const ROLES: Record<Role, { base: boolean; warning: (model: string) => string; hint: string }> = {
  completion: {
    base: true,
    warning: (model) =>
      `completion model "${model}" is not a -base tag. FIM autocomplete needs one ` +
      `(e.g. qwen2.5-coder:3b-base); instruct tags reply with prose instead of code.`,
    hint: 'should be a -base (FIM) model',
  },
  refactor: {
    base: false,
    warning: (model) =>
      `refactor model "${model}" is a -base tag. Refactoring needs an instruct model, ` +
      `because base models complete text rather than follow instructions.`,
    hint: 'should be an instruct model, not -base',
  },
};

const wrongKind = (role: Role, model: string): boolean => /-base\b/.test(model) !== ROLES[role].base;

function warnNotInstalled(output: vscode.OutputChannel, role: Role, model: string): void {
  const pull = `ollama pull ${model}`;
  output.appendLine(`[warn] ${role} model "${model}" is not installed. Run: ${pull}`);
  void vscode.window
    .showWarningMessage(`LocalAITab: ${role} model "${model}" is not installed.`, 'Choose installed model', 'Copy pull command')
    .then((c) => {
      if (c === 'Copy pull command') { void vscode.env.clipboard.writeText(pull); }
      if (c === 'Choose installed model') { void vscode.commands.executeCommand('localAITab.selectModel', role); }
    });
}

/**
 * End-to-end self test. Exercises the same code path a real completion takes,
 * so "nothing happens when I press the key" has a concrete answer instead of
 * requiring someone to reason about which of a dozen guards fired.
 */
export async function diagnose(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  state: { enabled: boolean; lastSkip: string | undefined },
): Promise<void> {
  output.show(true);
  const line = (s: string) => output.appendLine(s);
  const version = (context.extension.packageJSON as { version?: string }).version ?? '?';

  line(`\n========== LocalAITab diagnose (v${version}) ==========`);

  const endpoint = cfg().get<string>('endpoint', 'http://localhost:11434');
  const model = cfg().get<string>('model', '');
  const refactorModel = cfg().get<string>('refactorModel', '');

  reportSettings(line, state.enabled, endpoint, model, refactorModel);
  reportEditor(line);
  if (state.lastSkip) { line(`last skip reason   ${state.lastSkip}`); }

  let installed: string[] = [];
  try {
    installed = await listModels(endpoint);
    line(`\nollama             reachable, ${installed.length} models`);
  } catch (err) {
    line(`\nollama             UNREACHABLE: ${(err as Error).message}`);
    line('  -> is `ollama serve` running?');
    line('========== end ==========');
    return;
  }

  await reportModels(line, endpoint, installed, model, refactorModel);
  await liveCompletionTest(line, endpoint, model);

  line('========== end ==========');
}

type Line = (s: string) => void;

function reportSettings(line: Line, enabled: boolean, endpoint: string, model: string, refactorModel: string): void {
  line(`enabled            ${enabled}`);
  line(`trigger            ${cfg().get<string>('trigger', 'manual')}`);
  line(`endpoint           ${endpoint}`);
  line(`completion model   ${model}`);
  line(`refactor model     ${refactorModel}`);
  line(`timeoutMs          ${cfg().get<number>('timeoutMs', 10000)}`);
  line(`inlineSuggest      ${vscode.workspace.getConfiguration('editor').get('inlineSuggest.enabled', true)}`);
}

function reportEditor(line: Line): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    line('active editor      none');
    return;
  }
  const lang = editor.document.languageId;
  const off = cfg().get<string[]>('disabledLanguages', []).includes(lang);
  line(`active editor      ${vscode.workspace.asRelativePath(editor.document.uri)} [${lang}]${off ? '  <-- DISABLED for this language' : ''}`);
  line(`selection          ${editor.selection.isEmpty ? 'none (good for completion)' : 'active (blocks inline suggestions; needed for refactor)'}`);
}

async function reportModels(
  line: Line,
  endpoint: string,
  installed: string[],
  model: string,
  refactorModel: string,
): Promise<void> {
  for (const [role, m] of [['completion', model], ['refactor', refactorModel]] as const) {
    if (!installed.includes(m)) {
      line(`  ${role}: "${m}" NOT INSTALLED -> ollama pull ${m}`);
      continue;
    }
    const caps = await getCapabilities(endpoint, m);
    const wrong = wrongKind(role, m) ? `  <-- ${ROLES[role].hint}` : '';
    line(`  ${role}: ${m} [${caps.join(', ') || 'no capabilities reported'}]${wrong}`);
  }
}

/** The real thing: a FIM round trip through the same helpers the provider uses. */
async function liveCompletionTest(line: Line, endpoint: string, model: string): Promise<void> {
  line('\nlive completion test...');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const prompt = buildPrompt({
      prefix: 'def add(a, b):\n    """Return the sum of a and b."""\n',
      suffix: '\n\nprint(add(1, 2))\n',
      filePath: 'diagnose.py',
    });
    const res = await generate({
      endpoint,
      model,
      prompt,
      temperature: 0.1,
      maxTokens: 64,
      keepAlive: cfg().get<string>('keepAlive', '30m'),
      stop: STOP_TOKENS,
      signal: ac.signal,
    });
    const text = postProcess(res.text, { suffix: '\n\nprint(add(1, 2))\n', multiline: true });
    line(`  ${res.totalMs}ms, ${res.evalCount} tokens`);
    line(`  raw   ${JSON.stringify(res.text.slice(0, 160))}`);
    line(`  clean ${JSON.stringify(text.slice(0, 160))}`);
    line(text ? '  RESULT: working end to end.' : '  RESULT: model replied but nothing survived post-processing.');
  } catch (err) {
    line(`  FAILED: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
